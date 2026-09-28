// Titration MCP — schema-inventory unit test (no network, no DB).
//
// Proves db/001_schema.sql and the engine source agree on the table set:
//   • every `from|into|update|join <table>` reference found in lib/**/*.ts and
//     server/**/*.ts (excluding lib/__tests__) resolves to a table this schema
//     creates — a typo'd or dropped table would 500 at runtime, not typecheck time
//     (postgres-js SQL is a plain template string).
//   • every table this schema creates is referenced by at least one such source
//     file — a "no dead tables" check, so a leftover, no-longer-referenced table
//     never rides along silently. `goal_titrate_change_note` was a documented, named exception until
//     the local evolution-capture adapter (lib/evolution-local.ts) started reading/
//     writing it; ALLOWED_UNREFERENCED_TABLES is empty now, kept as a named seam
//     for any future forward-provisioned table.
//
// PARSING, KEPT DELIBERATELY SIMPLE (this test's own contract, not a general SQL
// parser): db/001_schema.sql is OUR file, hand-written for this repo, so:
//   • a table body never contains a literal `)` inside a string/identifier that
//     isn't balanced by its own `(` — true of every statement in this file (no
//     free-standing parens inside quoted defaults/checks), so plain paren-depth
//     counting finds the correct end of a `create table (...)` block.
//   • SQL table references are only ever written inside a `sql`...`` / `tx`...``
//     tagged template — never assembled from a plain string containing the words
//     "from"/"into"/etc., which would otherwise collide with ordinary English
//     prose in comments (e.g. "derived FROM the reference implementation").
//   • a schema-qualified reference other than `public.<name>` (e.g.
//     `information_schema.columns`) is a system catalog lookup, not an engine
//     table, and is skipped.
//
// Run: npx tsx lib/__tests__/schema-inventory.test.ts

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail = ""): void {
  total++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");

// ── db/001_schema.sql: extract `create table if not exists <name> (...)` bodies ──

function findTableBlocks(sql: string): Array<{ name: string; body: string }> {
  const blocks: Array<{ name: string; body: string }> = [];
  const re = /create table if not exists\s+([a-z_][a-z0-9_]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const name = m[1]!.toLowerCase();
    const bodyStart = re.lastIndex; // just past the opening "("
    let depth = 1;
    let i = bodyStart;
    for (; i < sql.length && depth > 0; i++) {
      if (sql[i] === "(") depth++;
      else if (sql[i] === ")") depth--;
    }
    blocks.push({ name, body: sql.slice(bodyStart, i - 1) });
  }
  return blocks;
}

// Split a table body into its top-level comma-separated definitions (column defs
// and table-level constraints), respecting paren nesting so a multi-line `check
// (...)` constraint is not chopped at an internal comma.
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

const TABLE_LEVEL_KEYWORDS = new Set(["constraint", "unique", "check", "primary", "foreign", "exclude"]);

function columnsOf(body: string): Set<string> {
  const columns = new Set<string>();
  for (const part of splitTopLevel(body)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const firstToken = trimmed.split(/\s+/)[0]!.toLowerCase();
    if (TABLE_LEVEL_KEYWORDS.has(firstToken)) continue;
    columns.add(firstToken);
  }
  return columns;
}

const schemaSql = readFileSync(resolve(root, "db", "001_schema.sql"), "utf8").toLowerCase();
const tableBlocks = findTableBlocks(schemaSql);
const schemaTables = new Map<string, Set<string>>(tableBlocks.map((b) => [b.name, columnsOf(b.body)]));

check("db/001_schema.sql declares at least one table", schemaTables.size > 0);

// ── lib/**/*.ts + server/**/*.ts (excluding lib/__tests__): extract SQL table refs ──

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (relative(root, full).replace(/\\/g, "/") === "lib/__tests__") continue;
      out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const sourceFiles = [
  ...listTsFiles(resolve(root, "lib")),
  ...listTsFiles(resolve(root, "server")),
];

// Only text inside a `sql`...`` / `tx`...`` tagged template is real SQL — scanning
// the whole file would match ordinary prose ("derived FROM", "turn INTO", ...).
// No SQL in this codebase embeds a literal backtick, so the non-greedy match to
// the next backtick is exact, not approximate.
const TAGGED_SQL = /\b(?:sql|tx)(?:<[^`]*>)?`([^`]*)`/g;
const TABLE_REF = /\b(from|into|update|join)\s+([a-z_][a-z0-9_.]*)/gi;
// `on conflict (...) do update set <col> = ...` — the UPSERT idiom's "update" has no
// table name (the table is already named in the preceding `insert into`); its next
// token is the literal keyword `set`, which is not a table and never will be (no
// engine table is named "set").
const UPDATE_SET_FALSE_POSITIVE = "set";

type Reference = { table: string; file: string };
const references: Reference[] = [];

for (const file of sourceFiles) {
  const text = readFileSync(file, "utf8");
  const rel = relative(root, file).replace(/\\/g, "/");
  // Both regexes carry a mutable `lastIndex` (the `g` flag) — reset it before
  // scanning each new string, or a leftover offset from the previous file/block
  // silently skips or misaligns matches in the next one.
  TAGGED_SQL.lastIndex = 0;
  let sqlMatch: RegExpExecArray | null;
  while ((sqlMatch = TAGGED_SQL.exec(text))) {
    const sqlText = sqlMatch[1]!;
    TABLE_REF.lastIndex = 0;
    let refMatch: RegExpExecArray | null;
    while ((refMatch = TABLE_REF.exec(sqlText))) {
      const keyword = refMatch[1]!.toLowerCase();
      const raw = refMatch[2]!.toLowerCase();
      if (keyword === "update" && raw === UPDATE_SET_FALSE_POSITIVE) continue; // `do update set` — no table name
      if (raw.includes(".")) {
        const [schema, name] = raw.split(".", 2) as [string, string];
        if (schema !== "public") continue; // e.g. information_schema.columns — a catalog lookup, not an engine table
        references.push({ table: name, file: rel });
      } else {
        references.push({ table: raw, file: rel });
      }
    }
  }
}

check("at least one SQL table reference was found in lib/ or server/", references.length > 0);

// Every referenced table must exist in the schema.
const missing = references.filter((r) => !schemaTables.has(r.table));
check(
  "every SQL table referenced from lib/ or server/ exists in db/001_schema.sql",
  missing.length === 0,
  missing.map((m) => `${m.table} (${m.file})`).join(", "),
);

// Every schema table must be referenced by some source file — no dead tables —
// except a short, named allowlist of tables laid down ahead of their write path.
// Empty now: goal_titrate_change_note (the only past entry) is referenced by
// lib/evolution-local.ts (the local evolution-capture adapter).
const ALLOWED_UNREFERENCED_TABLES = new Set<string>([]);

const referencedTables = new Set(references.map((r) => r.table));
const deadTables = [...schemaTables.keys()].filter(
  (name) => !referencedTables.has(name) && !ALLOWED_UNREFERENCED_TABLES.has(name),
);
check(
  "every schema table (besides the documented forward-provisioned exception) is referenced by lib/ or server/",
  deadTables.length === 0,
  deadTables.join(", "),
);

// Guard the allowlist itself: if a listed table starts being used, or ceases to
// exist, this test should say so loudly rather than silently keep excusing it.
for (const allowed of ALLOWED_UNREFERENCED_TABLES) {
  check(
    `allowlisted table '${allowed}' still exists in the schema`,
    schemaTables.has(allowed),
  );
  check(
    `allowlisted table '${allowed}' is still unreferenced (drop it from the allowlist if this fails)`,
    !referencedTables.has(allowed),
  );
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${total - failures}/${total}`);
process.exit(failures === 0 ? 0 : 1);
