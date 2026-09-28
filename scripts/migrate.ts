import "../server/bootstrap-env";

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { postgresOptions } from "../lib/db-connect-core";
import {
  decideApplyConfirmation,
  migrationNumber,
  migrationSourceVariants,
  planMigrations,
  type AppliedMigration,
  type MigrationFile,
} from "./migrate-core";

type LoadedMigration = MigrationFile & { sql: string };
export type MigrationMode = "check" | "apply";

export type RunMigrationsOptions = {
  mode: MigrationMode;
  databaseUrl: string;
  /** Host the caller declares it means to change. Required for `apply` against a non-local host. */
  applyConfirmation?: string;
};

const LEDGER_SQL = `
  create table if not exists public.schema_migrations (
    filename text primary key,
    checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
    applied_at timestamptz not null default now()
  )
`;

function parseCommand(args: readonly string[]): { mode: MigrationMode } {
  const mode = args[0];
  if ((mode !== "check" && mode !== "apply") || args.length > 1) {
    throw new Error("usage: tsx scripts/migrate.ts <check|apply>");
  }
  return { mode };
}

/**
 * The database URL migrations run against. Defaults to `TITRATION_DATABASE_URL`:
 * this is self-hosted, single-user Postgres — there is no separate migration-role
 * vs application-role split to keep apart, so requiring a second env var for the
 * common case would be pure friction. Set `TITRATION_MIGRATION_DATABASE_URL` explicitly only to point
 * migrations at a different database than the app itself uses.
 */
export function migrationUrlFromEnvironment(): string {
  const value = (process.env.TITRATION_MIGRATION_DATABASE_URL?.trim() || process.env.TITRATION_DATABASE_URL)?.trim();
  if (!value) {
    throw new Error("TITRATION_MIGRATION_DATABASE_URL (or TITRATION_DATABASE_URL) is required");
  }
  return value;
}

function transactionBody(source: string): string {
  return source
    .replace(/^\s*begin;\s*$/gim, "")
    .replace(/^\s*commit;\s*$/gim, "")
    .trim();
}

async function discoverMigrations(): Promise<LoadedMigration[]> {
  const here = dirname(fileURLToPath(import.meta.url));
  const dbDirectory = resolve(here, "..", "db");
  const filenames = (await readdir(dbDirectory))
    .filter((filename) => /^\d{3}_[a-z0-9][a-z0-9_-]*\.sql$/.test(filename))
    .sort();

  return Promise.all(
    filenames.map(async (filename) => {
      const source = await readFile(resolve(dbDirectory, filename), "utf8");
      const [canonicalSource, ...compatibleSources] =
        migrationSourceVariants(source);
      const checksum = createHash("sha256")
        .update(canonicalSource!)
        .digest("hex");
      return {
        filename,
        number: migrationNumber(filename),
        checksum,
        compatibleChecksums: compatibleSources
          .map((variant) => createHash("sha256").update(variant).digest("hex"))
          .filter((variantChecksum) => variantChecksum !== checksum),
        sql: transactionBody(source),
      };
    }),
  );
}

async function readLedger(
  sql: postgres.Sql<Record<string, unknown>> | postgres.TransactionSql<Record<string, unknown>>,
): Promise<AppliedMigration[]> {
  const exists = await sql<{ exists: boolean }[]>`
    select to_regclass('public.schema_migrations') is not null as exists
  `;
  if (!exists[0]?.exists) return [];
  return sql<AppliedMigration[]>`
    select filename, checksum
    from public.schema_migrations
    order by filename
  `;
}

async function check(
  sql: postgres.Sql<Record<string, unknown>>,
  files: readonly LoadedMigration[],
): Promise<void> {
  const ledger = await readLedger(sql);
  const plan = planMigrations(files, ledger);
  console.log(
    `[migration] check passed: ${plan.applied.length} applied, ${plan.pending.length} pending`,
  );
  for (const file of plan.pending) {
    console.log(`[migration] pending: ${file.filename}`);
  }
}

async function apply(
  sql: postgres.Sql<Record<string, unknown>>,
  files: readonly LoadedMigration[],
): Promise<void> {
  const committed = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('titration-schema-migrations-v1'))`;
    await tx.unsafe(LEDGER_SQL);
    const ledger = await readLedger(tx);
    const plan = planMigrations(files, ledger);

    const loadedByName = new Map(files.map((loaded) => [loaded.filename, loaded]));
    for (const file of plan.pending) {
      const loaded = loadedByName.get(file.filename);
      if (!loaded) throw new Error(`migration ${file.filename} was planned but not loaded`);
      await tx.unsafe(loaded.sql);
      await tx`
        insert into public.schema_migrations (filename, checksum)
        values (${file.filename}, ${file.checksum})
      `;
    }
    return plan;
  });
  for (const file of committed.pending) {
    console.log(`[migration] applied: ${file.filename}`);
  }
  console.log(
    `[migration] apply passed: ${committed.applied.length + committed.pending.length} applied, ${committed.pending.length} changed`,
  );
}

export async function runMigrations(options: RunMigrationsOptions): Promise<void> {
  if (!options.databaseUrl.trim()) {
    throw new Error("migration database URL is required");
  }

  // Refuse before connecting: an unconfirmed apply must not even reach the host.
  if (options.mode === "apply") {
    const decision = decideApplyConfirmation({
      url: options.databaseUrl,
      confirmation: options.applyConfirmation,
    });
    if (!decision.allowed) {
      throw new Error(`apply refused — ${decision.reason}`);
    }
    console.log(`[migration] apply target confirmed: ${decision.host}`);
  }

  const files = await discoverMigrations();
  const sql = postgres(options.databaseUrl.trim(), {
    ...postgresOptions(options.databaseUrl.trim(), process.env),
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
  });
  let primaryError: unknown;
  try {
    if (options.mode === "check") {
      await check(sql, files);
    } else {
      await apply(sql, files);
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await sql.end({ timeout: 5 });
    } catch (error) {
      if (primaryError) {
        console.error("[migration] cleanup warning: database connection did not close cleanly");
      } else {
        throw error;
      }
    }
  }
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv.slice(2));
  await runMigrations({
    mode: command.mode,
    databaseUrl: migrationUrlFromEnvironment(),
    applyConfirmation: process.env.TITRATION_MIGRATION_CONFIRM,
  });
}

const isDirectRun =
  Array.isArray(process.argv) &&
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown migration error";
    console.error(`[migration] failed: ${message}`);
    process.exitCode = 1;
  });
}
