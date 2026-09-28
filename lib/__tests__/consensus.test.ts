// Titration MCP — consensus tally unit test (no network, no judges).
// Pins the categorical-verdict semantics (goal-titrate-judge-model-spec §9.1–9.2)
// that B1 returns and B2/B3 build on. Run: npx tsx lib/__tests__/consensus.test.ts

import { tallyCategorical, tallyRates, findDissent } from "../consensus";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}

// 3-of-3 unanimous → high confidence, not inconclusive
{
  const t = tallyCategorical(["formatter", "formatter", "formatter"]);
  check("3-0 unanimous", t.winner === "formatter" && t.mode === "unanimous" && t.confidence === "high" && !t.inconclusive && t.agreement === 1, JSON.stringify(t));
}

// 2-of-3 majority → medium confidence, winner is the majority, dissent exists
{
  const t = tallyCategorical(["system-under-test", "system-under-test", "corpus-gap"]);
  check("2-1 majority", t.winner === "system-under-test" && t.mode === "majority" && t.confidence === "medium" && !t.inconclusive && Math.abs(t.agreement - 2 / 3) < 1e-9, JSON.stringify(t));
}

// 1-1-1 split → no majority → inconclusive (never a guess)
{
  const t = tallyCategorical(["formatter", "corpus-gap", "judge-variance"]);
  check("1-1-1 split → inconclusive", t.winner === null && t.mode === "split" && t.inconclusive && t.confidence === null, JSON.stringify(t));
}

// 2-judge panel, both agree → high, unanimous
{
  const t = tallyCategorical(["formatter", "formatter"]);
  check("2-0 agree", t.winner === "formatter" && t.mode === "unanimous" && t.confidence === "high" && !t.inconclusive, JSON.stringify(t));
}

// 2-judge panel, disagree (1-1) → inconclusive
{
  const t = tallyCategorical(["formatter", "corpus-gap"]);
  check("1-1 two-judge split → inconclusive", t.winner === null && t.inconclusive && t.confidence === null, JSON.stringify(t));
}

// single judge → its vote stands but flagged low-confidence single-judge
{
  const t = tallyCategorical(["system-under-test"]);
  check("single judge", t.winner === "system-under-test" && t.mode === "single-judge" && t.confidence === "low" && !t.inconclusive, JSON.stringify(t));
}

// empty → inconclusive (defensive)
{
  const t = tallyCategorical([]);
  check("empty → inconclusive", t.winner === null && t.inconclusive, JSON.stringify(t));
}

// ── tallyRates (continuous-rate median aggregation, §9.1) ─────────────────────

// odd count → middle value; spread = max − min; robust to one outlier judge
{
  const t = tallyRates([0.3, 0.45, 0.42]);
  check("rates median (odd)", t.median === 0.42 && t.n === 3 && Math.abs(t.spread - 0.15) < 1e-9 && t.min === 0.3 && t.max === 0.45, JSON.stringify(t));
}

// median is robust: one judge wildly off doesn't drag the headline like the mean would
{
  const t = tallyRates([0.4, 0.42, 0.95]);
  check("rates median resists outlier", t.median === 0.42 && Math.abs(t.mean - 0.59) < 1e-9, JSON.stringify(t));
}

// even count → average of the two middle values
{
  const t = tallyRates([0.2, 0.4, 0.6, 0.8]);
  check("rates median (even)", Math.abs(t.median - 0.5) < 1e-9 && t.n === 4, JSON.stringify(t));
}

// single rate → that rate, zero spread
{
  const t = tallyRates([0.33]);
  check("rates single", t.median === 0.33 && t.spread === 0 && t.n === 1, JSON.stringify(t));
}

// empty / all-NaN → zeros, n=0 (defensive; caller treats n=0 as no rate)
{
  const t = tallyRates([]);
  check("rates empty", t.n === 0 && t.median === 0 && t.spread === 0, JSON.stringify(t));
}

// ── findDissent (reconsideration trigger gate, §9.6+) ─────────────────────────

// 2-of-3 split → eligible; dissenter + majority indices identified
{
  const d = findDissent(["system-under-test", "system-under-test", "corpus-gap"]);
  check("dissent 2-1 eligible", d.eligible && d.winner === "system-under-test" && d.dissenter === 2 && d.majority.length === 2 && d.majority.includes(0) && d.majority.includes(1), JSON.stringify(d));
}

// dissenter in any position is found (not just last)
{
  const d = findDissent(["corpus-gap", "system-under-test", "system-under-test"]);
  check("dissent 2-1 dissenter-first", d.eligible && d.winner === "system-under-test" && d.dissenter === 0, JSON.stringify(d));
}

// 3-0 unanimous → NOT eligible (no dissent to reconsider)
{
  const d = findDissent(["formatter", "formatter", "formatter"]);
  check("dissent unanimous → not eligible", !d.eligible && d.dissenter === null, JSON.stringify(d));
}

// 1-1-1 → NOT eligible (no majority; conservative inconclusive fallback)
{
  const d = findDissent(["formatter", "corpus-gap", "judge-variance"]);
  check("dissent 1-1-1 → not eligible", !d.eligible && d.majority.length === 0, JSON.stringify(d));
}

// 2-judge panel → NOT eligible (no third judge to form a re-promptable majority)
{
  const d = findDissent(["formatter", "corpus-gap"]);
  check("dissent 2-judge → not eligible", !d.eligible, JSON.stringify(d));
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
