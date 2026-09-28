// Titration MCP — consensus tally (categorical slice).
//
// Implements the categorical-verdict slice of goal-titrate-judge-model-spec §9.1–9.2:
//   • categorical field (here: failure_origin) → 2-of-3 majority wins
//   • 1-1-1 (or 1-1 on a 2-judge panel) split → no majority → inconclusive
//   • single judge → its vote stands, but flagged low-confidence single-judge
// Median rates (continuous fields) and the dissent-reconsideration round (§9.6+)
// arrive with B2/B3; B1 needs only this single-field categorical tally.

export type Confidence = "low" | "medium" | "high";

export interface CategoricalTally {
  winner: string | null; // majority category, or null when no majority exists
  agreement: number; // winner votes / total (0..1)
  counts: Record<string, number>;
  inconclusive: boolean; // true on a split — no trustworthy majority
  confidence: Confidence | null; // consensus-level confidence (null when inconclusive)
  mode: "unanimous" | "majority" | "single-judge" | "split";
}

export function tallyCategorical(votes: string[]): CategoricalTally {
  const counts: Record<string, number> = {};
  for (const v of votes) counts[v] = (counts[v] ?? 0) + 1;
  const total = votes.length;
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const [topCat, topN] = ranked[0] ?? [null, 0];
  const tied = ranked.length > 1 && ranked[1][1] === topN; // another category matches the top count

  if (total === 0) {
    return { winner: null, agreement: 0, counts, inconclusive: true, confidence: null, mode: "split" };
  }
  if (total === 1) {
    return { winner: topCat, agreement: 1, counts, inconclusive: false, confidence: "low", mode: "single-judge" };
  }
  // ≥2 judges: a real majority needs ≥2 agreeing votes with no tie at the top.
  if (topN >= 2 && !tied) {
    const unanimous = topN === total;
    return {
      winner: topCat,
      agreement: topN / total,
      counts,
      inconclusive: false,
      confidence: unanimous ? "high" : "medium",
      mode: unanimous ? "unanimous" : "majority",
    };
  }
  // 1-1-1, or 1-1 on a 2-judge panel: no majority. The methodology calls this
  // inconclusive rather than picking one arbitrarily.
  return { winner: null, agreement: topN / total, counts, inconclusive: true, confidence: null, mode: "split" };
}

// ── continuous-rate aggregation (goal-titrate-judge-model-spec §9.1) ──────────
//
// For CONTINUOUS fields (a failure rate each judge assigns to the same corpus),
// the spec aggregates by MEDIAN, not majority: "three judges scoring 0.30 / 0.45 /
// 0.42 → median 0.42 is closer to truth than majority (no two agree exactly).
// Median is the standard ensemble-of-regressors aggregation" and is robust to one
// judge systematically over-/under-scoring. `spread` (max − min) surfaces judge
// disagreement on the aggregate rate — a wide spread on a headline rate is itself
// a judge-variance signal the caller can route on.

export interface RateTally {
  median: number; // the headline rate (robust to one outlier judge)
  mean: number;
  min: number;
  max: number;
  spread: number; // max − min; judge disagreement on the aggregate rate
  n: number; // number of judge rates that went into the tally
}

export function tallyRates(rates: number[]): RateTally {
  const xs = rates.filter((r) => Number.isFinite(r)).sort((a, b) => a - b);
  const n = xs.length;
  if (n === 0) return { median: 0, mean: 0, min: 0, max: 0, spread: 0, n: 0 };
  const mid = Math.floor(n / 2);
  const median = n % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const min = xs[0];
  const max = xs[n - 1];
  return { median, mean, min, max, spread: max - min, n };
}

// ── dissent detection for the reconsideration round (§9.6+) ───────────────────
//
// The reconsideration round (B3) triggers ONLY on an initial 3-judge 2-of-3 split
// — exactly one dissenter, a clear majority, all judges valid. NOT on 3-of-3
// unanimous (no dissent to reconsider), NOT on 1-1-1 (no majority; conservative
// inconclusive fallback), NOT on a 2-judge panel (no majority to re-prompt). This
// is the pure, offline-testable trigger gate; the judge re-prompting lives in
// classify.ts. Re-tallying after reconsideration is just `tallyCategorical` on the
// new vote set (dissenter's original + the majority's reconsidered votes).

export interface DissentSplit {
  eligible: boolean; // true iff a clean 2-of-3 split (one dissenter, clear majority) on a 3-judge panel
  winner: string | null; // the initial majority category
  majority: number[]; // indices of the majority voters (to re-prompt)
  dissenter: number | null; // index of the lone dissenter (kept fixed through reconsideration)
}

export function findDissent(votes: string[]): DissentSplit {
  const tally = tallyCategorical(votes);
  const eligible = votes.length === 3 && tally.mode === "majority" && !tally.inconclusive && tally.winner != null;
  if (!eligible) return { eligible: false, winner: tally.winner, majority: [], dissenter: null };
  const majority: number[] = [];
  let dissenter: number | null = null;
  votes.forEach((v, i) => (v === tally.winner ? majority.push(i) : (dissenter = i)));
  return { eligible: true, winner: tally.winner, majority, dissenter };
}

// ── rate-level dissent (the §9.6.future candidate, verify analog of findDissent) ─
//
// B3a reconsiders a CATEGORICAL 2-of-3 split (classify_failure). B3b extends the
// SAME "don't silently override a dissent" idea to verify's CONTINUOUS rates: the
// panel can agree on most individual rows (high per-row agreement) yet still have
// one judge whose AGGREGATE failure rate diverges systematically — the median/mean
// the verdict reports SMOOTHS that outlier away. findRateDissent is the numeric
// analog of findDissent: a clean 2-of-3 split where two judges' rates agree (within
// `tol`) and the third is an outlier (≥ `threshold` from the agreeing pair). Pure +
// offline-tested; the judge I/O (grading) stays in verify.ts. 3-judge only — like
// findDissent, a 2-judge panel has no majority-vs-lone-dissenter structure.

export interface RateDissent {
  eligible: boolean; // exactly one outlier among 3 judges (a clean numeric 2-of-3 split)
  majority: string[]; // the agreeing judges' ids
  dissenter: string | null; // the outlier judge's id
  majority_rate: number; // mean of the agreeing pair (0 when ineligible)
  dissenter_rate: number; // the outlier's rate (0 when ineligible)
  gap: number; // |dissenter_rate − majority_rate| (0 when ineligible)
}

export function findRateDissent(
  perJudge: { id: string; rate: number }[],
  tol = 0.1, // two judges "agree" when their rates are within this
  threshold = 0.2, // the outlier must sit at least this far from the agreeing pair's mean
): RateDissent {
  const none: RateDissent = { eligible: false, majority: [], dissenter: null, majority_rate: 0, dissenter_rate: 0, gap: 0 };
  const js = perJudge.filter((j) => Number.isFinite(j.rate));
  if (js.length !== 3) return none;
  // For each judge treated as the candidate outlier, the other two must agree (≤ tol)
  // and the candidate must be ≥ threshold from their mean. Eligible iff exactly one
  // judge satisfies this (a clean single dissenter; not 1-1-1 spread, not unanimous).
  const candidates: RateDissent[] = [];
  for (let k = 0; k < 3; k++) {
    const pair = js.filter((_, i) => i !== k);
    const out = js[k];
    const pairMean = (pair[0].rate + pair[1].rate) / 2;
    if (Math.abs(pair[0].rate - pair[1].rate) <= tol && Math.abs(out.rate - pairMean) >= threshold) {
      candidates.push({
        eligible: true,
        majority: pair.map((p) => p.id),
        dissenter: out.id,
        majority_rate: Number(pairMean.toFixed(4)),
        dissenter_rate: out.rate,
        gap: Number(Math.abs(out.rate - pairMean).toFixed(4)),
      });
    }
  }
  return candidates.length === 1 ? candidates[0] : none;
}

// Do the per-judge rates straddle a reference (e.g. the baseline failure rate) such
// that the SIGN of the change is judge-dependent — some judges see improvement, some
// regression? `margin` guards against a trivial straddle by a judge sitting on the
// reference. When this splits, no verdict can claim the candidate even moved the
// metric in a single direction → verify routes it to inconclusive (judge-variance).
// Works for any n ≥ 2 (unlike the 3-only findRateDissent).
export function ratesStraddle(
  rates: number[],
  reference: number,
  margin = 0,
): { split: boolean; below: number; above: number } {
  const xs = rates.filter((r) => Number.isFinite(r));
  const below = xs.filter((r) => r < reference - margin).length;
  const above = xs.filter((r) => r > reference + margin).length;
  return { split: below >= 1 && above >= 1, below, above };
}

// ── per-judge baseline calibration (B5b — the deferred 3rd §6 read) ────────────
//
// THE FIX for gotcha #14: verify's direction-split / rate-dissent detectors compare
// each judge's CANDIDATE rate to the single CONSENSUS baseline rate, so a
// systematically STRICTER judge (a higher baseline rate) reads as a "regressor"
// purely from that constant offset — a false split. calibratePerJudge removes the
// offset: for every judge present in BOTH the candidate panel and the persisted
// per-judge baseline rates (006), it computes that judge's CHANGE = candidate − that
// judge's OWN baseline rate. The caller (verify.ts) then runs the SAME `ratesStraddle`
// (against 0 — improvement is a negative delta) + `findRateDissent` on these deltas
// instead of on absolute candidate rates, so the detectors measure REAL per-judge
// sign disagreement on the change, not strictness bias.
//
// Pure + offline-tested (mirrors findRateDissent/findDissent — the judge & DB I/O
// stay in the caller). Eligibility needs ≥ 2 MATCHED judges (gotcha #8a: per-judge
// calibration still needs ≥ 2 judges to compute a split); below that — or against a
// legacy baseline with no persisted per-judge rates ('{}' → no matches) — eligible is
// false and verify FALLS BACK to the pre-B5b consensus-rate comparison (behavior
// preserved for every baseline frozen before 006). A judge in the baseline map but
// absent from the candidate panel (or vice versa) is simply not matched, never guessed.

export interface PerJudgeCalibration {
  eligible: boolean; // ≥ 2 judges had a persisted baseline rate to calibrate against
  deltas: { id: string; delta: number }[]; // candidate rate − that judge's OWN baseline rate (matched judges; negative = that judge improved)
  n_matched: number; // judges present in both the candidate panel and the baseline per-judge rates
}

export function calibratePerJudge(
  candidate: { id: string; rate: number }[],
  baselinePerJudge: Record<string, number>,
): PerJudgeCalibration {
  const deltas = candidate
    .filter((j) => Number.isFinite(j.rate) && Number.isFinite(baselinePerJudge[j.id]))
    .map((j) => ({ id: j.id, delta: Number((j.rate - baselinePerJudge[j.id]).toFixed(4)) }));
  return { eligible: deltas.length >= 2, deltas, n_matched: deltas.length };
}

// ── grading-integrity: distinct vendor-family accounting ───────────────────
//
// A numeric verdict needs >=2 DISTINCT vendor families among the judges involved —
// never merely >=2 judges. Two judges from the SAME family is not cross-vendor
// corroboration, even though a vote-count floor (panel-coverage-core.ts) cannot
// tell the difference: two canonical votes from one family clear a 2-vote
// corroboration floor without proving anything cross-vendor. Pure + offline-tested;
// verify.ts applies this at both the pre-call gate (resolvePanel: the RESOLVED
// panel needs >=2 distinct families before any judge is called) and the post-return
// gate (the RESPONDING judges need >=2 distinct families, or the outcome is
// panel-degraded — never a numeric verdict) per the frozen outcome table.
export function distinctFamilies(judges: { family: string }[]): number {
  return new Set(judges.map((j) => j.family)).size;
}
