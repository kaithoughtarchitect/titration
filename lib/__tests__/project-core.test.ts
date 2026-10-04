// Titration MCP — project-core unit test (no network, no DB).
// Pins strict MCP selection separately from legacy normalization (including CLI).
// Mirrors db-connect-core.test.ts (check/total/failures + process.exit).
// Run: npx tsx lib/__tests__/project-core.test.ts

import { resolveProject, selectMcpProject, InvalidProjectError, ProjectRequiredError } from "../project-core";

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

// ── strict MCP policy: omission is never implicit default ────────────────────
const omissions = [undefined, null, "", " \t\n "];
const unsetConfigs = [undefined, "", " \t\n "];
const validProjects = ["demo", "proj_9-two", "a", "9", "a".repeat(63), "default"];
const invalidSlugs = ["Demo", "-demo", "_demo", "my project", "a/b", "base:x", "a".repeat(64), "__base__x"];
const invalidInputs: unknown[] = [42, 0, false, true, {}, [], Symbol("project"), 1n, () => "demo", ...invalidSlugs];
const invalidConfigs = [...invalidSlugs, "__base__", "  __base__  "];

for (const input of omissions) {
  for (const config of unsetConfigs) {
    const error = throws(() => selectMcpProject(input, config));
    check(`MCP missing ${JSON.stringify(input)} / config ${JSON.stringify(config)} refuses visibly`,
      error instanceof ProjectRequiredError && error.name === "ProjectRequiredError" &&
      error.message === "PROJECT_REQUIRED: pass project or configure TITRATION_PROJECT");
  }
  for (const config of validProjects) {
    check(`MCP omitted ${JSON.stringify(input)} selects trimmed config ${config}`,
      selectMcpProject(input, `  ${config}  `) === config);
  }
  for (const config of invalidConfigs) {
    const error = throws(() => selectMcpProject(input, config));
    check(`MCP omitted ${JSON.stringify(input)} refuses invalid config ${JSON.stringify(config)}`,
      error instanceof Error && error.message.startsWith("Invalid TITRATION_PROJECT:") &&
      error.message.includes(config.trim()));
  }
}

for (const input of [...validProjects, "__base__"]) {
  for (const config of [...unsetConfigs, "other-project", ...invalidConfigs]) {
    check(`MCP explicit ${input} wins over config ${JSON.stringify(config)}`,
      selectMcpProject(`  ${input}  `, config) === input);
  }
}

for (const input of invalidInputs) {
  const legacyError = throws(() => resolveProject(input));
  for (const config of [undefined, "", "configured", "Bad Config", "__base__"]) {
    const error = throws(() => selectMcpProject(input, config));
    check(`MCP invalid explicit ${String(input)} never falls back to ${JSON.stringify(config)}`,
      error instanceof InvalidProjectError && error.name === "InvalidProjectError" &&
      error.message === legacyError?.message);
  }
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${total - failures}/${total}`);
process.exit(failures === 0 ? 0 : 1);
