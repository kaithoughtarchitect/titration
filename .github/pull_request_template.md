## What this changes

Describe the change and why. Link the issue it closes, if any (`closes #123`).

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (offline unit suite + import-graph check)
- [ ] If this touches `lib/`/`server/` behavior a real Postgres exercises: the
      relevant `npx tsx scripts/smoke-*.ts` script(s) pass against the compose
      database
- [ ] If this touches `cardSearch`, `cardCreate`, embedding, or ranking:
      `npm run retrieval:eval` passes (or I don't have an `OPENROUTER_API_KEY`
      and say so below, for a maintainer to run)
- [ ] `node scripts/scrub-check.mjs` passes (no new private-surface hits)
- [ ] This PR does **not** change a grading law (verdict inputs, cross-vendor
      judge corroboration, cards-are-advisory-only, or the retrieval gate's
      `n`-floor) — or, if it does, I opened an issue to discuss it *before*
      this PR and linked it above

## Notes for the reviewer

Anything that needs a human's judgment call before merge — a deliberate
tradeoff, something you're unsure about, or a gate you couldn't run locally.
