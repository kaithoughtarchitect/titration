// Titration MCP — local job execution context.
//
// Self-hosted Titration runs every job inside the stdio server process — an
// async verify/establish_baseline call is
// dispatched to `startLocalJob` (lib/local-jobs.ts) IN this process, over the
// existing `jobs` table; there is no separate durable-worker mode. The context
// below is the capability a tool handler needs to start one; it binds the project
// (internal tenant slug) the job belongs to.

const localJobCapability = Symbol("local-job-capability");

export type JobExecutionContext = {
  mode: "trusted-local";
  tenantSlug: string;
  readonly [localJobCapability]: true;
};

const JOB_QUEUE_ERROR_MESSAGES = {
  invalid_context: "Job execution context is unavailable.",
} as const;

export class JobQueueError extends Error {
  constructor(
    readonly code: keyof typeof JOB_QUEUE_ERROR_MESSAGES,
  ) {
    super(JOB_QUEUE_ERROR_MESSAGES[code]);
    this.name = "JobQueueError";
  }
}

export function createTrustedLocalJobContext(tenantSlug: string): JobExecutionContext {
  const normalized = typeof tenantSlug === "string" ? tenantSlug.trim() : "";
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(normalized)) {
    throw new JobQueueError("invalid_context");
  }
  return Object.freeze({
    mode: "trusted-local",
    tenantSlug: normalized,
    [localJobCapability]: true as const,
  });
}
