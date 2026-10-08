// Titration MCP — local job execution (pure core).
//
// Self-hosted Titration has no durable worker.
// Queued verify/establish_baseline work runs inside the SAME stdio server process
// that accepted the tool call, over the existing `jobs` table (lib/jobs.ts). This
// module is the import-clean half of that: the small decisions the I/O shell
// (lib/local-jobs.ts) needs that are worth pinning offline — no store, no fetch,
// no Date.now()/Math.random(), env is a passed-in map (matches lib/db-connect-core.ts).

/** Bounded concurrency default: how many verify/establish jobs run at once in-process. */
export const DEFAULT_LOCAL_JOB_CONCURRENCY = 2;

/**
 * Resolve the in-process job concurrency cap from `env.TITRATION_LOCAL_JOB_CONCURRENCY`.
 * Anything that is not a positive integer (unset, blank, "0", "-1", "abc", "1.5") falls
 * back to the default rather than disabling concurrency entirely or throwing at boot —
 * a malformed override must degrade, not crash server startup.
 */
export function resolveLocalJobConcurrency(env: Record<string, string | undefined>): number {
  const raw = env.TITRATION_LOCAL_JOB_CONCURRENCY?.trim();
  if (!raw) return DEFAULT_LOCAL_JOB_CONCURRENCY;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_LOCAL_JOB_CONCURRENCY;
  return n;
}

/**
 * Several stdio servers can share one database (one per agent session), so a live
 * `queued`/`running` row may belong to another server that is still working on it.
 * The owning server refreshes each live job's `updated_at` every heartbeat; only a
 * row untouched for the stale window (four missed heartbeats) has no owner left.
 */
export const LOCAL_JOB_HEARTBEAT_MS = 30_000;
export const LOCAL_JOB_STALE_SECONDS = 120;

/** True when a live job's last heartbeat is old enough that its owning server is gone. */
export function isStaleLiveJob(ageSeconds: number): boolean {
  return Number.isFinite(ageSeconds) && ageSeconds >= LOCAL_JOB_STALE_SECONDS;
}

/** Uniform "what do we tell the store" mapping for a background job's thrown error. */
export function describeJobFailure(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The typed reason a stale `running`/`queued` verify or establish_baseline job is
 * failed with: the in-memory scheduler that owned it died with its server process,
 * so nothing will ever move it out of a non-terminal state — it must be failed, not
 * left to look "in progress" forever. goal_titrate is client-driven (the caller polls
 * and resends turns) and is never touched by this reason.
 */
export const LOCAL_JOB_RESTART_REASON =
  "server restarted before this job finished; re-run it";
