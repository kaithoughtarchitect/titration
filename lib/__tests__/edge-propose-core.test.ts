// Titration MCP — graph edge-propose-core unit test (no network, no DB, no model).
// Pins the PURE validation: predicate vocabulary (conservative + high-stakes, provenance excluded),
// targets restricted to supplied candidates (no hallucinated refs), no self-edge, dedup vs existing
// edges + within the set, high-stakes flagging, summary fallback, structural throws, prompt builder.
// edge-propose.ts snapshots these verbatim. Run: npx tsx lib/__tests__/edge-propose-core.test.ts

import { assembleEdgeProposal, buildEdgeProposeUserPrompt, type AssembleEdgeOpts } from "../edge-propose-core";

let failures = 0, total = 0;
function check(name: string, cond: boolean, detail = "") {
  total++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}
function throws(fn: () => unknown): string | null {
  try { fn(); return null; } catch (e: any) { return String(e?.message ?? e); }
}

const OPTS: AssembleEdgeOpts = { fromRef: "T-MET-001", candidateRefs: ["T-MET-002", "T-MET-003", "T-MET-004"], existingEdges: [] };
function edge(over: any = {}): any { return { predicate: "supports", to: "T-MET-002", rationale: "because", ...over }; }
function resp(edges: any[], summary = "ok"): any { return { summary, proposals: edges }; }

// ── structural throws ──────────────────────────────────────────────────────────
check("non-object throws", throws(() => assembleEdgeProposal("x", OPTS)) !== null);
check("missing proposals field throws", throws(() => assembleEdgeProposal({ summary: "y" }, OPTS)) !== null);
check("empty proposals does not throw", throws(() => assembleEdgeProposal(resp([]), OPTS)) === null);

// ── empty ────────────────────────────────────────────────────────────────────
const empty = assembleEdgeProposal(resp([], ""), OPTS);
check("empty: advisory + from set", empty.advisory === true && empty.from === "T-MET-001");
check("empty: zero proposals + note", empty.proposals.length === 0 && empty.note.length > 0);
check("empty: summary fallback", /No defensible/i.test(empty.summary));

// ── candidate restriction + self-edge + predicate validity ─────────────────────
check("edge to a candidate kept", assembleEdgeProposal(resp([edge({ to: "T-MET-003" })]), OPTS).proposals.length === 1);
check("edge to a NON-candidate dropped (no hallucinated refs)", assembleEdgeProposal(resp([edge({ to: "T-MET-999" })]), OPTS).proposals.length === 0);
check("self-edge dropped", assembleEdgeProposal(resp([edge({ to: "T-MET-001" })]), OPTS).proposals.length === 0);
check("invalid predicate dropped", assembleEdgeProposal(resp([edge({ predicate: "bogus" })]), OPTS).proposals.length === 0);
check("provenance predicate observed_in dropped (not proposable)", assembleEdgeProposal(resp([edge({ predicate: "observed_in" })]), OPTS).proposals.length === 0);
check("predicate lowercased", assembleEdgeProposal(resp([edge({ predicate: "SUPPORTS" })]), OPTS).proposals[0]?.predicate === "supports");

// ── high-stakes flagging ───────────────────────────────────────────────────────
check("contradicts => high_stakes true", assembleEdgeProposal(resp([edge({ predicate: "contradicts", to: "T-MET-003" })]), OPTS).proposals[0].high_stakes === true);
check("supersedes => high_stakes true", assembleEdgeProposal(resp([edge({ predicate: "supersedes", to: "T-MET-003" })]), OPTS).proposals[0].high_stakes === true);
check("supports => high_stakes false", assembleEdgeProposal(resp([edge({ predicate: "supports" })]), OPTS).proposals[0].high_stakes === false);

// ── dedup ──────────────────────────────────────────────────────────────────────
const existingOpts: AssembleEdgeOpts = { ...OPTS, existingEdges: ["supports -> T-MET-002"] };
check("existing edge dropped (dedup vs source's edges)", assembleEdgeProposal(resp([edge({ predicate: "supports", to: "T-MET-002" })]), existingOpts).proposals.length === 0);
check("non-existing edge to same target kept", assembleEdgeProposal(resp([edge({ predicate: "extends", to: "T-MET-002" })]), existingOpts).proposals.length === 1);
check("duplicate within the set collapses to one", assembleEdgeProposal(resp([edge({ to: "T-MET-002" }), edge({ to: "T-MET-002" })]), OPTS).proposals.length === 1);

// ── summary fallback when proposals exist ───────────────────────────────────────
check("summary fallback counts edges", /edge/i.test(assembleEdgeProposal(resp([edge()], ""), OPTS).summary));

// ── prompt builder ──────────────────────────────────────────────────────────────
const up = buildEdgeProposeUserPrompt("SRC body", "T-MET-002 [METHOD] foo", "supports -> T-MET-009");
check("prompt includes source", up.includes("SRC body"));
check("prompt includes candidates", up.includes("T-MET-002 [METHOD] foo"));
check("prompt includes existing edges", up.includes("supports -> T-MET-009"));
const upNone = buildEdgeProposeUserPrompt("s", "", "");
check("prompt: (none) for empty candidates + edges", (upNone.match(/\(none\)/g) || []).length >= 2);

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${total - failures}/${total}`);
process.exit(failures === 0 ? 0 : 1);
