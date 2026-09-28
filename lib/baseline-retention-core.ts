// Titration MCP — the per-row grade RETENTION decision (pure core).
//
// WHY THIS FILE EXISTS. The whole opt-in retention contract hinges on one expression: does this
// call persist the per-row grades, or not? That expression used to live inline in
// `establishBaseline`, which is an I/O shell — it imports `insertBaseline` from the store, so
// importing it in a test drags in a live database credential. The single most load-bearing line in
// the feature was therefore unreachable by every offline gate: deleting it (always `null`) would
// silently persist nothing behind a 2xx receipt, and inverting it (`!== true`) would persist judge
// verdicts for callers who never asked — and both mutations passed the entire suite.
//
// Import-clean by contract: no store, no fetch, no Date.now(), no randomness.

/**
 * Decide what goes in the `per_row` column for one `establish_baseline` call.
 *
 * STRICT `=== true` on purpose: a truthy non-boolean (`"true"`, `1`) must NEVER opt a caller in to
 * a persistent write they did not ask for. The doors reject non-booleans loudly before reaching
 * here; this is the second line of defence, not the first.
 *
 * Returns `null` — never `undefined` — because the store branches on `per_row == null` to choose
 * the pre-migration column list, and an `undefined` leaking through would read as "not retained"
 * while being a different value than the one the store contract documents.
 */
export function resolveRetainedRows<T>(
  retainRows: unknown,
  rows: readonly T[] | undefined,
): T[] | null {
  if (retainRows !== true) return null;
  if (!Array.isArray(rows)) return null;
  return rows as T[];
}

/**
 * The store's INSERT arm selector, extracted so the routing itself is pinnable offline.
 *
 * `true`  → bind the `per_row` column (the db/040-dependent arm).
 * `false` → use the pre-040 column list verbatim, so a database that has not applied db/040 is
 *           completely unaffected on the default path.
 *
 * Swapping these arms would make EVERY baseline write depend on db/040 — defeating the exact
 * backward-compatibility guarantee the two-arm design exists to provide — so the decision is a
 * named, tested function rather than an inline ternary a reviewer has to eyeball.
 */
export function shouldBindPerRowColumn(perRow: unknown): boolean {
  return perRow != null;
}
