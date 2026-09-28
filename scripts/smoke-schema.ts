// Titration MCP — DB smoke test for db/001_schema.sql. NOT part of the offline
// unit suite (run-tests.mjs only globs lib/__tests__/*.test.ts) — this needs a
// real Postgres and is invoked directly.
//
// Proves: `migrate apply` is idempotent (a second apply records zero new ledger
// rows), both seed tenants exist, and a card round-trips with a NULL embedding
// (the unembedded-base state `npm run setup` leaves cards in when
// OPENROUTER_API_KEY is unset).
//
// Run: TITRATION_DATABASE_URL=postgres://... npx tsx scripts/smoke-schema.ts

import "../server/bootstrap-env";

import postgres from "postgres";
import { migrationUrlFromEnvironment, runMigrations } from "./migrate";
import { postgresOptions } from "../lib/db-connect-core";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : `  — ${detail}`}`);
  if (!condition) failures++;
}

async function ledgerCount(sql: postgres.Sql): Promise<number> {
  const [row] = await sql`select count(*)::int as count from schema_migrations`;
  return Number(row?.count ?? 0);
}

async function applyOnce(label: string): Promise<void> {
  console.log(`[smoke-schema] ${label}...`);
  await runMigrations({
    mode: "apply",
    databaseUrl: migrationUrlFromEnvironment(),
    applyConfirmation: process.env.TITRATION_MIGRATION_CONFIRM,
  });
}

async function main(): Promise<void> {
  const databaseUrl = process.env.TITRATION_DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("Set TITRATION_DATABASE_URL before running scripts/smoke-schema.ts.");
    process.exit(1);
  }

  await applyOnce("applying migrations (1st run)");

  const probe = postgres(databaseUrl!, postgresOptions(databaseUrl!, process.env));
  const countAfterFirst = await ledgerCount(probe);
  await probe.end();

  await applyOnce("applying migrations again (2nd run — must be a no-op)");

  const sql = postgres(databaseUrl!, postgresOptions(databaseUrl!, process.env));
  try {
    const countAfterSecond = await ledgerCount(sql);
    check(
      "second apply recorded zero newly-applied migrations",
      countAfterSecond === countAfterFirst,
      `ledger rows: ${countAfterFirst} -> ${countAfterSecond}`,
    );

    const tenants = await sql`select slug from tenants where slug in ('__base__', 'default')`;
    const slugs = tenants.map((t: any) => String(t.slug)).sort();
    check("tenant '__base__' exists", slugs.includes("__base__"), slugs.join(","));
    check("tenant 'default' exists", slugs.includes("default"), slugs.join(","));

    const [defaultTenant] = await sql`select id from tenants where slug = 'default'`;
    check("tenant 'default' resolved an id", Boolean(defaultTenant?.id));

    const ref = `T-METHOD-SMOKE-${Date.now()}`;
    const [inserted] = await sql`
      insert into cards (tenant_id, card_ref, type, title, body)
      values (${defaultTenant.id}, ${ref}, 'METHOD'::card_type, 'smoke-schema card', 'smoke-schema body')
      returning id, card_ref, embedding`;
    check(
      "card insert succeeded with a NULL embedding",
      inserted !== undefined && inserted.embedding === null,
      JSON.stringify(inserted),
    );

    const [read] = await sql`select card_ref, embedding from cards where id = ${inserted.id}`;
    check("card round-trip read returns the same card_ref", read?.card_ref === ref);
    check("card round-trip read confirms a NULL embedding", read?.embedding === null);

    await sql`delete from cards where id = ${inserted.id}`;
    const [gone] = await sql`select id from cards where id = ${inserted.id}`;
    check("card delete removed the row", gone === undefined);
  } finally {
    await sql.end();
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  smoke-schema (${failures} failing check(s))`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
