# Titration — guide for contributors and coding agents

Titration is an MCP server that grades an AI coding agent's declared outputs with a panel of
cross-vendor judges and keeps what it learns as searchable memory. It runs on the user's own
machine against the user's own Postgres. `CLAUDE.md` imports this file; edit only this one.

## Vocabulary

| Term | Meaning |
| --- | --- |
| Player | the coding agent calling the tools; it ships outputs and never grades itself |
| Referee | the grading engine (`lib/verify.ts`, `lib/consensus.ts`, `lib/judge.ts`) |
| judge door | how a judge is reached: `openrouter`, or the `claude` / `codex` / `grok` CLIs |
| family | a judge's vendor family (anthropic, openai, google, …) from the curated table in `lib/judges-roster-core.ts` |
| panel lock | the self-contained snapshot of three judges stored on a baseline |
| project | the user-facing name for a memory partition; the code and schema call it `tenant` |
| base | the read-only curated starter pack (`__base__`), loaded from `docs/core-learnings/` |

## Grading laws — never break these

- Verdict inputs are the declared outputs plus the frozen rubric only. Nothing else enters a
  grading prompt: not cards, not traces, not the Player's reasoning.
- Cards are advisory. They may annotate a result; they never change a numeric verdict.
- A numeric verdict needs judges from **at least two distinct vendor families** that actually
  responded. Fewer, and the run is recorded as panel-degraded and never scored.
- The Player's own family never sits on the panel — checked when a baseline is established and
  again on every `verify` / `goal_titrate` / `goal_titrate_step`.
- A baseline's panel is locked; later comparisons reuse it. Never grade a baseline with a
  different panel.
- Consensus math, thresholds, and rubric handling change only with a discussed, reviewed PR.

## Code rules

- Pure logic lives in `lib/X-core.ts` (no I/O, no `Date.now()`, no `Math.random()` — pass time
  and seeds in) with offline tests; I/O lives in `lib/X.ts`.
- postgres-js: bind vectors with `toVec(...)` and `::vector`; write jsonb with `sql.json(...)`,
  never `JSON.stringify(...)::jsonb`; never bind a JS array to a uuid column; read jsonb
  defensively.
- Optional writes fail open (`console.error`, never lose a verdict); grading refusals are typed
  and happen before any judge is called.
- The base is read-only at runtime (`assertWritable`); it grows only through reviewed changes to
  `docs/core-learnings/` plus `npm run ingest:base`.
- A project is created by its first write; reading an unknown project is empty, not an error.
- CLI judge doors are resolved through their package metadata (`lib/cli-resolve.ts`) and
  spawned without a shell. A door that cannot be resolved is unavailable, never guessed.
- Fake transports in tests must replay recorded real calls (`lib/__tests__/fixtures/`) or be
  labelled ideal-model.

## Gates before a PR

```bash
npm run typecheck
npm test                                   # offline suites + import-graph check
docker compose up -d && npm run setup      # local database
npx tsx scripts/smoke-schema.ts            # and smoke-projects, smoke-evolution, smoke-jobs, smoke-picker
node scripts/scrub-check.mjs
node skills/check-skills.mjs               # when touching skills/
npm run retrieval:eval                     # when touching search, cards, or embeddings (needs an OpenRouter key)
```

The retrieval gate's query set may never shrink. Re-freeze its baseline only for an intentional
retrieval change, with the reason written in the PR.

## Schema

`db/001_schema.sql` is the baseline. Never edit an applied migration; add
`db/NNN_description.sql` and let `npm run migrate` apply it (checksum ledger, advisory lock,
no-op on re-run).

## Map

| Path | What |
| --- | --- |
| `server/` | stdio MCP server, tool registry, local picker |
| `lib/` | engine: pure cores, I/O, offline tests in `lib/__tests__/` |
| `db/` | schema and migration notes |
| `ingest/`, `query/` | base loader, embedding backfill, search CLI |
| `retrieval-eval/` | retrieval gate on the base answer key |
| `skills/` | agent skills (scout, harness, improve) |
| `docs/core-learnings/` | the curated base starter pack |
| `judges-roster.json` | the judge pool shown in the picker |
