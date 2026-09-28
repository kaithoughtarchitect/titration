// Titration MCP — db-connect-core unit test (no network, no DB).
// Pins the SSL rule every postgres(...) call in this repo goes through:
//   • local/known-unencrypted hosts (localhost, 127.0.0.1, ::1, host.docker.internal) -> ssl: false
//   • every other host -> ssl: "require"
//   • TITRATION_DB_SSL=require|disable overrides either way, regardless of host
// Mirrors dedupe-core.test.ts (check/total/failures + process.exit(failures===0?0:1)).
// Run: npx tsx lib/__tests__/db-connect-core.test.ts

import { postgresOptions, sslModeFor } from "../db-connect-core";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail = ""): void {
  total++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}

const NO_OVERRIDE: Record<string, string | undefined> = {};

// ── local hosts default to ssl: false ───────────────────────────────────────
check(
  "bare localhost defaults to ssl:false",
  sslModeFor("postgres://u:p@localhost:5432/db", NO_OVERRIDE) === false,
);
check(
  "127.0.0.1 defaults to ssl:false",
  sslModeFor("postgres://u:p@127.0.0.1:55432/db", NO_OVERRIDE) === false,
);
check(
  "bracketed IPv6 ::1 defaults to ssl:false",
  sslModeFor("postgres://u:p@[::1]:5432/db", NO_OVERRIDE) === false,
);
check(
  "host.docker.internal defaults to ssl:false",
  sslModeFor("postgres://u:p@host.docker.internal:5432/db", NO_OVERRIDE) === false,
);
check(
  "local host comparison is case-insensitive",
  sslModeFor("postgres://u:p@LOCALHOST:5432/db", NO_OVERRIDE) === false,
);

// ── every other host defaults to ssl: "require" ─────────────────────────────
check(
  "a remote hostname defaults to ssl:require",
  sslModeFor("postgres://u:p@db.example.com:5432/db", NO_OVERRIDE) === "require",
);
check(
  "a managed-postgres-shaped host defaults to ssl:require",
  sslModeFor("postgres://u:p@ep-quiet-forest-12345678.c-5.us-east-2.aws.example-postgres.dev/exampledb", NO_OVERRIDE)
    === "require",
);
check(
  "an unparseable URL is not treated as local (fails safe to ssl:require)",
  sslModeFor("not-a-url", NO_OVERRIDE) === "require",
);

// ── TITRATION_DB_SSL override wins regardless of host ───────────────────────
check(
  "TITRATION_DB_SSL=require overrides a local host",
  sslModeFor("postgres://u:p@localhost:5432/db", { TITRATION_DB_SSL: "require" }) === "require",
);
check(
  "TITRATION_DB_SSL=disable overrides a remote host",
  sslModeFor("postgres://u:p@db.example.com:5432/db", { TITRATION_DB_SSL: "disable" }) === false,
);
check(
  "TITRATION_DB_SSL is case-insensitive and trims whitespace",
  sslModeFor("postgres://u:p@db.example.com:5432/db", { TITRATION_DB_SSL: "  Disable  " }) === false,
);
check(
  "an unrecognized TITRATION_DB_SSL value is ignored (falls back to the host rule)",
  sslModeFor("postgres://u:p@localhost:5432/db", { TITRATION_DB_SSL: "nonsense" }) === false,
);

// ── postgresOptions wraps sslModeFor in the postgres-js options shape ───────
check(
  "postgresOptions returns { ssl: false } for a local URL",
  JSON.stringify(postgresOptions("postgres://u:p@127.0.0.1:5432/db", NO_OVERRIDE)) === JSON.stringify({ ssl: false }),
);
check(
  "postgresOptions returns { ssl: \"require\" } for a remote URL",
  JSON.stringify(postgresOptions("postgres://u:p@db.example.com:5432/db", NO_OVERRIDE))
    === JSON.stringify({ ssl: "require" }),
);

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${total - failures}/${total}`);
process.exit(failures === 0 ? 0 : 1);
