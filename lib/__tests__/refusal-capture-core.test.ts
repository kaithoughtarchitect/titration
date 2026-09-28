// Titration MCP — refusal-capture-core unit test (no network, no DB, no model).
// Pins the PURE classification decision deriveRefusalClass makes over an already-refused
// verdict signal:
//   • all 5 RefusalClass values, each from the minimal RefusalSignal shape that would
//     actually arrive from establishBaseline / verify
//   • the non-refusal null cases (reproduced===true; a passed verify; the un-named 6th
//     "no scorable rows" verify path; a passed===false/floor_intact===true "worse" verdict
//     that clears none of the 5 named buckets)
//   • the Phase-3b MAJOR regression guard: a direction-split signal (failure_origin===
//     'judge-variance' AND reason contains "noise floor") MUST classify as judge_variance,
//     NOT noise_floor — proves the classifier reorder holds and the dedup-key collision
//     the 2b TRIM's cardSearch removal existed to prevent cannot recur.
// Mirrors lib/__tests__/dedupe-core.test.ts (check/total/failures + process.exit).
// Run: npx tsx lib/__tests__/refusal-capture-core.test.ts

import { deriveRefusalClass, type RefusalSignal } from "../refusal-capture-core";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail = "") {
  total++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}

// ── the 5 classes, each from a realistic signal shape ─────────────────────────────

// 1) establish_baseline reproduce-refuse (verify.ts:361-370's actual return shape).
const reproduceFailSignal: RefusalSignal = {
  reproduced: false,
  reason:
    "Corpus does NOT reproduce the failure (rate 4.5% on n=22, 1 absolute; gate ≥10.0% AND ≥3). " +
    "REFUSED — a baseline that can't exhibit the bug measures nothing. Fix the corpus (origin: " +
    "corpus-gap; harvest real traces that exercise the mode), do not freeze.",
};
check("reproduce_fail: reproduced===false", deriveRefusalClass(reproduceFailSignal) === "reproduce_fail");

// 2) verify low-effective-N (verify.ts:520-524's actual reason text; failure_origin stays null).
const effectiveNLowSignal: RefusalSignal = {
  inconclusive: true,
  failure_origin: null,
  reason:
    "Effective-N below 20 (candidate n=8, baseline n=25). INCONCLUSIVE regardless of the rate (G2) " +
    "— expand the corpus, don't ship on weak data.",
};
check("effective_n_low: inconclusive + /Effective-N/ reason", deriveRefusalClass(effectiveNLowSignal) === "effective_n_low");

// 3) verify direct judge-variance (verify.ts:525-530's actual reason text).
const judgeVarianceSignal: RefusalSignal = {
  inconclusive: true,
  failure_origin: "judge-variance",
  reason:
    "Inter-judge agreement 45.0% is below the judge-variance floor 60.0% — the label cannot support " +
    "a verdict regardless of its value (origin: judge-variance). Recalibrate / escalate judges.",
};
check("judge_variance: inconclusive + failure_origin==='judge-variance'", deriveRefusalClass(judgeVarianceSignal) === "judge_variance");

// 4) verify true noise-floor (verify.ts:531-535's actual reason text; failure_origin===null here).
const noiseFloorSignal: RefusalSignal = {
  inconclusive: true,
  failure_origin: null,
  reason:
    "|delta| 3.0pp is within the noise floor ±5.0pp (1 − inter-judge agreement). INCONCLUSIVE, NOT " +
    "a win — add signal or sharpen the rubric. Over-claiming a delta you can't distinguish from noise " +
    "is the exact failure the methodology defends against.",
};
check("noise_floor: inconclusive + failure_origin===null + /noise floor/ reason", deriveRefusalClass(noiseFloorSignal) === "noise_floor");

// 5) verify per-mode regression (verify.ts:556-560's actual reason text).
const perModeRegressionSignal: RefusalSignal = {
  passed: false,
  floor_intact: false,
  inconclusive: false,
  reason:
    "Aggregate improved (-8.0pp) BUT per-mode regression on [archetype:shy] (worse by >10.0pp and " +
    "outside the noise floor) — aggregate movement is hiding a mode collapse (§6.1). Does not ship.",
};
check("per_mode_regression: passed===false && floor_intact===false", deriveRefusalClass(perModeRegressionSignal) === "per_mode_regression");

// ── the Phase-3b MAJOR regression guard: direction-split MUST be judge_variance ───────
// verify.ts:536-550's direction-split branch sets failure_origin='judge-variance' AND its own
// reason text literally contains "cleared the noise floor" — the exact collision the classifier
// reorder (judge_variance BEFORE the noise_floor regex) exists to prevent.
const directionSplitSignal: RefusalSignal = {
  inconclusive: true,
  failure_origin: "judge-variance",
  reason:
    "Judges DISAGREE ON DIRECTION: 1 see improvement, 2 see regression (per-judge candidate rates vs " +
    "the consensus baseline 20.0% [grok:12.0%, deepseek:28.0%]). The consensus delta -4.0pp cleared " +
    "the noise floor but the median was smoothing away a sign conflict — no single-direction verdict " +
    "is defensible (origin: judge-variance). Recalibrate / escalate judges or add signal.",
};
check(
  "3b regression guard: direction-split (failure_origin='judge-variance' + reason contains 'noise floor') => judge_variance, NOT noise_floor",
  deriveRefusalClass(directionSplitSignal) === "judge_variance",
  `got ${deriveRefusalClass(directionSplitSignal)}`,
);

// ── non-refusal / non-classified null cases ───────────────────────────────────────

// reproduced===true (a normal established baseline) => null, never drafts.
check("null: reproduced===true (baseline established, not a refusal)", deriveRefusalClass({ reproduced: true, reason: "Baseline frozen." }) === null);

// a clean passed verify => null, never drafts.
const passedVerifySignal: RefusalSignal = {
  passed: true,
  inconclusive: false,
  floor_intact: true,
  failure_origin: null,
  reason: "Improvement confirmed: failure rate fell 8.0pp, outside the noise floor ±5.0pp, floor intact across all shared modes.",
};
check("null: passed===true verify (not a refusal)", deriveRefusalClass(passedVerifySignal) === null);

// the un-named 6th verify path (verify.ts:517-519, "no scorable candidate rows") => null by design
// (deliberately out of the 5-class scope this classifier covers — not a bug).
const noScorableRowsSignal: RefusalSignal = {
  inconclusive: true,
  failure_origin: null,
  reason: "No scorable candidate rows (all rows inconclusive / judges failed). Cannot read a delta.",
};
check("null: inconclusive but no named bucket matches (no-scorable-rows path, out of locked scope)", deriveRefusalClass(noScorableRowsSignal) === null);

// a "candidate is worse" verdict (verify.ts:551-555): passed===false but floor_intact===true (no
// per-mode regression) — NOT one of the 5 named classes, so it must NOT be classified.
const worseButFloorIntactSignal: RefusalSignal = {
  passed: false,
  floor_intact: true,
  inconclusive: false,
  reason: "Candidate is WORSE: failure rate rose 6.0pp, outside the noise floor. Revert.",
};
check(
  "null: passed===false but floor_intact===true ('worse' verdict, not per_mode_regression)",
  deriveRefusalClass(worseButFloorIntactSignal) === null,
);

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${total - failures}/${total}`);
process.exit(failures === 0 ? 0 : 1);
