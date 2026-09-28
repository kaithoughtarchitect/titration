// Pure review-seed policy for the verdict flywheel.
//
// A human review inbox is a decision surface, not a drafting workspace. The I/O
// layer may enqueue only complete proposals returned by propose_cards. When the
// advisory drafter returns nothing, the capture reports a diagnostic outcome and
// creates no placeholder for the reviewer to finish.

export interface ReviewSeedCandidate {
  name: string;
  version?: string;
  summary?: string;
  deferred_scope?: string;
}

export interface ReviewSeedInput {
  kind: "verify" | "goal_titrate";
  goal: string;
  candidate?: ReviewSeedCandidate | null;
}

export interface ReviewSeedCardSpec {
  title: string;
  body: string;
}

export type ReviewCaptureStatus =
  | "not_run"
  | "proposal_enqueued"
  | "no_approval_ready_learning"
  | "failed";

export interface ReviewCaptureResult {
  status: ReviewCaptureStatus;
  proposal_count: number;
  reason: string | null;
}

function field(label: string, value: string | undefined): string | null {
  const clean = String(value ?? "").trim();
  return clean ? `${label}: ${clean}` : null;
}

export function buildReviewSeedRunSummary(
  input: ReviewSeedInput,
  spec: ReviewSeedCardSpec,
): string {
  const parts = [
    "VERIFIED OUTCOME",
    spec.title,
    spec.body,
    "IMPROVEMENT GOAL",
    String(input.goal ?? "").trim(),
  ];
  const candidate = input.candidate;
  if (candidate?.name) {
    parts.push(
      "CANDIDATE TESTED",
      ...[
        field("Name", candidate.name),
        field("Version", candidate.version),
        field("Change made", candidate.summary),
        field("Known deferred scope", candidate.deferred_scope),
      ].filter((value): value is string => value !== null),
    );
  }
  return parts.filter(Boolean).join("\n\n");
}

export function reviewCaptureNotRun(): ReviewCaptureResult {
  return { status: "not_run", proposal_count: 0, reason: null };
}

export function reviewCaptureCompleted(proposalCount: number): ReviewCaptureResult {
  const count = Number.isFinite(proposalCount) ? Math.max(0, Math.trunc(proposalCount)) : 0;
  return count > 0
    ? { status: "proposal_enqueued", proposal_count: count, reason: null }
    : {
        status: "no_approval_ready_learning",
        proposal_count: 0,
        reason: "The advisory drafter returned no complete reusable learning, so no review item was created.",
      };
}

export function reviewCaptureFailed(reason: unknown, proposalCount = 0): ReviewCaptureResult {
  const message = reason instanceof Error ? reason.message : String(reason ?? "unknown review-capture error");
  return {
    status: "failed",
    proposal_count: Math.max(0, Math.trunc(proposalCount)),
    reason: `Review proposal capture failed without affecting the verdict: ${message}`,
  };
}
