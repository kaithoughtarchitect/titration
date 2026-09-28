# Contributing to Titration

Titration is a self-hosted MCP "referee + memory" for AI coding agents. This
file covers dev setup, the gates a PR must pass, the code rules the codebase
follows, and how to propose a new curated learning.

## Dev setup

Requirements: Node >= 22.11 (see `engines` in `package.json`) and Docker (for
a disposable local Postgres + pgvector).

```bash
git clone https://github.com/kaithoughtarchitect/titration.git
cd titration
npm install
cp .env.example .env            # fill in TITRATION_DATABASE_URL if you change the default
docker compose up -d            # starts pgvector/pgvector:pg17 on localhost:5432
npm run setup                   # migrate -> ingest the curated base -> embed (if OPENROUTER_API_KEY is set)
```

## Gates — run before every PR

| Command | What it proves |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` over `lib/`, `server/`, `ingest/`, `query/`, `scripts/`, `retrieval-eval/` (`moduleResolution: bundler` — see `tsconfig.json`; do not switch this to `nodenext`, it breaks the codebase's import style). |
| `npm test` | The offline unit suite (`lib/__tests__/*.test.ts`, run one-by-one under `tsx` by `run-tests.mjs`; each file drives a small hand-rolled `check(name, condition, detail)` harness, not Jest/Vitest) plus the import-graph check (`scripts/import-graph-check.mjs`), which walks every relative import reachable from the entry points and fails on a missing, outside-tree, or denied edge. |
| `npx tsx scripts/smoke-schema.ts` | Live DB smoke against a real `TITRATION_DATABASE_URL`: applying the migration twice is a no-op, both seed tenants exist, a card round-trips with a `NULL` embedding. |
| `npx tsx scripts/smoke-projects.ts` | Live DB smoke for project(tenant)-scoped reads/writes and the base-merge read path. |
| `npx tsx scripts/smoke-evolution.ts` | Live DB smoke for local evolution-capture (change-note) writes. |
| `npx tsx scripts/smoke-jobs.ts` | Live DB smoke for local job execution (start, poll, fail, cleanup). |
| `npm run retrieval:eval` | The retrieval-quality regression gate over `cardSearch` — recall@k / MRR against the frozen `retrieval-eval/base-queries.json` answer key. Needs `OPENROUTER_API_KEY` (it embeds the query set); if you don't have a key, say so in the PR and a maintainer will run it. |

The four `smoke-*.ts` scripts are **not** part of `npm test` — they need a real
Postgres, so run them directly against the compose database after
`npm run migrate` (or `npm run setup`) has applied the schema. `smoke-projects.ts`,
`smoke-evolution.ts`, and `smoke-jobs.ts` remove `OPENROUTER_API_KEY` from
their own process before they start, even when `.env` sets it: every path they
exercise is embedding-free by construction, and without a key a stray provider
call fails the smoke instead of spending.

Run every gate with full output. Never pipe a typecheck or test run through
`| tail` — the first error is the one that matters.

## Code rules

- **Pure-core / I-O split.** `lib/X-core.ts` holds pure logic only — no DB, no
  network, no filesystem — and gets an offline unit test in
  `lib/__tests__/`. `lib/X.ts` holds the store/embed/judge I/O that calls into
  it. Mirror this split for new modules: don't put I/O in a `-core.ts` file,
  and don't put logic that should be unit-testable in a plain `.ts` file that
  can't run offline.
- **No `Date.now()` / `Math.random()` inside a `*-core.ts` file.** Pass `now`
  and any seed in as an argument from the caller. A core that reaches for
  wall-clock time or entropy directly can't be tested deterministically
  offline.
- **postgres-js traps** (this project talks to Postgres through the
  `postgres` package directly, not an ORM):
  - Vectors: `toVec(arr)` + `` `${qv}::vector` `` — never bind a raw JS array
    as a vector parameter.
  - jsonb writes: `` `${sql.json(obj)}` `` — never
    `` `${JSON.stringify(obj)}::jsonb` `` (that double-encodes to a string).
  - jsonb reads: wrap in a defensive try/catch; if a row comes back as a
    string instead of an object, parse it carefully and fail open to the raw
    string — a bare `JSON.parse` inside a list mapper takes down the whole
    list on one bad row.
  - UUID columns (e.g. `from_card_id` / `to_card_id`): never bind a JS array
    directly to one — fetch the candidates and filter in JS instead.

## Grading laws — do not weaken these without discussion first

The verdict engine (`verify`, `goal_titrate`, `flywheel`) exists to referee an
AI agent's work, so its own honesty is the product. A PR touching
`lib/consensus.ts`, `lib/judge.ts`, `lib/verify.ts`, `lib/goal-titrate.ts`, or
`lib/flywheel*.ts` must preserve these invariants:

- **Verdict inputs are the declared outputs plus the frozen rubric, and
  nothing else.** Grading never reads back the pushed prompt, trace, or
  corpus case — only the fields the caller actually declared as outputs.
  Richer context can be surfaced to a human as evidence; it must never be fed
  into the grading call itself.
- **Knowledge-graph cards are advisory-only.** They may be shown to a human
  next to a verdict; they must never enter a grading prompt or change a
  numeric verdict.
- **A numeric verdict needs at least two judges from distinct vendor
  *families* — never merely two judges.** Two judges from the same family
  (e.g. two models behind the same vendor) don't corroborate each other.
  `lib/consensus.ts`'s `distinctFamilies()` is the one place that counts this
  correctly; route any new call site through it rather than counting
  `judges.length`.
- **The agent whose work is being graded never sits on the panel judging
  it.** The panel excludes the family doing the work under test.
- **The retrieval gate's answer key never shrinks to raise a number.**
  `retrieval-eval/` scores `cardSearch` against a frozen query set
  (`base-queries.json`); every published recall@k/MRR figure is a mean over
  `n`, and dropping a query the retriever gets wrong reports an improvement
  while measuring less. `n` may not fall below 20 on a re-freeze —
  `TITRATION_RETRIEVAL_ALLOW_SHRINK=1` exists to record a deliberate,
  documented exception, not to wave one through silently. See
  `retrieval-eval/README.md`.

If a change to any of the above looks necessary, open an issue first — these
properties are what makes a Titration verdict worth trusting, and changes to
them get discussed, not merged on green CI alone.

## How to contribute a learning

`docs/core-learnings/` is Titration's own curated knowledge graph about
running Titration well (see `docs/core-learnings/README.md` for the curation
rule — domain-independent principles only). To propose a new card:

1. Add a `## T-XXX-NNN — title` section to the relevant
   `docs/core-learnings/CORE-LEARNINGS-v0.N.md` file (or start the next
   `v0.N+1` file if the existing ones are full), following the section format
   already used by the neighboring cards in that file.
2. Before opening the PR, run `npm run ingest:base` against your local
   database and then `npm run retrieval:eval` — a new or edited card must not
   regress recall/MRR on the frozen query set. If you add a query of your own
   to cover the new card, read the anti-leakage rule in
   `retrieval-eval/README.md` first: a query that quotes the card's own
   title/body measures string overlap, not retrieval.
3. Open the PR. A maintainer reads every proposed learning by hand before
   merge — this is curated content, not a bulk import, and no automated check
   substitutes for that review.

## Response time

Titration is maintained by one person. Reviews may take a week or more —
a quiet PR is not a rejection.

## Sign-off

No DCO / `Signed-off-by` line is required. Opening a PR against this repo is
taken as agreement to license your contribution under this project's Apache
License, Version 2.0 (see `LICENSE`).
