// Titration — upcoming-run referee turn budget (PURE, import-free, offline-tested).
// Allowed counts are the picker chips 1–10 — every integer in one sitting.
// Not panel identity. Engine omit-default remains 20 for callers that skip
// the picker. No Date.now / Math.random.
// ceiling: the pick reaches the engine only because the oauth improve skill
// passes status run_budget as goal_titrate.budget (advisory, Player-honored);
// upgrade: inject server-side at the goal_titrate seam if the engine
// unfreezes.

export const REFEREE_RUN_BUDGETS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export type RefereeRunBudget = (typeof REFEREE_RUN_BUDGETS)[number];

const BUDGET_SET: ReadonlySet<number> = new Set(REFEREE_RUN_BUDGETS);

export function isRefereeRunBudget(value: unknown): value is RefereeRunBudget {
  return typeof value === "number" && Number.isInteger(value) && BUDGET_SET.has(value);
}

/** Confirm: missing/out-of-set → null. Caller maps null to invalid_run_budget. */
export function parseRequiredRunBudget(value: unknown): RefereeRunBudget | null {
  return isRefereeRunBudget(value) ? value : null;
}

/** Snapshot/status: absent/null/invalid → null. Must not throw (legacy rows). */
export function parseOptionalRunBudget(value: unknown): RefereeRunBudget | null {
  return isRefereeRunBudget(value) ? value : null;
}

/**
 * Status-boundary provenance of the count: "set" (an allowed count is stored),
 * "legacy" (the row predates the picker count), "corrupt" (a stored count was
 * present but unreadable — dropped fail-open, run falls back to engine 20).
 */
export type RefereeRunBudgetState = "set" | "legacy" | "corrupt";

/** Derive the state from a parsed snapshot. Never throws; never invents a count. */
export function runBudgetStateFromSnapshot(snapshot: {
  run_budget?: unknown;
  run_budget_corrupt?: unknown;
}): RefereeRunBudgetState {
  if (isRefereeRunBudget(snapshot.run_budget)) return "set";
  return snapshot.run_budget_corrupt === true ? "corrupt" : "legacy";
}
