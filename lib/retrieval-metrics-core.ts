// Titration MCP — retrieval gate metric core: PURE recall@k / MRR / baseline-compare.
//
// This is the structural-match metric for evaluating
// `cardSearch` retrieval against a labeled `{query -> expected card_ref(s)}` answer key. "Is the
// right ref in the returned list / how high?" is a STRUCTURAL question (T-MET-001's strict-match
// authority), so the metric is deterministic ref-set intersection — NO LLM judge, $0, free.
//
// Mirrors the house pure-core discipline of propose-core.ts EXACTLY:
//   • NO imports of store/embed/network/model — ranked ref-lists are passed IN; the I/O layer
//     (retrieval-eval/run.ts) does the embedding + cardSearch + cardGet and hands this pure math
//     the ranked card_ref arrays. This module is offline-unit-testable without a DB or a key.
//   • Fail-loud on a structurally-invalid input (a query with no truth ref): recallAtK THROWS on
//     an empty `expected` — a query MUST have >=1 ground-truth ref, an empty one is a corpus bug,
//     not a 0/0 to silently average in.
//   • No Date.now()/randomness/clock — pure functions only (the date/sha stamps live in run.ts).

// The per-run metric figure: recall@k for each evaluated k + MRR over the corpus.
export interface Scorecard {
  n: number; // number of cases scored
  recall: Record<number, number>; // recall@k keyed by k (e.g. { 1: 0.4, 3: 0.6, 5: 0.7, 10: 0.8 })
  mrr: number; // mean reciprocal rank over the corpus
}

// The regression-gate comparison: a row per metric (each recall@k + mrr); `regressed` drives the
// runner exit code. `failed` is per-metric (current dropped below baseline - tolerance).
//
// `corpusShrank` is a SEPARATE failure axis from `regressed`, and the runner must gate on both.
// Every metric here is a MEAN over n cases, so dropping a case that the retriever got wrong raises
// the mean — a shrinking corpus reports an IMPROVEMENT while measuring less. That is the cheap
// version of the `--update-baseline` cheat the constitution already forbids: the answer key is
// frozen, so the only honest way for n to change is an intentional, documented corpus edit.
export interface BaselineCmp {
  regressed: boolean;
  corpusShrank: boolean;
  corpus: { baseline: number; current: number };
  rows: { metric: string; baseline: number; current: number; delta: number; failed: boolean }[];
}

// recall@k = |expected ∩ set(ranked[0..k))| / |expected|.
// Throws on an empty `expected` — a query must carry >=1 ground-truth ref; an empty truth set is a
// corpus bug (a silent 0/0 would poison the mean), so fail loud rather than fabricate a figure.
export function recallAtK(ranked: string[], expected: string[], k: number): number {
  if (expected.length === 0) {
    throw new Error("recallAtK: `expected` is empty — every query must have at least one truth ref");
  }
  const topK = new Set(ranked.slice(0, k));
  let hits = 0;
  for (const ref of expected) {
    if (topK.has(ref)) hits++;
  }
  return hits / expected.length;
}

// Reciprocal rank = 1 / (1-based rank of the FIRST ranked item that is in `expected`); 0 if none hit.
export function reciprocalRank(ranked: string[], expected: string[]): number {
  const expectedSet = new Set(expected);
  for (let i = 0; i < ranked.length; i++) {
    if (expectedSet.has(ranked[i])) {
      return 1 / (i + 1); // 1-based rank
    }
  }
  return 0;
}

// Mean over cases: recall@k computed for EACH k in `ks` (averaged across cases) + mean reciprocal
// rank. Empty corpus → n=0, every recall 0, mrr 0 (the caller/runner decides whether 0 cases is an
// error; this pure function does not throw on an empty corpus, only recallAtK throws on empty truth).
export function scoreCorpus(
  cases: { expected: string[]; ranked: string[] }[],
  ks: number[],
): Scorecard {
  const n = cases.length;
  const recall: Record<number, number> = {};

  for (const k of ks) {
    let sum = 0;
    for (const c of cases) {
      sum += recallAtK(c.ranked, c.expected, k);
    }
    recall[k] = n === 0 ? 0 : sum / n;
  }

  let rrSum = 0;
  for (const c of cases) {
    rrSum += reciprocalRank(c.ranked, c.expected);
  }
  const mrr = n === 0 ? 0 : rrSum / n;

  return { n, recall, mrr };
}

// Compare a current scorecard to a committed baseline. One row per metric (each recall@k present in
// the baseline + mrr). `failed = current < baseline - tolerance` — the tolerance absorbs embedding
// nondeterminism so a noise dip is not a false regression. `regressed = rows.some(r => r.failed)`
// drives the runner's exit code (the regression gate).
export function compareToBaseline(
  current: Scorecard,
  baseline: Scorecard,
  tolerance = 0,
): BaselineCmp {
  const rows: BaselineCmp["rows"] = [];

  // A row per recall@k present in the baseline (the baseline defines which k's the gate covers).
  const baselineKs = Object.keys(baseline.recall)
    .map((k) => Number(k))
    .sort((a, b) => a - b);

  for (const k of baselineKs) {
    const baseValue = baseline.recall[k];
    const currentValue = current.recall[k] ?? 0;
    rows.push(buildRow(`recall@${k}`, baseValue, currentValue, tolerance));
  }

  rows.push(buildRow("mrr", baseline.mrr, current.mrr, tolerance));

  const regressed = rows.some((r) => r.failed);
  // Kept off `regressed` on purpose: "a metric dropped" and "the corpus got smaller" are different
  // diagnoses and the runner prints them differently. Both must fail the gate.
  const corpusShrank = current.n < baseline.n;
  return { regressed, corpusShrank, corpus: { baseline: baseline.n, current: current.n }, rows };
}

// One comparison row: delta = current - baseline; failed when current dropped below the tolerance band.
function buildRow(
  metric: string,
  baseline: number,
  current: number,
  tolerance: number,
): BaselineCmp["rows"][number] {
  const delta = current - baseline;
  const failed = current < baseline - tolerance;
  return { metric, baseline, current, delta, failed };
}
