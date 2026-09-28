// Titration MCP — B1.3 repeat-capture: the capture-variance band (no network, no DB, $0).
//
// The F8 measurement (2026-08-24/25) separated the two variances the hard way: judge-only
// re-grades moved a rate by ONE row, while byte-identical re-CAPTURES on a fully pinned rig
// moved it 12.5pp overall — ~3× the printed noise floor — and two captures of one unchanged
// configuration were both returned "Improvement confirmed, high confidence". The noise floor
// honestly measures judges and silently cannot see capture. This suite pins the fix: rows
// shipped as labelled replicates produce a between-capture band, and an improvement claim
// must clear the WIDER of the two floors.
//
// Run: npx tsx lib/__tests__/capture-variance.test.ts

import { computeCaptureVariance, checkCaptureLabeling } from "../capture-variance-core";
import type { VerifyDependencies } from "../verify";
import type { BaselineRow } from "../baseline";
import type { JudgeSpec } from "../judge";

process.env.TITRATION_DATABASE_URL ??= "postgres://127.0.0.1:1/titration-offline-import-only";
const { verifyWithDependencies } = await import("../verify");

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail = "") {
  total++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}

// ── the pure band ─────────────────────────────────────────────────────────────
{
  check("no labels → null (single-capture callers are byte-identical to before)", computeCaptureVariance([
    { mode: "all", verdict: "pass" },
    { mode: "all", verdict: "fail" },
  ]) === null);

  check("one label → null (a single capture has no spread)", computeCaptureVariance([
    { capture: "pass-1", mode: "all", verdict: "pass" },
    { capture: "pass-1", mode: "all", verdict: "fail" },
  ]) === null);

  const two = computeCaptureVariance([
    // pass-1: 1 fail of 4 = 25%
    { capture: "pass-1", mode: "tool_ran", verdict: "fail" },
    { capture: "pass-1", mode: "tool_ran", verdict: "pass" },
    { capture: "pass-1", mode: "no_tool", verdict: "pass" },
    { capture: "pass-1", mode: "no_tool", verdict: "pass" },
    // pass-2: 3 fails of 4 = 75%
    { capture: "pass-2", mode: "tool_ran", verdict: "fail" },
    { capture: "pass-2", mode: "tool_ran", verdict: "fail" },
    { capture: "pass-2", mode: "no_tool", verdict: "fail" },
    { capture: "pass-2", mode: "no_tool", verdict: "pass" },
    // a dead row never enters any rate
    { capture: "pass-2", mode: "no_tool", verdict: null },
  ])!;
  check("two labels → per-capture rates over scorable rows", two.captures["pass-1"]!.rate === 0.25 && two.captures["pass-1"]!.n === 4 && two.captures["pass-2"]!.rate === 0.75 && two.captures["pass-2"]!.n === 4, JSON.stringify(two.captures));
  check("band = max − min of per-capture rates", two.band === 0.5, String(two.band));
  check("per-mode bands are reported per bucket", two.per_mode["tool_ran"]!.band === 0.5 && two.per_mode["no_tool"]!.band === 0.5, JSON.stringify(two.per_mode));
  check("labeled/unlabeled accounting", two.labeled_rows === 8 && two.unlabeled_rows === 0, JSON.stringify({ l: two.labeled_rows, u: two.unlabeled_rows }));

  const mixed = computeCaptureVariance([
    { capture: "a", mode: "all", verdict: "pass" },
    { capture: "b", mode: "all", verdict: "fail" },
    { mode: "all", verdict: "pass" },
  ])!;
  check("unlabeled scorable rows are surfaced, not silently pooled", mixed.unlabeled_rows === 1, String(mixed.unlabeled_rows));

  const oneSidedMode = computeCaptureVariance([
    { capture: "a", mode: "shared", verdict: "pass" },
    { capture: "b", mode: "shared", verdict: "pass" },
    { capture: "a", mode: "only-in-a", verdict: "fail" },
  ])!;
  check("a mode present in one capture reports no per-mode band", !("only-in-a" in oneSidedMode.per_mode) && "shared" in oneSidedMode.per_mode, JSON.stringify(oneSidedMode.per_mode));
}

// ── verify integration: the band gates the claim ─────────────────────────────
const judges: JudgeSpec[] = [
  { id: "grok", family: "xAI", door: "openrouter", model: "m1" },
  { id: "gpt", family: "OpenAI", door: "openrouter", model: "m2" },
];
const baseline: BaselineRow = {
  id: "baseline-band",
  tenant: "demo",
  goal: "reduce the failure",
  system_ref: null,
  corpus_ref: null,
  rubric_text: "Fail when the output exhibits the failure.",
  rubric_hash: "sealed",
  baseline_rate: 0.5,
  effective_n: 24,
  agreement: 1,
  per_mode: { all: { rate: 0.5, n: 24 } },
  per_judge: { grok: { rate: 0.5, n: 24 }, gpt: { rate: 0.5, n: 24 } },
  judge_panel: { source: "recorded-at-grade", resolved: [], ran: ["grok", "gpt"], failed: [] },
  reproduced: true,
  created_at: "2026-08-25T00:00:00.000Z",
};

// Judges: unanimous, verdict decided by the row text (BUG → fail). Clean panel, so the
// judge noise floor is 0 and any pooled delta would clear it — exactly the trap B1 names.
const deps: VerifyDependencies = {
  activePanel: () => judges,
  loadBaseline: async () => baseline,
  maybeDraftRefusalCandidate: async () => {},
  runPanel: async (_s, user, resolvedPanel) => ({
    ok: (resolvedPanel ?? []).map((j) => ({
      id: j.id, family: j.family, model: j.model,
      json: { reasoning: "r", verdict: user.includes("XFAIL") ? "fail" : "pass", confidence: "high" },
    })),
    failed: [],
  }),
};

function rows(capture: string, fails: number, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${capture}-${i + 1}`,
    mode: "all",
    capture,
    output: i < fails ? `XFAIL ${capture} ${i}` : `clean ${capture} ${i}`,
  }));
}

{
  // Two replicates of ONE configuration disagreeing 25% vs 45%: pooled rate 35% → delta
  // −15pp, which a judge-only floor of 0 would confirm. The observed band (20pp) must gate it.
  const gated = await verifyWithDependencies(deps, {
    tenant: "demo", baseline_id: baseline.id,
    candidate_outputs: [...rows("pass-1", 5, 20), ...rows("pass-2", 9, 20)],
  });
  check("a delta inside the observed capture band is INCONCLUSIVE, not a win", gated.inconclusive === true && gated.passed === false, JSON.stringify({ passed: gated.passed, inconclusive: gated.inconclusive, delta: gated.metric_delta }));
  check("significance_floor is the band when the band is wider", gated.significance_floor === 0.2 && gated.noise_floor === 0, JSON.stringify({ sf: gated.significance_floor, nf: gated.noise_floor }));
  check("capture_variance is reported at the top level", gated.capture_variance !== null && gated.capture_variance!.band === 0.2 && Object.keys(gated.capture_variance!.captures).length === 2, JSON.stringify(gated.capture_variance));
  check("the reason names the capture as the binding uncertainty", gated.reason.includes("capture-variance band") && gated.reason.includes("replicate captures"), gated.reason);
}

{
  // The same two replicates agreeing (10% and 14% → band 4pp) with a −38pp pooled move: passes,
  // and the reason records that it cleared the band too.
  const passed = await verifyWithDependencies(deps, {
    tenant: "demo", baseline_id: baseline.id,
    candidate_outputs: [...rows("pass-1", 2, 20), ...rows("pass-2", 3, 20)],
  });
  check("a delta clearing both floors still passes", passed.passed === true && passed.inconclusive === false, JSON.stringify({ passed: passed.passed, reason: passed.reason }));
  check("significance_floor equals the (small) band", passed.significance_floor === 0.05, String(passed.significance_floor));
  check("the pass reason records clearing the band", passed.reason.includes("capture-variance band"), passed.reason);
}

{
  // Flagged in automated PR review (PR #74): a PARTIALLY labeled corpus is a population mismatch — the band
  // would cover only the labeled subset while the delta covers every scorable row.
  // Refused upfront, before a single judge call.
  const pure = checkCaptureLabeling([
    { capture: "a" }, { capture: "a" }, {}, { capture: "" },
  ]);
  check("checkCaptureLabeling counts and locates the unlabeled rows", pure.partial === true && pure.labeled === 2 && pure.unlabeled === 2 && pure.unlabeled_indices.join(",") === "2,3", JSON.stringify(pure));
  check("fully labeled corpora are not partial", checkCaptureLabeling([{ capture: "a" }, { capture: "b" }]).partial === false);
  check("fully unlabeled corpora are not partial", checkCaptureLabeling([{}, {}]).partial === false);

  let panelCalls = 0;
  const countingDeps: VerifyDependencies = {
    ...deps,
    runPanel: async (...args) => { panelCalls++; return deps.runPanel(...args); },
  };
  let refusal = "";
  try {
    await verifyWithDependencies(countingDeps, {
      tenant: "demo", baseline_id: baseline.id,
      candidate_outputs: [...rows("pass-1", 2, 10), ...Array.from({ length: 10 }, (_, i) => ({ id: `u${i}`, mode: "all", output: `clean u${i}` }))],
    });
  } catch (e) {
    refusal = (e as Error).message;
  }
  check(
    "a partially labeled candidate corpus is REFUSED with the rule and the offending rows",
    refusal.includes("PARTIALLY capture-labeled") && refusal.includes("population mismatch") && refusal.includes("10 labeled, 10 unlabeled"),
    refusal,
  );
  check("the refusal fires BEFORE any judge spend", panelCalls === 0, String(panelCalls));
}

{
  // Unlabeled corpus: nothing changes — null variance, significance_floor === noise_floor.
  const plain = await verifyWithDependencies(deps, {
    tenant: "demo", baseline_id: baseline.id,
    candidate_outputs: Array.from({ length: 24 }, (_, i) => ({ id: `r${i}`, mode: "all", output: i < 3 ? `XFAIL ${i}` : `clean ${i}` })),
  });
  check("an unlabeled corpus is byte-compatible: no band, floor unchanged", plain.capture_variance === null && plain.significance_floor === plain.noise_floor, JSON.stringify({ cv: plain.capture_variance, sf: plain.significance_floor, nf: plain.noise_floor }));
  check("and it still passes on a real improvement", plain.passed === true, plain.reason);
}

console.log(`\n${failures === 0 ? `ALL PASS (${total})` : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
