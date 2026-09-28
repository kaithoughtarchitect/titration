// Titration MCP — live DB smoke test for projects + base merge. NOT
// part of the offline unit suite (run-tests.mjs only globs lib/__tests__/*.test.ts)
// — this needs a real Postgres (npm run setup already applied) and is invoked
// directly, WITHOUT an OpenRouter key: OPENROUTER_API_KEY must be unset (or
// empty) for this run — every path exercised below is embedding-free by
// construction (see the note on card_search below), so a real key is never
// required and never called.
//
// Proves:
//   (a) reading a never-seen project ("smoke-new-xyz") is EMPTY/base-only,
//       never an "unknown tenant" throw — for both a raw project-scoped read
//       (lib/store.ts cardSearch) and the merged card surface (effectiveCardGet).
//   (b) a write to that project (cardCreate) CREATES its tenant row (idempotent:
//       a second write does not duplicate it).
//   (c) card_get of a known __base__ ref resolves to `layer: "base"` both via a
//       bare ref (project-then-base fallback) and via an explicit "base:REF" id;
//       an explicit "project:REF" on a ref the project does NOT have still
//       refuses (the explicit prefix never silently falls back).
//   (d) cleanup deletes the smoke project's cards and tenant row.
//
// WHY NOT card_search's embedding path: cardSearch (lib/store.ts) embeds the
// query BEFORE running the vector search — but only once the project is known
// to exist; a never-seen project (this smoke's whole point) short-circuits
// to an empty result BEFORE the embed call, so it needs no key. Actually
// exercising ranked search (a real embedding + pgvector ORDER BY) is the
// retrieval gate's job (`npm run retrieval:eval`, base dataset), not this
// smoke.
//
// Run: TITRATION_DATABASE_URL=postgres://... OPENROUTER_API_KEY= \
//      npx tsx scripts/smoke-projects.ts

import "../server/bootstrap-env";

import postgres from "postgres";
import { postgresOptions } from "../lib/db-connect-core";
import { cardSearch, cardCreate, close as closeStorePool } from "../lib/store";
import { effectiveCardGet } from "../lib/effective-retrieval";

const SMOKE_PROJECT = "smoke-new-xyz";
const KNOWN_BASE_REF = "T-FND-001"; // a curated __base__ card npm run setup ingests; never written to any project

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : `  — ${detail}`}`);
  if (!condition) failures++;
}

async function checkAsync(name: string, fn: () => Promise<boolean>): Promise<void> {
  try {
    check(name, await fn());
  } catch (e) {
    check(name, false, `threw unexpectedly: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function expectThrow(name: string, fn: () => Promise<unknown>, matching: RegExp): Promise<void> {
  try {
    await fn();
    check(name, false, "did not throw");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    check(name, matching.test(message), `message did not match ${matching}: ${message}`);
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.TITRATION_DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("Set TITRATION_DATABASE_URL before running scripts/smoke-projects.ts.");
    process.exit(1);
  }
  // Every path this smoke exercises is embedding-free. Remove the key from this process
  // (bootstrap-env may have loaded it from .env), so a stray OpenRouter call cannot
  // succeed: it would fail and fail the smoke, instead of spending.
  delete process.env.OPENROUTER_API_KEY;

  // Verification connection, separate from lib/store.ts's own pool (mirrors
  // scripts/smoke-schema.ts) — this smoke can inspect/clean up raw rows without
  // going through the tenant-scoped store API it is testing.
  const verify = postgres(databaseUrl, postgresOptions(databaseUrl, process.env));

  // Idempotent pre-clean: a previous failed run may have left the smoke project
  // behind. Delete it BEFORE asserting "never seen" — this smoke must be
  // re-runnable without manual cleanup.
  async function deleteSmokeProject(): Promise<void> {
    const [t] = await verify`select id from tenants where slug = ${SMOKE_PROJECT}`;
    if (!t) return;
    await verify`delete from card_relationships where tenant_id = ${t.id}`;
    await verify`delete from cards where tenant_id = ${t.id}`;
    await verify`delete from runs where tenant_id = ${t.id}`;
    await verify`delete from tenants where id = ${t.id}`;
  }

  try {
    await deleteSmokeProject();
    const [preExisting] = await verify`select id from tenants where slug = ${SMOKE_PROJECT}`;
    check("pre-clean: the smoke project does not exist yet", preExisting === undefined);

    // ── (a) reading a never-seen project is EMPTY/base-only, never "unknown tenant" ──
    await checkAsync(
      "(a) cardSearch on a never-seen project resolves with zero results (no throw)",
      async () => {
        const r = await cardSearch("anything", SMOKE_PROJECT);
        return Array.isArray(r.results) && r.results.length === 0;
      },
    );
    await checkAsync(
      "(a) effectiveCardGet on a never-seen project falls back to base (no 'unknown tenant' throw)",
      async () => {
        const c = await effectiveCardGet(KNOWN_BASE_REF, SMOKE_PROJECT);
        return c.layer === "base" && c.card_ref === KNOWN_BASE_REF;
      },
    );

    // ── (b) a write CREATES the tenant row (idempotent) ─────────────────────────────
    const created = await cardCreate(SMOKE_PROJECT, {
      type: "METHOD",
      title: "smoke-projects card",
      body: "smoke-projects body — deleted by this script's cleanup step",
    });
    check("(b) cardCreate on a never-seen project succeeds", typeof created.card_ref === "string" && created.card_ref.length > 0);
    const [afterWrite] = await verify`select id from tenants where slug = ${SMOKE_PROJECT}`;
    check("(b) the write created the project's tenant row", afterWrite !== undefined);
    if (!afterWrite?.id) {
      throw new Error("(b) the smoke project's tenant row was not created — cannot proceed to the remaining checks");
    }
    const smokeTenantId: string = afterWrite.id;

    // Idempotency: a second write to the SAME project must not duplicate the tenant row.
    const created2 = await cardCreate(SMOKE_PROJECT, {
      type: "METHOD",
      title: "smoke-projects card 2",
      body: "smoke-projects body 2 — deleted by this script's cleanup step",
    });
    check("(b) a second write to the same project succeeds", created2.card_ref !== created.card_ref);
    const stillOne = await verify`select count(*)::int as n from tenants where slug = ${SMOKE_PROJECT}`;
    check("(b) tenantIdForWrite is idempotent — exactly one tenant row for the project", stillOne[0].n === 1);

    // ── (c) card_get of a known base ref: bare ref and explicit "base:REF" ──────────
    await checkAsync(
      "(c) card_get of a known base ref via a bare ref resolves layer 'base'",
      async () => {
        const c = await effectiveCardGet(KNOWN_BASE_REF, SMOKE_PROJECT);
        return c.layer === "base" && c.card_ref === KNOWN_BASE_REF;
      },
    );
    await checkAsync(
      "(c) card_get of a known base ref via an explicit 'base:REF' id resolves layer 'base'",
      async () => {
        const c = await effectiveCardGet(`base:${KNOWN_BASE_REF}`, SMOKE_PROJECT);
        return c.layer === "base" && c.card_ref === KNOWN_BASE_REF;
      },
    );
    // An explicit "project:REF" on a ref the project does NOT have must still
    // refuse — the explicit prefix is not merely a hint, it never silently
    // falls back to base (unlike the bare-ref path above).
    await expectThrow(
      "(c) an explicit 'project:REF' on a base-only ref refuses rather than falling back",
      () => effectiveCardGet(`project:${KNOWN_BASE_REF}`, SMOKE_PROJECT),
      /not found in tenant/i,
    );

    // ── (d) cleanup ──────────────────────────────────────────────────────────────
    await deleteSmokeProject();
    const [afterCleanup] = await verify`select id from tenants where slug = ${SMOKE_PROJECT}`;
    check("(d) cleanup deleted the smoke project's tenant row", afterCleanup === undefined);
    // Scoped by the captured tenant_id, NOT by card_ref alone: card_ref is unique
    // only per-tenant (unique (tenant_id, card_ref) in db/001_schema.sql), and
    // __base__ legitimately has its own unrelated T-MET-001/T-MET-002 cards — an
    // unscoped card_ref lookup here would false-fail against those.
    const remainingCards = await verify`
      select count(*)::int as n from cards where tenant_id = ${smokeTenantId}`;
    check("(d) cleanup deleted both cards this run created", remainingCards[0].n === 0);
  } finally {
    await verify.end();
    await closeStorePool();
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  smoke-projects (${failures} failing check(s))`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
