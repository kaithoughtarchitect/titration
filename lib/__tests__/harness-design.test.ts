// Titration MCP — harness-design-core unit test (no network, no DB, no model).
// Pins the PURE design-package assembly the I/O layer routes on: the load-bearing
// invariant gates (semantic ⇒ judge required, ship-gate ⇒ quantified threshold,
// manifest === 5 canonical files, ≥1 ship-gate), authority-class normalization,
// the quantified-threshold proxy, and the precedent-grounded prompt builder. The
// harness-design.ts I/O call snapshots these specs verbatim, so this is the offline
// contract. Mirrors flywheel.test / goal-titrate.test.
// Run: npx tsx lib/__tests__/harness-design.test.ts

import {
  assembleDesignPackage,
  looksQuantified,
  buildDesignUserPrompt,
  buildRepairPrompt,
  CHANGE_TYPES,
  CANONICAL_FILES,
  DESIGN_SYSTEM,
  type PrecedentCard,
  type DesignRequest,
} from "../harness-design-core";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}
function throws(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e: any) {
    return String(e?.message ?? e);
  }
}

// ── factories ───────────────────────────────────────────────────────────────────
function mkManifest(): any[] {
  return CANONICAL_FILES.map((file) => ({ file, must_contain: [`do the ${file} thing`] }));
}
function mkRaw(over: Partial<any> = {}): any {
  return {
    readme_markdown:
      "# PROPOSED — harness for X\n\nGoal: prove the edit reduces narration leakage without regressing voice.\n\n## What this harness will NOT catch\n- latency, token cost, UI rendering.",
    labels: [
      { name: "LABEL_leak", type: "Y/N", authority_class: "semantic", ship_gate: true, definition: "Does the reply leak narration? Pos: '*she narrates*'. Neg: clean dialogue." , decision_threshold: "rate drops ≥40%" },
      { name: "LABEL_tag_closed", type: "Y/N", authority_class: "structural", ship_gate: false, definition: "Is every #BREAK# tag well-formed? Pos: closed. Neg: orphan." , decision_threshold: null },
    ],
    manifest: mkManifest(),
    thresholds: [{ label: "LABEL_leak", target: "rate drops ≥40%", rationale: "moderate effect size; prior harness H3 saw 45%." }],
    predicted_outcomes: [{ label: "LABEL_leak", hypothesis: "leak rate 60% → ≤30%." }],
    precedent_applied: [{ card_ref: "T-MET-001", why: "applies — same diagnose-don't-prescribe judge shape." }],
    ...over,
  };
}

// ── happy path + normalization ───────────────────────────────────────────────────
const ok = assembleDesignPackage(mkRaw());
check("valid package assembles", !!ok && ok.labels.length === 2);
check("status is forced to PROPOSED", ok.status === "PROPOSED");
check("semantic label derives judge_required=true", ok.labels[0].judge_required === true);
check("structural label judge_required=false", ok.labels[1].judge_required === false);
check("manifest carries all 5 canonical files", ok.manifest.length === 5 && CANONICAL_FILES.every((f) => ok.manifest.some((m) => m.file === f)));
check("structured fields pass through", ok.thresholds.length === 1 && ok.predicted_outcomes.length === 1 && ok.precedent_applied.length === 1);

// authority-class normalization (underscore/space/case + compliance alias)
const normd = assembleDesignPackage(
  mkRaw({
    labels: [
      { name: "L1", type: "Y/N", authority_class: "Compliance_Literal", ship_gate: true, definition: "d", decision_threshold: "≥3" },
      { name: "L2", type: "Y/N", authority_class: " SEMANTIC ", ship_gate: false, definition: "d", decision_threshold: null },
    ],
  }),
);
check("authority_class normalizes (compliance_literal → compliance-literal)", normd.labels[0].authority_class === "compliance-literal");
check("authority_class normalizes (' SEMANTIC ' → semantic)", normd.labels[1].authority_class === "semantic");

// ── invariant gates (each must throw) ─────────────────────────────────────────────
check(
  "semantic label declared judge_required=false → throws (regex-alone-on-semantic)",
  !!throws(() =>
    assembleDesignPackage(
      mkRaw({ labels: [{ name: "L", type: "Y/N", authority_class: "semantic", ship_gate: true, judge_required: false, definition: "d", decision_threshold: "≥1" }] }),
    ),
  ),
);
check(
  "ship-gate label without quantified threshold → throws",
  (throws(() =>
    assembleDesignPackage(
      mkRaw({ labels: [{ name: "L", type: "Y/N", authority_class: "semantic", ship_gate: true, definition: "d", decision_threshold: "improves significantly" }] }),
    ),
  ) ?? "").includes("quantified"),
);
check(
  "no ship-gate label → throws",
  (throws(() =>
    assembleDesignPackage(mkRaw({ labels: [{ name: "L", type: "Y/N", authority_class: "structural", ship_gate: false, definition: "d", decision_threshold: null }] })),
  ) ?? "").includes("ship_gate"),
);
check(
  "manifest != 5 files → throws",
  (throws(() => assembleDesignPackage(mkRaw({ manifest: mkManifest().slice(0, 4) }))) ?? "").includes("exactly 5"),
);
const badFiles = mkManifest();
badFiles[0].file = "wrong-file.ts";
check("manifest missing a canonical file → throws", !!throws(() => assembleDesignPackage(mkRaw({ manifest: badFiles }))));
check(
  "manifest file with empty must_contain → throws",
  !!throws(() => {
    const bad = mkManifest();
    bad[2].must_contain = [];
    return assembleDesignPackage(mkRaw({ manifest: bad }));
  }),
);
// must_contain that is blank/whitespace/[null] carries no real contract → must collapse to empty → throws
const nullContract = mkManifest();
nullContract[1].must_contain = [null];
check("manifest must_contain [null] → throws (no real contract)", !!throws(() => assembleDesignPackage(mkRaw({ manifest: nullContract }))));
const wsContract = mkManifest();
wsContract[3].must_contain = ["   ", ""];
check("manifest must_contain whitespace/empty strings → throws", !!throws(() => assembleDesignPackage(mkRaw({ manifest: wsContract }))));
// a genuine contract with a stray blank element survives (blank filtered, real one kept)
const mixedContract = mkManifest();
mixedContract[0].must_contain = ["", "drive the pipeline entry point directly"];
check("manifest must_contain keeps real entries after filtering blanks", assembleDesignPackage(mkRaw({ manifest: mixedContract })).manifest[0].must_contain.length === 1);
// a duplicate canonical filename is an ambiguous contract → throws
const dupContract = mkManifest();
dupContract[4].file = "ai-label.ts";
check("manifest with a duplicate file entry → throws", !!throws(() => assembleDesignPackage(mkRaw({ manifest: dupContract }))));
check(
  "invalid authority_class → throws",
  !!throws(() =>
    assembleDesignPackage(mkRaw({ labels: [{ name: "L", type: "Y/N", authority_class: "vibes", ship_gate: true, definition: "d", decision_threshold: "≥1" }] })),
  ),
);
check("readme too short → throws", (throws(() => assembleDesignPackage(mkRaw({ readme_markdown: "tiny" }))) ?? "").includes("readme"));
check("non-object raw → throws", !!throws(() => assembleDesignPackage("not json" as any)));
check("no labels → throws", !!throws(() => assembleDesignPackage(mkRaw({ labels: [] }))));

// ── looksQuantified (the structural quantified-threshold proxy) ────────────────────
check("looksQuantified: 'rate drops ≥40%' → true", looksQuantified("rate drops ≥40%"));
check("looksQuantified: 'stays ≥4.5/5' → true", looksQuantified("stays ≥4.5/5"));
check("looksQuantified: '≤2 of N' → true", looksQuantified("≤2 of N"));
check("looksQuantified: 'improves significantly' → false", !looksQuantified("improves significantly"));
check("looksQuantified: 'better than before' → false", !looksQuantified("better than before"));
check("looksQuantified: 'rate drops noticeably' → false (bare verb, no number)", !looksQuantified("rate drops noticeably"));
check("looksQuantified: null/empty → false", !looksQuantified(null) && !looksQuantified("") && !looksQuantified(undefined));

// ── buildDesignUserPrompt ──────────────────────────────────────────────────────────
const req: DesignRequest = { system_description: "Stage 1 narration-leak prompt edit", change_type: "prompt-edit", baseline_facts: "leak 60% at V5 (commit abc)" };
const prec: PrecedentCard[] = [{ tenant: "__base__", card_ref: "T-MET-009", type: "METHOD", title: "Signal-feature binary beats 1-5", score: 0.82, body: "Use signal features, not word counts." }];
const up = buildDesignUserPrompt(req, prec);
check("prompt includes the system description", up.includes("Stage 1 narration-leak prompt edit"));
check("prompt includes the change type", up.includes("prompt-edit"));
check("prompt includes baseline facts", up.includes("leak 60% at V5"));
check("prompt includes the precedent card_ref + body", up.includes("T-MET-009") && up.includes("Use signal features"));
check("prompt with no precedent says 'design from first principles'", buildDesignUserPrompt(req, []).includes("first principles"));

// ── grounding (Codex final check 2026-09-27: the design invented a priority value and a ticket's
//     content because it only ever saw a one-line description) ──
{
  const facts = "Allowed priorities: urgent, normal, low (exactly these three).\nSample ticket 'We were charged twice this month...' -> urgent.";
  const grounded = buildDesignUserPrompt({ ...req, codebase_facts: facts }, []);
  check("codebase facts reach the design prompt verbatim", grounded.includes("CODEBASE FACTS") && grounded.includes("urgent, normal, low (exactly these three)"));
  check("codebase facts are named the only source for concrete values", grounded.includes("the ONLY source for concrete values"));
  const bare = buildDesignUserPrompt(req, []);
  check("with no codebase facts the prompt says to mark values UNKNOWN, not guess", bare.includes("CODEBASE FACTS: none supplied") && bare.includes("UNKNOWN"));
  for (const section of ["Phase D.5 eyeball check", "Iteration log", "Run fingerprint", "EXISTING-PATTERN-ACKNOWLEDGED", "BOTH bash and PowerShell", "State model"]) {
    check(`the design system prompt requires the validator-critical README item: ${section}`, DESIGN_SYSTEM.includes(section));
  }
  check("the design system prompt carries the grounding rule", DESIGN_SYSTEM.includes("0. GROUNDING") && DESIGN_SYSTEM.includes("never \"complete\" a set") && DESIGN_SYSTEM.includes("UNKNOWN: <what the local agent must confirm>"));
}

// ── buildRepairPrompt (the invariant-repair retry — the I/O layer re-asks the brain with this on an
//     invariant slip; pure, so it's the offline contract for the retry's payload) ──
const violation =
  "harness_design invariants violated:\n- ship-gate label 'causal_reachability' has no quantified decision_threshold (got: \"reachable or INCONCLUSIVE\")";
const repair = buildRepairPrompt("ORIGINAL_DESIGN_PROMPT_BODY", violation);
check("repair prompt carries the original design prompt", repair.includes("ORIGINAL_DESIGN_PROMPT_BODY"));
check("repair prompt feeds the exact violation back", repair.includes("has no quantified decision_threshold"));
check("repair prompt reminds: ship_gate threshold needs a number/comparator", repair.includes("ship_gate label") && repair.includes("number or comparator"));
check("repair prompt forbids the prose forms it slipped on", repair.includes("INCONCLUSIVE") && repair.includes("improves"));

// ── enums / constants ──────────────────────────────────────────────────────────────
check("CHANGE_TYPES has 7 closed entries incl. prompt-edit + regression-only", CHANGE_TYPES.length === 7 && CHANGE_TYPES.includes("prompt-edit") && CHANGE_TYPES.includes("regression-only"));
check("CANONICAL_FILES is the 5-file scaffold (no README)", CANONICAL_FILES.length === 5 && !(CANONICAL_FILES as readonly string[]).includes("README.md") && CANONICAL_FILES.includes("ai-label.ts"));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
