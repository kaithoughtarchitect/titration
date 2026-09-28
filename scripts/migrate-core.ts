export type MigrationFile = {
  filename: string;
  number: number;
  checksum: string;
  compatibleChecksums?: readonly string[];
};

export type AppliedMigration = {
  filename: string;
  checksum: string;
};

export type MigrationPlan = {
  applied: MigrationFile[];
  pending: MigrationFile[];
};

const MIGRATION_FILENAME = /^(\d{3})_[a-z0-9][a-z0-9_-]*\.sql$/;

export function canonicalMigrationSource(source: string): string {
  return source.replace(/\r\n/g, "\n");
}

export function migrationSourceVariants(source: string): readonly string[] {
  const canonical = canonicalMigrationSource(source);
  const crlf = canonical.replace(/\n/g, "\r\n");
  return crlf === canonical ? [canonical] : [canonical, crlf];
}

export function migrationNumber(filename: string): number {
  const match = MIGRATION_FILENAME.exec(filename);
  if (!match) {
    throw new Error(`invalid migration filename: ${filename}`);
  }
  return Number(match[1]);
}

function assertMigrationFiles(files: readonly MigrationFile[]): void {
  if (files.length === 0) {
    throw new Error("no migration files found");
  }

  const filenames = new Set<string>();
  const numbers = new Set<number>();
  for (const file of files) {
    if (migrationNumber(file.filename) !== file.number) {
      throw new Error(`migration number mismatch: ${file.filename}`);
    }
    if (!/^[a-f0-9]{64}$/.test(file.checksum)) {
      throw new Error(`invalid migration checksum: ${file.filename}`);
    }
    if (
      file.compatibleChecksums?.some(
        (checksum) => !/^[a-f0-9]{64}$/.test(checksum),
      )
    ) {
      throw new Error(`invalid compatible migration checksum: ${file.filename}`);
    }
    if (filenames.has(file.filename)) {
      throw new Error(`duplicate migration filename: ${file.filename}`);
    }
    if (numbers.has(file.number)) {
      throw new Error(`duplicate migration number: ${file.number.toString().padStart(3, "0")}`);
    }
    filenames.add(file.filename);
    numbers.add(file.number);
  }

  const sortedNumbers = [...numbers].sort((a, b) => a - b);
  if (sortedNumbers[0] !== 1) {
    throw new Error("migration history must begin at 001");
  }
  const highest = sortedNumbers.at(-1)!;
  for (let number = 1; number <= highest; number++) {
    if (!numbers.has(number)) {
      throw new Error(`migration history has an undeclared gap at ${number.toString().padStart(3, "0")}`);
    }
  }
}

/**
 * Plan which migration files still need to run against `ledger` (the rows already
 * recorded in `schema_migrations`).
 *
 * Self-hosted single-tier history: every migration executes in order, starting at
 * 001, with no numbering gaps and no scope split (the closed-source product this
 * was ported from carried a `legacy-adoption` scope + a reserved retroactive slot
 * for a migration bolted onto its history after the fact; neither concept applies
 * to a fresh install that starts clean at 001).
 */
export function planMigrations(
  inputFiles: readonly MigrationFile[],
  ledger: readonly AppliedMigration[],
): MigrationPlan {
  assertMigrationFiles(inputFiles);

  const files = [...inputFiles].sort(
    (left, right) => left.number - right.number || left.filename.localeCompare(right.filename),
  );
  const fileByName = new Map(files.map((file) => [file.filename, file]));
  const ledgerByName = new Map<string, AppliedMigration>();
  const appliedNumbers = new Map<number, string>();

  for (const row of ledger) {
    if (ledgerByName.has(row.filename)) {
      throw new Error(`duplicate migration ledger row: ${row.filename}`);
    }
    const number = migrationNumber(row.filename);
    const existingAtNumber = appliedNumbers.get(number);
    if (existingAtNumber) {
      throw new Error(
        `migration ledger has duplicate number ${number.toString().padStart(3, "0")}: ${existingAtNumber}, ${row.filename}`,
      );
    }
    if (!/^[a-f0-9]{64}$/.test(row.checksum)) {
      throw new Error(`invalid ledger checksum: ${row.filename}`);
    }
    ledgerByName.set(row.filename, row);
    appliedNumbers.set(number, row.filename);
  }

  for (const row of ledger) {
    const file = fileByName.get(row.filename);
    if (!file) {
      throw new Error(`applied migration file is missing: ${row.filename}`);
    }
    if (
      file.checksum !== row.checksum
      && !file.compatibleChecksums?.includes(row.checksum)
    ) {
      throw new Error(`migration checksum drift: ${row.filename}`);
    }
  }

  const highestApplied = Math.max(0, ...ledger.map((row) => migrationNumber(row.filename)));
  const pending: MigrationFile[] = [];
  const applied: MigrationFile[] = [];

  for (const file of files) {
    if (ledgerByName.has(file.filename)) {
      applied.push(file);
      continue;
    }
    if (file.number <= highestApplied) {
      throw new Error(`retroactive migration refused: ${file.filename}`);
    }
    pending.push(file);
  }

  return { applied, pending };
}

// --- apply-target confirmation ---------------------------------------------
// `apply` mutates whichever database URL happens to be loaded, and bootstrap-env
// loads `.env` automatically. A stale TITRATION_MIGRATION_DATABASE_URL can point
// that at production, so apply refuses until the caller names the host it means to change. The
// refusal states the host, which is the fact a caller who has lost track of `.env`
// is missing. `check` is read-only and stays frictionless.
//
// A localhost/127.0.0.1 target is the exception: self-hosted single-user Titration
// runs its own Postgres there by default (docker-compose.yml), so the URL already
// names the only database an apply could possibly mean — requiring
// TITRATION_MIGRATION_CONFIRM for that case would be pure friction with no safety
// benefit. Any other host still requires an explicit, host-named confirmation.

const SELF_CONFIRMING_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** Fold the spellings of one Neon host: case, trailing dot, and the -pooler alias. */
export function normalizeMigrationHost(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/-pooler(?=\.)/, "")
    .replace(/-pooler$/, "");
}

export function migrationHostFromUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("migration database URL must be a PostgreSQL URL");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("migration database URL must be a PostgreSQL URL");
  }
  const host = normalizeMigrationHost(parsed.hostname);
  if (!host) {
    throw new Error("migration database URL must identify a host");
  }
  return host;
}

/**
 * Read the host out of whatever spelling the caller supplied.
 *
 * Accepts the bare host, a host:port, or the full connection URL, and strips
 * surrounding quotes first — a quoted `.env` value survives ad-hoc loaders
 * (constitution, Critical warnings), and a mismatch message where both sides
 * read identically is the worst possible refusal. This only widens what counts
 * as *naming* the target; it never widens which target is allowed.
 */
export function parseConfirmationHost(value: string): string {
  let raw = value.trim();
  const quote = raw.slice(0, 1);
  if ((quote === "'" || quote === '"') && raw.endsWith(quote) && raw.length >= 2) {
    raw = raw.slice(1, -1).trim();
  }
  if (/^postgres(?:ql)?:\/\//i.test(raw)) {
    try {
      return normalizeMigrationHost(new URL(raw).hostname);
    } catch {
      return normalizeMigrationHost(raw);
    }
  }
  return normalizeMigrationHost(raw.replace(/:\d+$/, ""));
}

export type ApplyConfirmation =
  | { allowed: true; host: string }
  | { allowed: false; host: string; reason: string };

/**
 * Decide whether an `apply` may proceed against `url`.
 *
 * Pure: no clock, no environment read, no connection. The caller supplies the
 * confirmation it read from the environment so this stays offline-testable.
 */
export function decideApplyConfirmation(input: {
  url: string;
  confirmation: string | undefined;
}): ApplyConfirmation {
  const host = migrationHostFromUrl(input.url);

  if (SELF_CONFIRMING_HOSTS.has(host)) {
    return { allowed: true, host };
  }

  const given = (input.confirmation ?? "").trim();

  if (!given) {
    return {
      allowed: false,
      host,
      reason:
        `apply would change ${host}. Re-run with TITRATION_MIGRATION_CONFIRM=${host} `
        + "if that is what you mean. `migrate:check` is read-only and needs no confirmation.",
    };
  }

  const named = parseConfirmationHost(given);
  if (named !== host) {
    return {
      allowed: false,
      host,
      reason:
        `confirmation names ${named} but apply would change ${host}. `
        + "Refusing rather than guessing which one was meant.",
    };
  }

  return { allowed: true, host };
}
