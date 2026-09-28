// Titration MCP — rate-level dissent unit test (no network, no judges).
// Pins the pure B3b §9.6.future logic (findRateDissent + ratesStraddle) that verify
// runs after grading: the numeric analog of findDissent (one judge's aggregate rate
// is an outlier) + the direction-split detector (judges disagree on the SIGN of the
// change). The judge I/O (grading) stays in verify.ts, so this is deterministic.
// Run: npx tsx lib/__tests__/rate-dissent.test.ts

import { findRateDissent, ratesStraddle, calibratePerJudge } from "../consensus";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}

const J = (id: string, rate: number) => ({ id, rate });

// ── findRateDissent (3-judge, a clean numeric 2-of-3 split) ───────────────────
{
  // two judges agree (~0.11), one outlier at 0.70 → eligible, dissenter is the outlier.
  const r = findRateDissent([J("grok", 0.1), J("gpt", 0.12), J("deepseek", 0.7)]);
  check(
    "clean outlier → eligible, correct dissenter + gap",
    r.eligible && r.dissenter === "deepseek" && r.majority.includes("grok") && r.majority.includes("gpt") &&
      Math.abs(r.majority_rate - 0.11) < 1e-9 && Math.abs(r.gap - 0.59) < 1e-9,
    JSON.stringify(r),
  );
}
{
  // all three close → no outlier ≥ threshold → not eligible.
  const r = findRateDissent([J("a", 0.3), J("b", 0.32), J("c", 0.35)]);
  check("unanimous-ish → not eligible", !r.eligible, JSON.stringify(r));
}
{
  // 1-1-1 numeric spread, no agreeing pair within tol → not eligible.
  const r = findRateDissent([J("a", 0.1), J("b", 0.45), J("c", 0.85)]);
  check("1-1-1 spread → not eligible", !r.eligible, JSON.stringify(r));
}
{
  // outlier below the gap threshold (0.14 < 0.20) → not eligible.
  const r = findRateDissent([J("a", 0.3), J("b", 0.32), J("c", 0.45)]);
  check("outlier inside the gap → not eligible", !r.eligible, JSON.stringify(r));
}
{
  // boundary: agreeing pair at 0.30, outlier exactly 0.20 away → eligible (inclusive).
  const r = findRateDissent([J("a", 0.3), J("b", 0.3), J("c", 0.5)]);
  check("outlier exactly at the threshold → eligible", r.eligible && r.dissenter === "c", JSON.stringify(r));
}
{
  // 2-judge panel has no majority-vs-dissenter structure → never eligible.
  const r = findRateDissent([J("a", 0.1), J("b", 0.8)]);
  check("2 judges → not eligible (3-only, like findDissent)", !r.eligible, JSON.stringify(r));
}
{
  const r = findRateDissent([J("a", 0.1), J("b", 0.1), J("c", 0.1), J("d", 0.9)]);
  check("4 judges → not eligible (3-only)", !r.eligible, JSON.stringify(r));
}

// ── ratesStraddle (direction split — judges disagree on the SIGN vs baseline) ──
{
  const s = ratesStraddle([0.1, 0.2, 0.7], 0.5, 0.05);
  check("two below + one above baseline → split", s.split && s.below === 2 && s.above === 1, JSON.stringify(s));
}
{
  const s = ratesStraddle([0.1, 0.0, 0.05], 0.5, 0.05);
  check("all below baseline (unanimous improvement) → no split", !s.split, JSON.stringify(s));
}
{
  const s = ratesStraddle([0.6, 0.7], 0.5, 0.05);
  check("all above baseline (unanimous regression) → no split", !s.split, JSON.stringify(s));
}
{
  const s = ratesStraddle([0.49, 0.51], 0.5, 0.05);
  check("both within the margin of baseline → no split", !s.split, JSON.stringify(s));
}
{
  const s = ratesStraddle([0.4, 0.6], 0.5, 0.05);
  check("one clearly below + one clearly above → split", s.split && s.below === 1 && s.above === 1, JSON.stringify(s));
}

// ── calibratePerJudge (B5b — remove each judge's strictness offset) ───────────
{
  // matched deltas computed per judge: candidate − that judge's own baseline.
  const c = calibratePerJudge([J("grok", 0.3), J("deepseek", 0.7)], { grok: 0.5, deepseek: 0.9 });
  check(
    "matched judges → per-judge deltas (candidate − own baseline)",
    c.eligible && c.n_matched === 2 &&
      Math.abs((c.deltas.find((d) => d.id === "grok")?.delta ?? NaN) - -0.2) < 1e-9 &&
      Math.abs((c.deltas.find((d) => d.id === "deepseek")?.delta ?? NaN) - -0.2) < 1e-9,
    JSON.stringify(c),
  );
}
{
  // THE B5b FIX: a systematically STRICTER judge (deepseek baseline 0.9 vs 0.5) that
  // also improved no longer manufactures a false direction split. Uncalibrated, its
  // candidate 0.7 sits ABOVE the consensus baseline 0.5 → false "regression" split;
  // calibrated, every judge's delta is −0.2 (all improved) → no split.
  const baselinePJ = { grok: 0.5, gpt: 0.5, deepseek: 0.9 };
  const candidate = [J("grok", 0.3), J("gpt", 0.3), J("deepseek", 0.7)];
  const calib = calibratePerJudge(candidate, baselinePJ);
  const uncalibrated = ratesStraddle(candidate.map((j) => j.rate), 0.5, 0.05); // vs consensus baseline
  const calibrated = ratesStraddle(calib.deltas.map((d) => d.delta), 0, 0.05); // vs 0 (deltas)
  check(
    "calibration removes the stricter-judge false direction split",
    calib.eligible && uncalibrated.split === true && calibrated.split === false,
    JSON.stringify({ deltas: calib.deltas, uncalibrated, calibrated }),
  );
}
{
  // A GENUINE per-judge sign disagreement on the change survives calibration: two
  // judges improved (−0.3), one regressed (+0.3) vs their (equal) own baselines.
  const baselinePJ = { grok: 0.5, gpt: 0.5, deepseek: 0.5 };
  const calib = calibratePerJudge([J("grok", 0.2), J("gpt", 0.2), J("deepseek", 0.8)], baselinePJ);
  const split = ratesStraddle(calib.deltas.map((d) => d.delta), 0, 0.05);
  check("a real per-judge sign disagreement survives calibration", calib.eligible && split.split, JSON.stringify({ deltas: calib.deltas, split }));
}
{
  // < 2 matched judges → not eligible → verify falls back to the consensus-rate path.
  const c = calibratePerJudge([J("grok", 0.3), J("gpt", 0.3)], { grok: 0.5 });
  check("only 1 matched judge → not eligible (fallback)", !c.eligible && c.n_matched === 1, JSON.stringify(c));
}
{
  // legacy baseline (frozen before 006) has empty per_judge → no matches → fallback.
  const c = calibratePerJudge([J("grok", 0.3), J("gpt", 0.3)], {});
  check("legacy empty baseline per_judge → not eligible (fallback)", !c.eligible && c.n_matched === 0, JSON.stringify(c));
}
{
  // a judge present in the baseline but absent from the candidate panel is ignored,
  // not guessed; the two matched judges still calibrate.
  const c = calibratePerJudge([J("grok", 0.3), J("gpt", 0.3)], { grok: 0.5, gpt: 0.5, deepseek: 0.9 });
  check("unmatched baseline judge ignored; matched pair calibrates", c.eligible && c.n_matched === 2, JSON.stringify(c));
}
{
  // a non-finite candidate or baseline rate for a judge drops that judge from the match.
  const c = calibratePerJudge([J("grok", NaN), J("gpt", 0.3), J("deepseek", 0.4)], { grok: 0.5, gpt: 0.5, deepseek: 0.5 });
  check("non-finite rate drops that judge from the match", c.eligible && c.n_matched === 2 && !c.deltas.some((d) => d.id === "grok"), JSON.stringify(c));
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
