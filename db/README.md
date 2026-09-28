# db/ — schema migrations

Flat, numbered, forward-only SQL files: `db/NNN_description.sql`. The runner
(`scripts/migrate.ts` / `scripts/migrate-core.ts`) tracks what has been applied in
a `schema_migrations` ledger table (filename + sha256 checksum), keyed by an
advisory lock so two concurrent applies never race.

## The one migration

`001_schema.sql` is the entire engine schema for this self-hosted build: tenants,
the card knowledge graph (`cards` / `card_relationships` / `runs`), the verdict
engine (`baselines` / `jobs` / `goal_titrate_turns`), the human-approval inbox
(`knowledge_review_queue`), the per-cycle declared change-note
(`goal_titrate_change_note` — schema now, write path lands with the durable
evolution-capture adapter), and the referee-panel picker ticket
(`referee_panel_ticket`).

It is a consolidated, ground-up schema for this self-hosted build —
**engine tables only**. Deliberately **not** included:

- Roles, `RLS`, policies, and `grant`/`revoke` statements (the `__base__`
  write-refusal is enforced by a trigger instead of a role-scoped policy).
- Tenant columns that never shipped in this build: `organization_id`, `access_class`,
  `is_default_workspace`.
- Product-app-owned tables that never shipped in this build (`prompt_content`,
  `verdict_log`, `systems`, `harness*`, `corpus_case*`, the adaptation-graph
  family, etc.).

Every table/column here is proven against the `lib/`/`server/` source by
`lib/__tests__/schema-inventory.test.ts` (offline): every SQL table reference in
the engine code must resolve to a table in this file, and every table in this
file must be referenced by some engine source file — with one named exception,
`goal_titrate_change_note`, documented in that test as schema laid down ahead of
its write path.

## Adding migration `002` and beyond

- Filename: `NNN_description.sql`, one greater than the highest existing number.
  No gaps — `scripts/migrate-core.ts` refuses an undeclared gap in the numbering.
- Idempotent: `create table if not exists`, `add column if not exists`, etc. — a
  migration may be re-run safely (defense in depth; the ledger is still what
  decides whether it runs at all).
- No `begin`/`commit` needed — the runner strips bare `begin;`/`commit;` lines
  and applies the file inside its own transaction (ledger insert included), so a
  migration and its ledger row commit or roll back together.
- CRLF-safe: the checksum is computed against both LF and CRLF line-ending
  variants of the same content, so a Windows checkout does not read as drift.

## Applying

```
npm run migrate:check   # read-only: reports pending migrations
npm run migrate         # applies pending migrations
npm run setup           # migrate apply -> ingest the base -> embed (see scripts/setup.ts)
```

`TITRATION_MIGRATION_DATABASE_URL` defaults to `TITRATION_DATABASE_URL` (this is
a single-user local Postgres — there is no separate migration-vs-application
role to keep apart). A
`localhost`/`127.0.0.1` target confirms itself; any other host requires
`TITRATION_MIGRATION_CONFIRM=<host>` naming the host the apply would change, so a
stale env var pointed at a real remote database still refuses without an
explicit, host-named confirmation.

## Local dev database

`docker-compose.yml` at the repo root starts a disposable
`pgvector/pgvector:pg17` container on `localhost:5432` with user/password/db
`titration` — see `.env.example`. `scripts/smoke-schema.ts` is a live (non-unit
-suite) smoke test that applies this schema twice against a real
`TITRATION_DATABASE_URL` (proving the second apply is a no-op), checks both seed
tenants exist, and round-trips one card with a `NULL` embedding.
