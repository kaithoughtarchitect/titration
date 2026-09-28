// Titration MCP — evolution-note + typed tool-error taxonomy (pure core).
//
// The symbols below are needed by the stdio dispatch (server/mcp-server.ts):
// evolutionNoteRefusal/MAX_EVOLUTION_NOTE_CHARS gate goal_titrate_step's
// evolution.note, and createInteractiveWorkflowError + InteractiveWorkflowErrorCode
// back McpProductError's typed tool errors.
// Import-clean: no store/fetch/clock — no Date.now()/Math.random().

/**
 * The evolution note is a display-provenance line, not a changelog. The cap is enforced on BOTH
 * call sites that touch it (the goal_titrate_step guard and the repair parser); exporting it keeps
 * the published tool schema, the refusal message and the parser from drifting apart — a caller that
 * cannot see the limit sends a 2 KB note, is refused, and has no way to tell an over-long field
 * from an outage.
 */
export const MAX_EVOLUTION_NOTE_CHARS = 500;

/**
 * The ONE validator for evolution.note, shared by every call site that accepts one: the
 * goal_titrate_step guard, the repair parser, and the goal_titrate_step dispatch itself. Returns a
 * refusal reason, or null when the note is acceptable.
 *
 * Why it is shared rather than repeated: publishing `maxLength` on a schema whose handler enforces
 * something different is exactly the defect class this change set exists to fix. The dispatch
 * previously trimmed and checked only for emptiness — no cap at all — so adding maxLength
 * to its published schema made the contract and the runtime disagree where they had previously
 * agreed (both unbounded). Three near-identical checks is how that drift happens; one function
 * that every call site calls is how it stops.
 *
 * Length is measured on the RAW string, exactly as JSON Schema `maxLength` measures it, so any
 * input the schema accepts the runtime accepts and vice versa. Raw <= N implies trimmed <= N, so
 * this is also the stronger check.
 */
export function evolutionNoteRefusal(rawNote: unknown): string | null {
  if (typeof rawNote !== "string" || rawNote.trim() === "") {
    return "evolution.note must be a non-empty string";
  }
  if (rawNote.length > MAX_EVOLUTION_NOTE_CHARS) {
    return `evolution.note exceeds ${MAX_EVOLUTION_NOTE_CHARS} characters (counted before trimming, matching the published maxLength)`;
  }
  return null;
}

function requiredString(
  value: unknown,
  label: string,
  maxLength = 512,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`${label} exceeds ${maxLength} characters`);
  }
  return normalized;
}

export const INTERACTIVE_WORKFLOW_ERROR_CODES = [
  "bad_request",
  "not_found",
  "conflict",
  "in_progress",
  "service_unavailable",
] as const;

export type InteractiveWorkflowErrorCode =
  typeof INTERACTIVE_WORKFLOW_ERROR_CODES[number];

export interface InteractiveWorkflowError {
  code: InteractiveWorkflowErrorCode;
  message: string;
  retryable: boolean;
}

export function isInteractiveWorkflowErrorCode(
  value: unknown,
): value is InteractiveWorkflowErrorCode {
  return typeof value === "string"
    && (INTERACTIVE_WORKFLOW_ERROR_CODES as readonly string[]).includes(value);
}

export function isInteractiveWorkflowErrorRetryable(
  code: InteractiveWorkflowErrorCode,
): boolean {
  return code === "in_progress" || code === "service_unavailable";
}

/**
 * `retryable` is normally DERIVED from `code`, and that stays the default for every caller.
 *
 * `retryableOverride` exists for exactly one case: a POSITIVELY IDENTIFIED permanent server fault
 * that must be published as non-retryable while the five-code taxonomy has no non-retryable
 * server-fault member to name it with. `retryable` is not advisory — the default-sync composition
 * fires an automatic same-token retry on it — so publishing `true` for a fault that can never
 * succeed is a correctness bug, not a labelling one (SQLSTATE 42501 incident, 2026-08-21).
 *
 * This is a deliberate, bounded break of the code->retryable purity invariant, and it is a
 * COMPATIBILITY SHIM, not the destination. The settled contract (5-seat cross-vendor council +
 * independent audit, 2026-08-21) adds a sixth code, `internal_error`, which is honest on the wire
 * and needs no override at all — `internal_error` is simply absent from the retryable set, so
 * purity is restored by construction. That is a published-taxonomy revision requiring re-acceptance
 * by the two accepted vendors, so it ships behind version negotiation; until a client opts in, this
 * override is how a permanent fault stops lying to it. Retire the override once both vendors are on
 * the new revision.
 *
 * Do NOT reach for this to express anything else. Every other non-retryable condition already has
 * an honest code.
 */
export function createInteractiveWorkflowError(
  code: unknown,
  message: unknown,
  retryableOverride?: boolean,
): InteractiveWorkflowError {
  if (!isInteractiveWorkflowErrorCode(code)) {
    throw new Error("invalid interactive workflow error code");
  }
  return {
    code,
    message: requiredString(message, "error message", 500),
    retryable: retryableOverride === undefined
      ? isInteractiveWorkflowErrorRetryable(code)
      : retryableOverride,
  };
}
