// Titration MCP — extraction ritual v2: propose-core unit test (no network, no DB, no model).
// Pins the PURE validation the I/O layer routes on: allowed-type enforcement (the four non-verdict
// types only), FINDING/REGRESSION rejection + count, METHOD => requires_confirmation, high-stakes
// edge flagging, predicate/confidence/tag/dup normalization, the structural-failure throws, and the
// prompt builder. card-propose.ts snapshots these specs verbatim. Mirrors harness-validate.test.
// Run: npx tsx lib/__tests__/propose-core.test.ts

import {
  assembleProposal,
  buildProposeUserPrompt,
  PROPOSABLE_TYPES,
  type CardProposal,
} from "../propose-core";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail = "") {
  total++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}
function throws(fn: () => unknown): string | null {
  try { fn(); return null; } catch (e: any) { return String(e?.message ?? e); }
}

// ── factories ───────────────────────────────────────────────────────────────────
function card(over: any = {}): any {
  return { type: "METHOD", title: "A reusable method", body: "Evidence and application.", confidence: "high", tags: ["x"], duplicate_of: null, rationale: "clears the gate", suggested_edges: [], ...over };
}
function resp(proposals: any[], summary = "ok"): any {
  return { summary, proposals };
}

// ── structural failures throw (a malformed call must fail loudly, not propose silently) ──
check("non-object throws", throws(() => assembleProposal("nope")) !== null);
check("null throws", throws(() => assembleProposal(null)) !== null);
check("missing proposals field throws", throws(() => assembleProposal({ summary: "x" })) !== null);
check("proposals present (even empty) does not throw", throws(() => assembleProposal(resp([]))) === null);

// ── empty proposal set ─────────────────────────────────────────────────────────
const empty = assembleProposal(resp([], ""));
check("empty: advisory flag", empty.advisory === true);
check("empty: zero proposals", empty.proposals.length === 0);
check("empty: note present", typeof empty.note === "string" && empty.note.length > 0);
check("empty: summary fallback when model omits it", /cleared the worthiness gate|Nothing/i.test(empty.summary));

// ── allowed types + stakes ──────────────────────────────────────────────────────
const four = assembleProposal(resp([
  card({ type: "METHOD" }),
  card({ type: "MODEL_PROFILE" }),
  card({ type: "PROMPT_BEHAVIOR" }),
  card({ type: "DATASET_NOTE" }),
]));
check("all four non-verdict types accepted", four.proposals.length === 4);
check("METHOD => requires_confirmation true", four.proposals.find((p) => p.type === "METHOD")!.requires_confirmation === true);
check("DATASET_NOTE => requires_confirmation false", four.proposals.find((p) => p.type === "DATASET_NOTE")!.requires_confirmation === false);
check("MODEL_PROFILE => requires_confirmation false", four.proposals.find((p) => p.type === "MODEL_PROFILE")!.requires_confirmation === false);

// ── verdict types rejected + counted ────────────────────────────────────────────
const withVerdict = assembleProposal(resp([
  card({ type: "FINDING", title: "should be dropped" }),
  card({ type: "REGRESSION", title: "should be dropped" }),
  card({ type: "METHOD", title: "kept" }),
]));
check("FINDING/REGRESSION dropped", withVerdict.proposals.length === 1);
check("skipped_verdict_types counts the two", withVerdict.skipped_verdict_types === 2);
check("the surviving proposal is the METHOD", withVerdict.proposals[0].title === "kept");

// ── type normalization + invalid drop ───────────────────────────────────────────
const hyphen = assembleProposal(resp([card({ type: "PROMPT-BEHAVIOR" })]));
check("hyphenated type normalizes to PROMPT_BEHAVIOR", hyphen.proposals[0]?.type === "PROMPT_BEHAVIOR");
const lower = assembleProposal(resp([card({ type: "method" })]));
check("lowercase type normalizes to METHOD", lower.proposals[0]?.type === "METHOD");
const bad = assembleProposal(resp([card({ type: "NONSENSE" })]));
check("invalid type dropped (not verdict, not allowed)", bad.proposals.length === 0 && bad.skipped_verdict_types === 0);

// ── required-field drops ────────────────────────────────────────────────────────
check("missing title dropped", assembleProposal(resp([card({ title: "" })])).proposals.length === 0);
check("missing body dropped", assembleProposal(resp([card({ body: "  " })])).proposals.length === 0);

// ── confidence + tags normalization ─────────────────────────────────────────────
check("invalid confidence => medium", assembleProposal(resp([card({ confidence: "bogus" })])).proposals[0].confidence === "medium");
check("valid confidence preserved", assembleProposal(resp([card({ confidence: "critical" })])).proposals[0].confidence === "critical");
const canonicalDraft = assembleProposal(resp([card({
  sample_size: "n=12",
  reproducibility: "high",
  origin_ref: "RUN-123",
})])).proposals[0];
check("proposal body normalized to the type-specific contract", canonicalDraft.body.includes("## Summary") && canonicalDraft.body.includes("## Method") && canonicalDraft.body.includes("## Evidence") && canonicalDraft.body.includes("## Application"));
check("proposal carries ordered structured sections", canonicalDraft.sections.map((section) => section.label).join("|") === "Summary|Method|Evidence|Application");
check("proposal carries evidence metadata", canonicalDraft.sample_size === "n=12" && canonicalDraft.reproducibility === "high");
check("proposal carries origin provenance", canonicalDraft.origin_ref === "RUN-123");
check(
  "authoritative run provenance overrides model-authored origin",
  assembleProposal(resp([card({ origin_ref: "RUN-HALLUCINATED" })]), "RUN-AUTHORITATIVE").proposals[0].origin_ref === "RUN-AUTHORITATIVE",
);
check("non-array tags => []", assembleProposal(resp([card({ tags: "x" })])).proposals[0].tags.length === 0);
check("tags filter empties", JSON.stringify(assembleProposal(resp([card({ tags: ["a", "", "  ", "b"] })])).proposals[0].tags) === JSON.stringify(["a", "b"]));

// ── duplicate_of normalization ──────────────────────────────────────────────────
check('duplicate_of "null" string => null', assembleProposal(resp([card({ duplicate_of: "null" })])).proposals[0].duplicate_of === null);
check("duplicate_of real ref kept", assembleProposal(resp([card({ duplicate_of: "T-MET-001" })])).proposals[0].duplicate_of === "T-MET-001");

// ── edges: predicate validity + high-stakes flagging ────────────────────────────
const edged = assembleProposal(resp([card({ suggested_edges: [
  { predicate: "supports", to: "T-MET-002" },
  { predicate: "contradicts", to: "T-MET-003" },
  { predicate: "observed_in", to: "RUN-2026-06-19_x" },
  { predicate: "bogus_pred", to: "T-MET-004" },
  { predicate: "supersedes", to: "" },
] })]));
const e = edged.proposals[0].suggested_edges;
check("invalid predicate dropped", !e.some((x) => x.predicate === "bogus_pred"));
check("empty target dropped", !e.some((x) => x.predicate === "supersedes"));
check("valid edges kept (supports/contradicts/observed_in)", e.length === 3);
check("contradicts => high_stakes true", e.find((x) => x.predicate === "contradicts")!.high_stakes === true);
check("supports => high_stakes false", e.find((x) => x.predicate === "supports")!.high_stakes === false);
check("predicate lowercased", assembleProposal(resp([card({ suggested_edges: [{ predicate: "SUPPORTS", to: "T-MET-9" }] })])).proposals[0].suggested_edges[0].predicate === "supports");

// ── summary fallback when proposals exist ───────────────────────────────────────
check("summary fallback counts proposals", /candidate card/i.test(assembleProposal(resp([card()], "")).summary));

// ── prompt builder ──────────────────────────────────────────────────────────────
const up = buildProposeUserPrompt("ran the harness, X happened", "T-MET-001 [METHOD] foo", "RUN-2026-06-19_y");
check("prompt includes run summary", up.includes("ran the harness, X happened"));
check("prompt includes existing cards", up.includes("T-MET-001 [METHOD] foo"));
check("prompt includes run ref", up.includes("RUN-2026-06-19_y"));
const upNone = buildProposeUserPrompt("summary", "", null);
check("prompt: (none supplied) when no existing cards", upNone.includes("(none supplied)"));
check("prompt: omit observed_in when no run ref", upNone.includes("(none — omit observed_in)"));

// ── type set sanity ─────────────────────────────────────────────────────────────
check("exactly four proposable types", PROPOSABLE_TYPES.length === 4);
check("no verdict types in the proposable set", !(PROPOSABLE_TYPES as readonly string[]).includes("FINDING") && !(PROPOSABLE_TYPES as readonly string[]).includes("REGRESSION"));

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${total - failures}/${total}`);
process.exit(failures === 0 ? 0 : 1);
