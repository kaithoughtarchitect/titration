// Titration MCP — project name normalizer (PURE, import-free).
//
// Callers/users say "project"; internal code and the DB
// keep the existing "tenant" naming (the `tenants` table, `tenant_id` columns,
// every internal function parameter). This module is the ONE seam that maps the
// public `project` argument tool schemas expose to the internal tenant slug —
// nothing downstream needs to know the word "project" exists.
//
// Mandatory MCP scope is repository-bound in automatic factories;
// legacy factories use selectMcpProject: explicit, configured, or refused.
// resolveProject retains legacy defaulting for callers such as the search CLI.
// Reads of an unknown project behave as an empty project
// (never an "unknown tenant" throw — see lib/store.ts's non-throwing lookup); the
// first write creates it (lib/store.ts's `tenantIdForWrite`). This module only
// validates/normalizes the NAME; it does no I/O and knows nothing about reads,
// writes, or the DB.
//
// No Date.now()/Math.random()/imports — offline-tested by project-core.test.ts.

// Lowercase letters/digits, then any run of lowercase/digit/underscore/hyphen —
// mirrors the shape of the `tenants.slug` values already in the schema (e.g.
// `__base__`, `default`) while forbidding whitespace, uppercase, and path/URL
// metacharacters a tenant slug must never carry into a SQL identifier context or
// a log line. Capped at 63 characters (one MORE than the leading character, i.e.
// 63 total) — comfortably inside Postgres's own 63-byte identifier limit, though
// `slug` is a plain `text` column, not an identifier.
const PROJECT_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

// The one read-only curated tenant a caller is allowed to NAME explicitly (to
// read it) even though it fails the slug pattern above (leading/trailing `__`).
const BASE_PROJECT = "__base__";

export class ProjectRequiredError extends Error {
  constructor() {
    super("PROJECT_REQUIRED: pass project or configure TITRATION_PROJECT");
    this.name = "ProjectRequiredError";
  }
}

export class InvalidProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProjectError";
  }
}

/**
 * Legacy normalization into the internal tenant slug (including CLI defaulting).
 * Mandatory MCP calls bind repository scope, or use selectMcpProject in legacy
 * factories, before downstream normalization.
 *
 * - `undefined` / `null` / an empty (or whitespace-only) string -> `"default"`.
 * - a non-string value -> `InvalidProjectError` (the schema declares `project` as
 *   a string; a caller that ignores the schema gets a named reason, not a silent
 *   coercion).
 * - exactly `"__base__"` (after trim) -> returned as-is; callers may explicitly
 *   read the curated base project, but every write path still refuses it
 *   (`assertWritable` in lib/store.ts) — this function does not know write from
 *   read.
 * - anything else must match `PROJECT_SLUG_PATTERN`, else `InvalidProjectError`
 *   names the offending value and the required shape.
 */
export function resolveProject(input: unknown): string {
  if (input === undefined || input === null) return "default";
  if (typeof input !== "string") {
    throw new InvalidProjectError(
      `project must be a string; got ${typeof input}`,
    );
  }
  const trimmed = input.trim();
  if (!trimmed) return "default";
  if (trimmed === BASE_PROJECT) return trimmed;
  if (!PROJECT_SLUG_PATTERN.test(trimmed)) {
    throw new InvalidProjectError(
      `invalid project name '${trimmed}': must match ${PROJECT_SLUG_PATTERN.source} ` +
        `(lowercase letters, digits, '_' or '-', starting with a letter or digit) or be exactly '${BASE_PROJECT}'`,
    );
  }
  return trimmed;
}

/** Select mandatory MCP scope without implicitly choosing the legacy default. */
export function selectMcpProject(input: unknown, configuredProject?: string): string {
  const omitted = input === undefined || input === null ||
    (typeof input === "string" && input.trim() === "");
  if (!omitted) return resolveProject(input);

  const configured = configuredProject?.trim();
  if (!configured) throw new ProjectRequiredError();
  if (configured === BASE_PROJECT) {
    throw new Error(`Invalid TITRATION_PROJECT: '${BASE_PROJECT}' cannot be a configured default`);
  }
  try {
    return resolveProject(configured);
  } catch (error) {
    if (error instanceof InvalidProjectError) {
      throw new Error(`Invalid TITRATION_PROJECT: ${error.message}`);
    }
    throw error;
  }
}
