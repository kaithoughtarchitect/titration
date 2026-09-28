// Titration MCP — retrieval gate metrics-core unit test (no network, no DB, no model).
// Pins the PURE structural-match metric the live runner routes on: recall@k (hit/miss, k>len,
// multi-ref partial recall), MRR (rank-1 / rank-3 / no-hit=0), scoreCorpus averaging across cases,
// compareToBaseline (equal => no-regression, a drop => regressed, a within-tolerance dip absorbed),
// and recallAtK's fail-loud throw on an empty `expected`. retrieval-eval/run.ts snapshots these
// specs against live cardSearch output. Mirrors propose-core.test.ts (check/total/failures harness).
// Run: npx tsx lib/__tests__/retrieval-metrics-core.test.ts

import {
  recallAtK,
  reciprocalRank,
  scoreCorpus,
  compareToBaseline,
  type Scorecard,
} from "../retrieval-metrics-core";

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
// Float-tolerant equality (recall/MRR are fractions like 1/3).
function near(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}

// ── recallAtK: single-ref hit / miss ─────────────────────────────────────────────
check("recall@1 hit (expected ref is rank 1)", recallAtK(["T-MET-001", "T-MET-002"], ["T-MET-001"], 1) === 1);
check("recall@1 miss (expected ref is rank 2, outside top-1)", recallAtK(["T-MET-002", "T-MET-001"], ["T-MET-001"], 1) === 0);
check("recall@3 hit (expected ref at rank 3, inside top-3)", recallAtK(["a", "b", "T-MET-001"], ["T-MET-001"], 3) === 1);
check("recall@3 miss (expected ref at rank 4, outside top-3)", recallAtK(["a", "b", "c", "T-MET-001"], ["T-MET-001"], 3) === 0);

// ── recallAtK: k larger than the ranked list (no out-of-bounds inflation) ─────────
check("recall@k with k>len(ranked) hit (slice clamps safely)", recallAtK(["T-MET-001", "T-MET-002"], ["T-MET-002"], 10) === 1);
check("recall@k with k>len(ranked) miss (ref simply not present)", recallAtK(["T-MET-001", "T-MET-002"], ["T-MET-099"], 10) === 0);

// ── recallAtK: multi-ref partial recall ──────────────────────────────────────────
check("multi-ref partial recall = 2/3 (two of three expected in top-k)",
  near(recallAtK(["T-MET-001", "T-MET-002", "x", "y"], ["T-MET-001", "T-MET-002", "T-MET-003"], 5), 2 / 3));
check("multi-ref full recall = 3/3 (all three expected in top-k)",
  recallAtK(["T-MET-001", "T-MET-002", "T-MET-003"], ["T-MET-001", "T-MET-002", "T-MET-003"], 5) === 1);
check("multi-ref zero recall = 0/2 (neither expected ref present)",
  recallAtK(["a", "b", "c"], ["T-MET-001", "T-MET-002"], 5) === 0);
check("multi-ref partial recall respects k window = 1/2 (second expected ref outside top-2)",
  near(recallAtK(["T-MET-001", "z", "T-MET-002"], ["T-MET-001", "T-MET-002"], 2), 1 / 2));

// ── recallAtK: fail-loud throw on empty expected ──────────────────────────────────
check("recallAtK THROWS on empty expected (query must have >=1 truth ref)",
  throws(() => recallAtK(["a", "b"], [], 5)) !== null);
check("recallAtK throw message names the empty-expected cause",
  /empty/i.test(throws(() => recallAtK(["a"], [], 1)) ?? ""));

// ── reciprocalRank: rank-1 / rank-3 / no-hit=0 ────────────────────────────────────
check("MRR rank-1 => 1.0 (first ranked item is the expected ref)", reciprocalRank(["T-MET-001", "b", "c"], ["T-MET-001"]) === 1);
check("MRR rank-3 => 1/3 (first hit is at 1-based rank 3)", near(reciprocalRank(["a", "b", "T-MET-001"], ["T-MET-001"]), 1 / 3));
check("MRR rank-2 => 1/2", near(reciprocalRank(["a", "T-MET-001", "c"], ["T-MET-001"]), 1 / 2));
check("MRR no-hit => 0 (no expected ref anywhere in the ranked list)", reciprocalRank(["a", "b", "c"], ["T-MET-001"]) === 0);
check("MRR multi-ref uses the FIRST hit's rank (earlier of two expected)",
  near(reciprocalRank(["a", "T-MET-002", "T-MET-001"], ["T-MET-001", "T-MET-002"]), 1 / 2));

// ── scoreCorpus: averaging across >=3 cases ───────────────────────────────────────
// Case A: hit at rank 1 (recall@1=1, recall@3=1, rr=1)
// Case B: hit at rank 3 (recall@1=0, recall@3=1, rr=1/3)
// Case C: no hit       (recall@1=0, recall@3=0, rr=0)
const corpus = [
  { ranked: ["T-MET-001", "x", "y"], expected: ["T-MET-001"] },
  { ranked: ["x", "y", "T-MET-002"], expected: ["T-MET-002"] },
  { ranked: ["x", "y", "z"], expected: ["T-MET-003"] },
];
const sc: Scorecard = scoreCorpus(corpus, [1, 3]);
check("scoreCorpus n counts cases (3)", sc.n === 3);
check("scoreCorpus recall@1 averages to 1/3 (1 of 3 hit at rank 1)", near(sc.recall[1], 1 / 3));
check("scoreCorpus recall@3 averages to 2/3 (2 of 3 hit within top-3)", near(sc.recall[3], 2 / 3));
check("scoreCorpus mrr averages (1 + 1/3 + 0)/3 = 4/9", near(sc.mrr, (1 + 1 / 3 + 0) / 3));
check("scoreCorpus emits one recall figure per requested k", Object.keys(sc.recall).length === 2);

// scoreCorpus over a 4th k that exceeds list length still computes (no throw)
const sc4 = scoreCorpus(corpus, [1, 3, 5, 10]);
check("scoreCorpus handles k>len cases (recall@10 = 2/3, same hits)", near(sc4.recall[10], 2 / 3));
check("scoreCorpus emits all four k figures", Object.keys(sc4.recall).length === 4);

// ── compareToBaseline: equal => no regression ─────────────────────────────────────
const baseline: Scorecard = { n: 3, recall: { 1: 0.5, 3: 0.7, 5: 0.8 }, mrr: 0.6 };
const equalCmp = compareToBaseline({ n: 3, recall: { 1: 0.5, 3: 0.7, 5: 0.8 }, mrr: 0.6 }, baseline);
check("compareToBaseline equal => not regressed", equalCmp.regressed === false);
check("compareToBaseline emits a row per baseline metric (3 recall + mrr = 4)", equalCmp.rows.length === 4);
check("compareToBaseline equal => every row delta 0, none failed", equalCmp.rows.every((r) => r.delta === 0 && !r.failed));

// ── compareToBaseline: an improvement is never a regression ────────────────────────
const upCmp = compareToBaseline({ n: 3, recall: { 1: 0.6, 3: 0.8, 5: 0.9 }, mrr: 0.7 }, baseline);
check("compareToBaseline improvement => not regressed", upCmp.regressed === false);
check("compareToBaseline improvement => positive deltas", upCmp.rows.every((r) => r.delta > 0));

// ── compareToBaseline: a drop on ANY metric => regressed ───────────────────────────
const dropCmp = compareToBaseline({ n: 3, recall: { 1: 0.5, 3: 0.6, 5: 0.8 }, mrr: 0.6 }, baseline);
check("compareToBaseline a recall@3 drop => regressed true", dropCmp.regressed === true);
check("compareToBaseline marks ONLY the dropped metric failed", dropCmp.rows.filter((r) => r.failed).length === 1);
check("compareToBaseline the failed row is recall@3", dropCmp.rows.find((r) => r.failed)!.metric === "recall@3");

const mrrDropCmp = compareToBaseline({ n: 3, recall: { 1: 0.5, 3: 0.7, 5: 0.8 }, mrr: 0.4 }, baseline);
check("compareToBaseline an mrr drop => regressed true", mrrDropCmp.regressed === true);
check("compareToBaseline the failed row is mrr", mrrDropCmp.rows.find((r) => r.failed)!.metric === "mrr");

// ── compareToBaseline: tolerance absorbs a within-band dip ─────────────────────────
// current recall@3 = 0.68, baseline 0.70, tolerance 0.05 => 0.68 >= 0.70 - 0.05 = 0.65 => not failed
const tolCmp = compareToBaseline({ n: 3, recall: { 1: 0.5, 3: 0.68, 5: 0.8 }, mrr: 0.6 }, baseline, 0.05);
check("compareToBaseline within-tolerance dip => not regressed", tolCmp.regressed === false);

// ── compareToBaseline: corpus shrink is its own failure axis ───────────────────────
// The gamed case: drop the query the retriever got WRONG and every mean rises. Before the corpus
// check existed this returned regressed=false and the gate passed green on a smaller corpus.
const shrunkImprovedCmp = compareToBaseline({ n: 2, recall: { 1: 0.9, 3: 0.95, 5: 1 }, mrr: 0.92 }, baseline);
check("compareToBaseline shrunken corpus => corpusShrank true", shrunkImprovedCmp.corpusShrank === true);
check("compareToBaseline shrunken-but-improved => no metric row fails", shrunkImprovedCmp.rows.every((r) => !r.failed));
check("compareToBaseline shrunken-but-improved => regressed stays false (separate axis)", shrunkImprovedCmp.regressed === false);
check("compareToBaseline reports both corpus sizes", shrunkImprovedCmp.corpus.baseline === 3 && shrunkImprovedCmp.corpus.current === 2);

check("compareToBaseline equal n => corpusShrank false", equalCmp.corpusShrank === false);
const grownCmp = compareToBaseline({ n: 5, recall: { 1: 0.5, 3: 0.7, 5: 0.8 }, mrr: 0.6 }, baseline);
check("compareToBaseline a GROWN corpus is not a shrink", grownCmp.corpusShrank === false);
check("compareToBaseline grown corpus still compares metrics normally", grownCmp.regressed === false);
check("compareToBaseline within-tolerance dip => recall@3 row not failed", tolCmp.rows.find((r) => r.metric === "recall@3")!.failed === false);

// a dip BEYOND tolerance still fails: current 0.60, baseline 0.70, tol 0.05 => 0.60 < 0.65 => failed
const tolExceedCmp = compareToBaseline({ n: 3, recall: { 1: 0.5, 3: 0.6, 5: 0.8 }, mrr: 0.6 }, baseline, 0.05);
check("compareToBaseline a dip beyond tolerance => still regressed", tolExceedCmp.regressed === true);
check("compareToBaseline the beyond-tolerance failed row is recall@3", tolExceedCmp.rows.find((r) => r.failed)!.metric === "recall@3");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${total - failures}/${total}`);
process.exit(failures === 0 ? 0 : 1);
