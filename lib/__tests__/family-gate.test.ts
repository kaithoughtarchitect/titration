// Titration MCP — grading-integrity gate: distinct vendor-family accounting
// (no network, no DB, no model — $0). Pins the frozen outcome table:
//
//   | Resolved panel families | Responding families | Outcome                       |
//   |--------------------------|----------------------|--------------------------------|
//   | < 2                      | —                    | typed refusal before any call  |
//   | >= 2                     | >= 2                 | numeric verdict (unchanged)    |
//   | >= 2                     | < 2                  | panel-degraded: no numeric     |
//   |                          |                      | verdict fields, typed reason   |
//
// Row 3's interesting corner: TWO judges from the SAME vendor family responding
// still clears the PRE-EXISTING vote-count corroboration floor (panel_floor_votes
// default 2 — panel-coverage-core.ts), so the family gate is genuinely NEW signal,
// not a restatement of the vote floor. Every scenario below asserts the vote floor
// would NOT have caught it (under_corroborated_rows === 0) so the two gates are not
// conflated.
// Run: npx tsx lib/__tests__/family-gate.test.ts

import { distinctFamilies } from "../consensus";
import type {
  EstablishDependencies,
  VerifyDependencies,
  VerifyRunPanelPort,
} from "../verify";
import type { BaselineRow, NewBaseline } from "../baseline";
import type { JudgeSpec } from "../judge";

process.env.TITRATION_DATABASE_URL ??= "postgres://127.0.0.1:1/titration-offline-import-only";
const { verifyWithDependencies, establishWithDependencies, resolvePanel } = await import("../verify");

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail = "") {
  total++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}

function throws(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e: unknown) {
    return String(e instanceof Error ? e.message : e);
  }
}

// ── distinctFamilies (pure) ───────────────────────────────────────────────────
check("empty panel is 0 distinct families", distinctFamilies([]) === 0);
check("one judge is 1 distinct family", distinctFamilies([{ family: "openai" }]) === 1);
check(
  "two judges, SAME family, is 1 distinct family (2 judges != 2 families)",
  distinctFamilies([{ family: "openai" }, { family: "openai" }]) === 1,
);
check(
  "two judges, different families, is 2",
  distinctFamilies([{ family: "openai" }, { family: "anthropic" }]) === 2,
);
check(
  "three judges, two families (2 openai + 1 x-ai), is 2",
  distinctFamilies([{ family: "openai" }, { family: "openai" }, { family: "x-ai" }]) === 2,
);
check(
  "three judges, three distinct families, is 3",
  distinctFamilies([{ family: "openai" }, { family: "anthropic" }, { family: "x-ai" }]) === 3,
);

// ── Table row 1: < 2 RESOLVED families → typed refusal BEFORE any call ────────
{
  const sameFamily: JudgeSpec[] = [
    { id: "a1", family: "openai", door: "openrouter", model: "m-a1" },
    { id: "a2", family: "openai", door: "openrouter", model: "m-a2" },
  ];
  const err = throws(() => resolvePanel(undefined, () => sameFamily));
  check(
    "row 1: 2 SAME-family judges resolve to 1 distinct family — refused before any call",
    err !== null && err.includes("≥2") && err.includes("famil"),
    err ?? "no throw",
  );
}
{
  const soloJudge: JudgeSpec[] = [{ id: "solo", family: "openai", door: "openrouter", model: "m-solo" }];
  const err = throws(() => resolvePanel(undefined, () => soloJudge));
  check("row 1: a single judge is refused (1 < 2 families)", err !== null && err.includes("≥2"), err ?? "no throw");
}
{
  const empty: JudgeSpec[] = [];
  const err = throws(() => resolvePanel(undefined, () => empty));
  check("row 1: an empty panel is refused (0 < 2 families)", err !== null && err.includes("≥2"), err ?? "no throw");
}
{
  const twoFamilies: JudgeSpec[] = [
    { id: "a1", family: "openai", door: "openrouter", model: "m-a1" },
    { id: "b1", family: "anthropic", door: "openrouter", model: "m-b1" },
  ];
  const panel = resolvePanel(undefined, () => twoFamilies);
  check(
    "row 1 boundary: exactly 2 distinct families resolves (not refused)",
    panel.map((j) => j.id).join(",") === "a1,b1",
    panel.map((j) => j.id).join(","),
  );
}

// ── Table rows 2 & 3: shared fixtures for establish_baseline + verify ─────────
//
// Panel resolves to 2 distinct families (openai x2, anthropic x1) — passes the
// PRE-CALL gate (row 1 does not apply). Which judges actually RESPOND decides
// row 2 vs row 3.
const mixedPanel: JudgeSpec[] = [
  { id: "openai-1", family: "openai", door: "openrouter", model: "m-openai-1" },
  { id: "openai-2", family: "openai", door: "openrouter", model: "m-openai-2" },
  { id: "anthropic-1", family: "anthropic", door: "openrouter", model: "m-anthropic-1" },
];

const respondersOnly = (responders: string[], verdict: "pass" | "fail"): VerifyRunPanelPort =>
  async (_system, _user, resolvedPanel) => {
    const js = resolvedPanel ?? [];
    return {
      ok: js.filter((j) => responders.includes(j.id)).map((j) => ({
        id: j.id,
        family: j.family,
        model: j.model,
        json: { reasoning: verdict === "fail" ? "bug present" : "clean", verdict, confidence: "high" },
      })),
      failed: js.filter((j) => !responders.includes(j.id)).map((j) => ({
        id: j.id,
        family: j.family,
        model: j.model,
        error: "simulated single-family outage",
      })),
    };
  };

// ── verify() fixtures ──────────────────────────────────────────────────────────
const verifyBaseline: BaselineRow = {
  id: "baseline-family-gate",
  tenant: "demo",
  goal: "remove the synthetic failure",
  system_ref: null,
  corpus_ref: "dry-corpus",
  rubric_text: "Fail only when the output contains BUG.",
  rubric_hash: "sealed-rubric-hash",
  baseline_rate: 1,
  effective_n: 24,
  agreement: 1,
  per_mode: { all: { rate: 1, n: 24 } },
  per_judge: {
    "openai-1": { rate: 1, n: 24 },
    "openai-2": { rate: 1, n: 24 },
    "anthropic-1": { rate: 1, n: 24 },
  },
  judge_panel: { source: "recorded-at-grade", resolved: [], ran: ["openai-1", "openai-2", "anthropic-1"], failed: [] },
  reproduced: true,
  created_at: "2026-09-25T00:00:00.000Z",
};
const cleanRows = Array.from({ length: 24 }, (_, i) => ({ id: `row-${i + 1}`, mode: "all", output: `CLEAN ${i + 1}` }));

function verifyDeps(runPanel: VerifyRunPanelPort): VerifyDependencies {
  return {
    activePanel: () => mixedPanel,
    loadBaseline: async () => verifyBaseline,
    maybeDraftRefusalCandidate: async () => {},
    runPanel,
  };
}

{
  const result = await verifyWithDependencies(
    verifyDeps(respondersOnly(["openai-1", "anthropic-1"], "pass")),
    { tenant: "demo", baseline_id: verifyBaseline.id, candidate_outputs: cleanRows },
  );
  check(
    "row 2 (verify): >=2 distinct RESPONDING families → a real numeric verdict (consensus math unchanged)",
    result.inconclusive === false
      && result.passed === true
      && result.failure_origin === null
      && result.metric_delta === -1
      && result.candidate_rate === 0
      && result.votes.under_corroborated_rows === 0,
    JSON.stringify({ inconclusive: result.inconclusive, passed: result.passed, origin: result.failure_origin, delta: result.metric_delta }),
  );
}

{
  const result = await verifyWithDependencies(
    verifyDeps(respondersOnly(["openai-1", "openai-2"], "pass")),
    { tenant: "demo", baseline_id: verifyBaseline.id, candidate_outputs: cleanRows },
  );
  check(
    "row 3 (verify): 2 SAME-family responders clear the vote-count floor but fail the family gate",
    result.inconclusive === true
      && result.passed === false
      && result.failure_origin === "panel-degraded"
      && result.reason.includes("openai")
      && result.votes.under_corroborated_rows === 0, // proves the vote-count floor ALONE would not have caught this
    JSON.stringify({ inconclusive: result.inconclusive, passed: result.passed, origin: result.failure_origin, under: result.votes.under_corroborated_rows, reason: result.reason }),
  );
}

// ── establish_baseline() fixtures ──────────────────────────────────────────────
const bugRows = Array.from({ length: 24 }, (_, i) => ({ id: `bug-${i + 1}`, mode: "all", output: `BUG ${i + 1}` }));

function establishDeps(runPanel: EstablishDependencies["runPanel"], inserted: NewBaseline[]): EstablishDependencies {
  return {
    activePanel: () => mixedPanel,
    runPanel,
    insertBaseline: async (_tenant, row) => {
      inserted.push(row);
      return { baseline_id: "baseline-family-gate-frozen" };
    },
    hasPerRowColumn: async () => true,
    maybeDraftRefusalCandidate: async () => {},
    loadConfirmedReceipt: async () => {
      throw new Error("loadConfirmedReceipt should not run without panel_receipt_id");
    },
    stampUsedForBaseline: async () => ({}),
    // Wiring-only addition: this suite exercises
    // the family-degraded GRADING gate, not panel-SOURCE resolution — supplying the
    // same mixedPanel here (as `activePanel` already does above) keeps every
    // check() in this file byte-identical while satisfying the new required port.
    resolveEnvJudgePanel: async () => mixedPanel,
  };
}

{
  const inserted: NewBaseline[] = [];
  const result = await establishWithDependencies(
    establishDeps(respondersOnly(["openai-1", "anthropic-1"], "fail"), inserted),
    {
      tenant: "demo",
      goal: "remove the synthetic failure",
      rubric: "Fail only when the output contains BUG.",
      baseline_outputs: bugRows,
    },
  );
  check(
    "row 2 (establish): >=2 distinct RESPONDING families → freezes normally",
    result.reproduced === true
      && result.baseline_id === "baseline-family-gate-frozen"
      && inserted.length === 1
      && result.baseline_rate === 1,
    JSON.stringify({ reproduced: result.reproduced, baseline_id: result.baseline_id, inserted: inserted.length }),
  );
}

{
  const inserted: NewBaseline[] = [];
  const result = await establishWithDependencies(
    establishDeps(respondersOnly(["openai-1", "openai-2"], "fail"), inserted),
    {
      tenant: "demo",
      goal: "remove the synthetic failure",
      rubric: "Fail only when the output contains BUG.",
      baseline_outputs: bugRows,
    },
  );
  check(
    "row 3 (establish): 2 SAME-family responders → panel-degraded refusal, never scored",
    result.baseline_id === null
      && result.reproduced === false
      && result.reason.includes("REFUSED to freeze")
      && result.reason.includes("openai")
      && inserted.length === 0
      && result.votes.under_corroborated_rows === 0 // vote floor alone would not have caught this
      && !("baseline_rate" in result)
      && !("effective_n" in result)
      && !("total" in result)
      && !("inconclusive_n" in result)
      && !("agreement" in result)
      && !("median_rate" in result)
      && !("rate_spread" in result)
      && !("per_mode" in result)
      && !("capture_variance" in result)
      && "votes" in result
      && "panel" in result,
    JSON.stringify(result),
  );
}

console.log(`\n${failures === 0 ? `ALL PASS (${total})` : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
