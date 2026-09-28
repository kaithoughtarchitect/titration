import {
  canonicalMigrationSource,
  decideApplyConfirmation,
  migrationHostFromUrl,
  migrationSourceVariants,
  normalizeMigrationHost,
  planMigrations,
  type AppliedMigration,
  type MigrationFile,
} from "../../scripts/migrate-core";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : ` — ${detail}`}`);
  if (!condition) failures++;
}

function checksum(value: number): string {
  return value.toString(16).padStart(64, "0");
}

function file(number: number, name = `migration_${number}`): MigrationFile {
  return {
    filename: `${number.toString().padStart(3, "0")}_${name}.sql`,
    number,
    checksum: checksum(number),
  };
}

function history(highest = 32): MigrationFile[] {
  return Array.from({ length: highest }, (_, index) => index + 1).map((number) => file(number));
}

function ledger(files: readonly MigrationFile[]): AppliedMigration[] {
  return files.map(({ filename, checksum: value }) => ({ filename, checksum: value }));
}

function throws(name: string, action: () => unknown, expected: RegExp): void {
  try {
    action();
    check(name, false, "expected an error");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(name, expected.test(message), message);
  }
}

{
  const lf = "-- migration\nselect 1;\n";
  const crlf = "-- migration\r\nselect 1;\r\n";
  check(
    "migration checksum input is portable across LF and CRLF checkouts",
    canonicalMigrationSource(lf) === canonicalMigrationSource(crlf),
  );
  check(
    "migration source variants preserve canonical LF and legacy CRLF",
    migrationSourceVariants(lf).join("|") === `${lf}|${crlf}`,
  );
}

{
  const files = history(32);
  const plan = planMigrations(files, []);
  check(
    "fresh database orders every migration file as pending, starting at 001",
    plan.pending.map((item) => item.number).join(",") ===
      Array.from({ length: 32 }, (_, index) => index + 1).join(","),
  );
}

{
  const files = history(12);
  const applied = ledger(files);
  applied[3] = { ...applied[3]!, checksum: checksum(999) };
  throws(
    "historical checksum drift fails loud",
    () => planMigrations(files, applied),
    /checksum drift/,
  );
}

{
  const files = history(12);
  const compatible = checksum(999);
  files[0] = { ...files[0]!, compatibleChecksums: [compatible] };
  const applied = ledger(files);
  applied[0] = { ...applied[0]!, checksum: compatible };
  const plan = planMigrations(files, applied);
  check(
    "declared line-ending-compatible historical checksum is accepted",
    plan.pending.length === 0,
  );
}

{
  const files = history(27);
  const plan = planMigrations(files, ledger(files));
  check("second apply is an idempotent no-op", plan.pending.length === 0);
}

{
  const files = history(10).filter((item) => item.number !== 5);
  throws(
    "undeclared migration-number gap is refused",
    () => planMigrations(files, []),
    /undeclared gap at 005/,
  );
}

{
  const files = history(3);
  // 001 and 003 are recorded as applied; 002 never got a ledger row (a hole below
  // the highest applied number) — planMigrations must refuse to insert it now
  // rather than silently treat it as ordinary pending work.
  const partialLedger = ledger([files[0]!, files[2]!]);
  throws(
    "a migration numbered below the highest applied one, but never itself applied, is refused",
    () => planMigrations(files, partialLedger),
    /retroactive migration refused: 002_/,
  );
}

// --- apply-target confirmation ---------------------------------------------
// `apply` writes to whichever URL bootstrap-env loaded from `.env`. These pin the
// refusal so a stale TITRATION_MIGRATION_DATABASE_URL cannot silently mutate an
// unintended database.

const PROD_URL = "postgres://u:p@ep-quiet-forest-12345678.c-5.us-east-2.aws.example-postgres.dev/exampledb";
const PROD_POOLED_URL =
  "postgres://u:p@ep-quiet-forest-12345678-pooler.c-5.us-east-2.aws.example-postgres.dev/exampledb";
const PROD_HOST = "ep-quiet-forest-12345678.c-5.us-east-2.aws.example-postgres.dev";
const PROD_POOLED_HOST = "ep-quiet-forest-12345678-pooler.c-5.us-east-2.aws.example-postgres.dev";
const SOURCE_HOST = "ep-still-river-87654321.c-3.us-east-2.aws.example-postgres.dev";

check(
  "host folds the -pooler alias to one spelling",
  normalizeMigrationHost(PROD_POOLED_HOST) === PROD_HOST,
  normalizeMigrationHost(PROD_POOLED_HOST),
);
check(
  "host folds case, surrounding space, and a trailing dot",
  normalizeMigrationHost(`  ${PROD_HOST.toUpperCase()}.  `) === PROD_HOST,
  normalizeMigrationHost(`  ${PROD_HOST.toUpperCase()}.  `),
);
check(
  "pooled and direct URLs resolve to one host",
  migrationHostFromUrl(PROD_URL) === migrationHostFromUrl(PROD_POOLED_URL),
  `${migrationHostFromUrl(PROD_URL)} vs ${migrationHostFromUrl(PROD_POOLED_URL)}`,
);

{
  const decision = decideApplyConfirmation({ url: PROD_URL, confirmation: undefined });
  check("apply without a confirmation is refused", decision.allowed === false);
  check(
    "the refusal names the host that would have changed",
    decision.allowed === false && decision.reason.includes(PROD_HOST),
    decision.allowed === false ? decision.reason : "allowed",
  );
  check(
    "the refusal names the variable that unblocks it",
    decision.allowed === false && decision.reason.includes("TITRATION_MIGRATION_CONFIRM"),
    decision.allowed === false ? decision.reason : "allowed",
  );
}

check(
  "a whitespace-only confirmation is not a confirmation",
  decideApplyConfirmation({ url: PROD_URL, confirmation: "   " }).allowed === false,
);

{
  const decision = decideApplyConfirmation({ url: PROD_URL, confirmation: SOURCE_HOST });
  check("confirming a different host is refused, never coerced", decision.allowed === false);
  check(
    "the mismatch refusal names both hosts so the caller sees the swap",
    decision.allowed === false
      && decision.reason.includes(SOURCE_HOST)
      && decision.reason.includes(PROD_HOST),
    decision.allowed === false ? decision.reason : "allowed",
  );
}

check(
  "confirming the exact host allows the apply",
  decideApplyConfirmation({ url: PROD_URL, confirmation: PROD_HOST }).allowed === true,
);
check(
  "a pooled confirmation matches a direct URL (same database)",
  decideApplyConfirmation({ url: PROD_URL, confirmation: PROD_POOLED_HOST }).allowed === true,
);
check(
  "a direct confirmation matches a pooled URL (same database)",
  decideApplyConfirmation({ url: PROD_POOLED_URL, confirmation: PROD_HOST }).allowed === true,
);

throws(
  "a non-URL migration target fails before any decision",
  () => decideApplyConfirmation({ url: "not-a-url", confirmation: PROD_HOST }),
  /must be a PostgreSQL URL/,
);
throws(
  "a non-postgres scheme fails before any decision",
  () => decideApplyConfirmation({ url: "https://example.com/db", confirmation: PROD_HOST }),
  /must be a PostgreSQL URL/,
);

// Confirmation spelling: widen what counts as NAMING the target, never what is
// allowed. A quoted `.env` value survives ad-hoc loaders (constitution), and a
// mismatch message whose two sides read identically is the worst refusal there is.

check(
  "a single-quoted confirmation is accepted (the .env quote trap)",
  decideApplyConfirmation({ url: PROD_URL, confirmation: `'${PROD_HOST}'` }).allowed === true,
);
check(
  "a double-quoted confirmation is accepted",
  decideApplyConfirmation({ url: PROD_URL, confirmation: `"${PROD_HOST}"` }).allowed === true,
);
check(
  "a host:port confirmation is accepted",
  decideApplyConfirmation({ url: PROD_URL, confirmation: `${PROD_HOST}:5432` }).allowed === true,
);
check(
  "pasting the whole connection URL is accepted",
  decideApplyConfirmation({ url: PROD_URL, confirmation: PROD_URL }).allowed === true,
);

// The other half of that widening: recognition is not permission.
check(
  "a full URL naming a DIFFERENT host is still refused",
  decideApplyConfirmation({
    url: PROD_URL,
    confirmation: `postgres://u:p@${SOURCE_HOST}/exampledb`,
  }).allowed === false,
);
check(
  "a quoted different host is still refused",
  decideApplyConfirmation({ url: PROD_URL, confirmation: `'${SOURCE_HOST}'` }).allowed === false,
);
check(
  "empty quotes are not a confirmation",
  decideApplyConfirmation({ url: PROD_URL, confirmation: "''" }).allowed === false,
);
check(
  "a bare port is not a confirmation",
  decideApplyConfirmation({ url: PROD_URL, confirmation: ":5432" }).allowed === false,
);
check(
  "a prefix of the right host does not pass",
  decideApplyConfirmation({ url: PROD_URL, confirmation: "ep-quiet-forest-12345678" }).allowed
    === false,
);
check(
  "a longer host that merely ends with the right one does not pass",
  decideApplyConfirmation({ url: PROD_URL, confirmation: `sneaky.${PROD_HOST}` }).allowed === false,
);

// Intentional, not an oversight: a target with no host cannot be named, so it
// cannot be confirmed. Fail-closed is the correct answer for an unidentifiable
// database.
throws(
  "a hostless URL is refused rather than silently applied",
  () => decideApplyConfirmation({ url: "postgres:///db", confirmation: "anything" }),
  /must identify a host/,
);

// --- self-hosted local-host exception ---------------------------------------
// A localhost/127.0.0.1 apply target confirms itself — the common single-user
// self-hosted case needs no TITRATION_MIGRATION_CONFIRM at all.

check(
  "a bare localhost URL confirms itself without TITRATION_MIGRATION_CONFIRM",
  decideApplyConfirmation({
    url: "postgres://titration:titration@localhost:5432/titration",
    confirmation: undefined,
  }).allowed === true,
);
check(
  "a 127.0.0.1 URL confirms itself without TITRATION_MIGRATION_CONFIRM",
  decideApplyConfirmation({
    url: "postgres://titration:titration@127.0.0.1:55432/titration",
    confirmation: undefined,
  }).allowed === true,
);
check(
  "the localhost self-confirmation is unaffected by an unrelated confirmation value",
  decideApplyConfirmation({
    url: "postgres://titration:titration@localhost:5432/titration",
    confirmation: "garbage",
  }).allowed === true,
);
check(
  "a non-local host still requires a confirmation (the exception does not widen)",
  decideApplyConfirmation({
    url: "postgres://u:p@db.example.com:5432/titration",
    confirmation: undefined,
  }).allowed === false,
);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
