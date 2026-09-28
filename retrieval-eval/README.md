# The Retrieval Gate — Retrieval-Quality Eval (`__base__`)

A regression gate over `cardSearch`. It answers **"did a retrieval change drop how well the right card is found?"** with a deterministic, structural metric — **no LLM judge, $0**.

## What it measures

- **recall@k** (k ∈ {1, 3, 5, 10}) — fraction of a query's ground-truth refs that appear in the top-k of `cardSearch`'s ranked results. `|expected ∩ top-k| / |expected|`, averaged over the query set.
- **MRR** (mean reciprocal rank) — `1 / (1-based rank of the first ranked ref that is a truth ref)`, averaged; `0` for a query that returns no truth ref.

"Is the right `card_ref` in the returned list / how high?" is a **structural** question, so strict ref-set intersection is valid authority (the strict-match-vs-semantic rule) — the metric is pure (`../lib/retrieval-metrics-core.ts`, offline-unit-tested), **never** an LLM judge. The runner (`run.ts`) does the live DB + embedding I/O and hands the pure core the ranked `card_ref` arrays.

## Files

| File | What |
| ---- | ---- |
| `base-queries.json` | the default **frozen** Base answer key — `{ tenant, search_k, k_values, queries: [{ id, query, expected, note }] }`. |
| `base-baseline.json` | the default Base metrics (`embed_model`, `captured_at_sha`, `captured_at`, `n`, `recall`, `mrr`). |
| `run.ts` | the live read-only runner + exit-code gate. |
| `../lib/retrieval-metrics-core.ts` | the PURE metric (`recallAtK` / `reciprocalRank` / `scoreCorpus` / `compareToBaseline`). |
| `../lib/__tests__/retrieval-metrics-core.test.ts` | the offline unit suite (38/38) pinning the metric. |

## How to add a query

1. Find a real card in the curated Base source (`docs/core-learnings/`) and in the `__base__` tenant. Note its `card_ref`.
2. Write `query` as a **real user question** — something a person would actually ask the knowledge graph.
3. **ANTI-LEAKAGE RULE (the #1 honesty risk):** phrase the question **lexically differently from the card's title and body.** A query that quotes the card text measures string overlap, not retrieval — it inflates the score dishonestly. Frame the *symptom* or the *decision*, not the card's own phrasing. (e.g. for "forbidden-token priming", ask "I keep telling the model NOT to use certain words and it uses them more — what's going on?", never "forbidden token priming".)
4. Set `expected` to the truth ref(s). A query may have **multiple** truth refs (a cluster) — a good retrieval surfaces them all (e.g. `q20`). Every `expected` ref MUST resolve via `cardGet` or the runner aborts loud (see below).
5. `search_k` must be ≥ `max(k_values)`; `cardSearch` clamps k to `[1, 25]`.
6. Adding/changing a truth ref **re-freezes the answer key** — re-run `-- --update-baseline` and re-confirm.

## How to run (the gate)

```bash
npm run retrieval:eval
```

The runner self-loads `.env` via its first import (`../server/bootstrap-env`) — no manual sourcing. It embeds the Base queries (read-only: `cardSearch` + `cardGet`, no DB write), scores them, prints a recall@k/MRR scorecard with per-metric deltas vs `base-baseline.json`, and:

- **exits `0`** when no metric dropped below `baseline − tolerance` (tolerance `0.0001`, absorbing embedding noise),
- **exits `1`** (the gate fires) when any recall@k or MRR regressed, OR an `expected` ref no longer resolves (answer-key drift), OR `search_k < max(k_values)`.

Wire it as a regression gate after any change that touches retrieval (`cardSearch`, the embed model, ranking).

## How to update the baseline

```bash
npm run retrieval:eval -- --update-baseline
```

Re-writes `base-baseline.json` (stamping the live `EMBED_MODEL`, short HEAD sha, and date) and exits `0`. **Only run this on an INTENTIONAL retrieval change** — a deliberate `cardSearch`/ranking improvement, embed-model swap, or a deliberate Base-corpus migration — never to silence a regression. The committed `base-baseline.json` is the moving floor; raising it is a conscious act, re-confirmed against the answer key.

## How to read the gate

- **exit 0** = retrieval held (no metric below the tolerance band). Ship.
- **exit 1** = a regression (a metric dropped) OR answer-key drift (an `expected` ref vanished/renamed — re-ingest or fix the active query file, normally `base-queries.json`) OR a config error (`search_k` too small). Read the printed `status` column / the `console.error` line; do NOT ship until it's green or you've intentionally re-baselined.

## Scope / non-goals

The gate covers the curated `__base__` methodology. The metric **measures** `cardSearch` as-is — it does not modify it. No DB writes; the sole artifact write is the committed git-tracked baseline. The 20 Base queries are a directional v1 signal — grow the set deliberately; a single query flip moves recall a few points.
