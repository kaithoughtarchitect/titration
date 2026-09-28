// Titration MCP — Refusal → Draft Auto-Capture: the PURE classifier (no I/O, no imports).
//
// On a baseline reproduce-refuse or a terminal verify inconclusive/regression, this module
// derives a machine-readable RefusalClass from the already-computed refusal signal — the
// same discipline as flywheel-core.ts's verdictToCard: offline-testable without a DB or a
// judge, zero store/sql/fetch/embed imports (store.ts:18 throws at import without
// TITRATION_DATABASE_URL, so this module cannot import from it, directly or transitively).
//
// INTERNAL to the capture path — RefusalClass is NEVER a field on EstablishResult /
// VerifyResult. The I/O half (assertWritable guard, dedup, insert) lives in the
// sibling lib/refusal-capture.ts.

// The five machine-readable refusal classes derived from an already-refused verdict.
// INTERNAL to the capture path — NEVER a field on EstablishResult / VerifyResult.
export type RefusalClass =
  | "reproduce_fail" // establish: corpus does NOT reproduce the failure
  | "effective_n_low" // verify: inconclusive && /Effective-N/.test(reason)
  | "noise_floor" // verify: inconclusive && failure_origin===null && /noise floor/.test(reason)
  | "judge_variance" // verify: inconclusive && failure_origin === 'judge-variance'
  //   (catches BOTH the direct judge-variance branch AND the
  //    direction-split branch — both set this same failure_origin)
  | "per_mode_regression"; // verify: passed === false && !floor_intact

// The minimal structural slice the classifier reads. Re-declared here (NOT imported
// from verify.ts) to keep the module import-clean — the tax flywheel-core.ts:11-13 pays.
// EstablishResult satisfies it (reproduced/reason present; passed/floor_intact absent).
// VerifyResult   satisfies it (inconclusive/passed/floor_intact/failure_origin/reason
//                              present; reproduced absent). Excess fields on the real
//                              wire types (e.g. a future uncertainty_cause) are harmless —
//                              structural typing only reads what this interface declares.
export interface RefusalSignal {
  reproduced?: boolean;
  inconclusive?: boolean;
  passed?: boolean;
  floor_intact?: boolean;
  failure_origin?: string | null;
  reason?: string;
}

// PURE. Ordered evaluation, first match wins; returns null when the input is NOT a
// refusal (a reproduced baseline / a passed verify / the un-named 6th "no scorable
// rows" verify path — deliberately out of scope for this classifier).
// Order (Phase-3b MAJOR fix — judge_variance MUST precede noise_floor):
//   1) reproduced === false                                       -> 'reproduce_fail'
//   2) inconclusive === true && /Effective-N/.test(reason)        -> 'effective_n_low'
//   3) inconclusive === true && failure_origin === 'judge-variance' -> 'judge_variance'
//        ^^ MUST precede the noise_floor regex: the direction-split branch
//           (verify.ts:536-550) sets failure_origin='judge-variance' AND its reason
//           contains "noise floor" (verify.ts:548 quotes "the median was smoothing
//           away a sign conflict"; the actual literal check is on the reason text
//           produced by the noise-floor branch, verify.ts:531-535) — checking the
//           regex first would misclassify a direction-split refusal as noise_floor
//           and COLLIDE on the dedup key with a true noise-floor refusal, suppressing
//           one — the exact false-suppression the 2b cardSearch-removal TRIM
//           existed to prevent.
//   4) inconclusive === true && failure_origin === null && /noise floor/.test(reason) -> 'noise_floor'
//        (the TRUE noise-floor branch has failure_origin===null, verify.ts:531-535;
//         the failure_origin===null guard makes step 3-before-4 robust.)
//   5) passed === false && floor_intact === false                 -> 'per_mode_regression'
//   else null
export function deriveRefusalClass(signal: RefusalSignal): RefusalClass | null {
  if (signal.reproduced === false) return "reproduce_fail";

  if (signal.inconclusive === true) {
    const reason = signal.reason ?? "";
    if (/Effective-N/i.test(reason)) return "effective_n_low";
    if (signal.failure_origin === "judge-variance") return "judge_variance";
    if (signal.failure_origin === null && /noise floor/i.test(reason)) return "noise_floor";
    return null; // an inconclusive verdict not matching any of the 3 named buckets (e.g. the
    // un-named "no scorable rows" verify.ts:517-519 path) is deliberately NOT classified.
  }

  if (signal.passed === false && signal.floor_intact === false) return "per_mode_regression";

  return null;
}
