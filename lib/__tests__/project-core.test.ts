// Titration MCP — project-core unit test (no network, no DB).
// Pins the `project` -> internal tenant slug normalizer every tool schema
// routes through (server/mcp-server.ts, query/card-search.ts).
// Mirrors db-connect-core.test.ts (check/total/failures + process.exit).
// Run: npx tsx lib/__tests__/project-core.test.ts

import { resolveProject, InvalidProjectError } from "../project-core";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail = ""): void {
  total++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}
function throws(fn: () => unknown): Error | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e as Error;
  }
}

// ── undefined/empty -> "default" ────────────────────────────────────────────
check("undefined -> 'default'", resolveProject(undefined) === "default");
check("null -> 'default'", resolveProject(null) === "default");
check("empty string -> 'default'", resolveProject("") === "default");
check("whitespace-only string -> 'default'", resolveProject("   ") === "default");

// ── trims ────────────────────────────────────────────────────────────────────
check("leading/trailing whitespace is trimmed", resolveProject("  demo  ") === "demo");

// ── valid slugs pass through unchanged ──────────────────────────────────────
check("a plain lowercase slug passes through", resolveProject("demo") === "demo");
check("digits + underscore + hyphen are legal", resolveProject("proj_9-two") === "proj_9-two");
check("a single character slug is legal", resolveProject("a") === "a");
check("a 63-character slug is legal (at the cap)", resolveProject("a".repeat(63)) === "a".repeat(63));
check("'default' passes through unchanged", resolveProject("default") === "default");

// ── __base__ is exempt from the slug pattern (read-only, explicit) ─────────
check("'__base__' passes through unchanged", resolveProject("__base__") === "__base__");
check("'  __base__  ' trims to '__base__'", resolveProject("  __base__  ") === "__base__");

// ── invalid shapes throw a typed, named error ───────────────────────────────
check(
  "a non-string input throws InvalidProjectError",
  throws(() => resolveProject(42)) instanceof InvalidProjectError,
);
check(
  "an object input throws InvalidProjectError",
  throws(() => resolveProject({})) instanceof InvalidProjectError,
);
check(
  "uppercase characters are refused",
  throws(() => resolveProject("Demo")) instanceof InvalidProjectError,
);
check(
  "a leading hyphen is refused (must start letter/digit)",
  throws(() => resolveProject("-demo")) instanceof InvalidProjectError,
);
check(
  "a leading underscore is refused (only the literal '__base__' is exempt)",
  throws(() => resolveProject("_demo")) instanceof InvalidProjectError,
);
check(
  "internal whitespace is refused",
  throws(() => resolveProject("my project")) instanceof InvalidProjectError,
);
check(
  "a slash is refused (path-shaped input)",
  throws(() => resolveProject("a/b")) instanceof InvalidProjectError,
);
check(
  "a colon is refused (would collide with the layered-id prefix)",
  throws(() => resolveProject("base:x")) instanceof InvalidProjectError,
);
check(
  "a 64-character slug is refused (one past the cap)",
  throws(() => resolveProject("a".repeat(64))) instanceof InvalidProjectError,
);
check(
  "a near-miss of the base literal ('__base__x') is refused, not silently accepted",
  throws(() => resolveProject("__base__x")) instanceof InvalidProjectError,
);

// ── the thrown error names the offending value ──────────────────────────────
const err = throws(() => resolveProject("Bad Name!"));
check(
  "the error message names the rejected value",
  !!err && err.message.includes("Bad Name!"),
  err?.message ?? "(no error)",
);
check("the error has a stable, greppable name", err?.name === "InvalidProjectError");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${total - failures}/${total}`);
process.exit(failures === 0 ? 0 : 1);
