// Titration MCP — local job execution (I/O shell).
//
// Queued work runs in the stdio server process
// over the existing `jobs` table; progress visible through `job_status`; stale
// `running` rows from a dead process are failed on boot with a typed reason.
//
// There is no durable worker in this build (see lib/job-queue.ts) — a verify /
// establish_baseline call that is dispatched async runs `run()` right here, inside
// the SAME process that accepted the MCP tool call, tracked through the same
// queued → running → succeeded|failed jobs row every sync call already writes
// (lib/jobs.ts). Two guarantees this module exists to hold:
//   1. The server process must NEVER crash from a background job — every failure
//      mode (the grading call throwing, the store itself throwing) is caught and
//      lands on the job row as `failed`, never an unhandled rejection.
//   2. A caller only ever sees the SAME grading result shape it would have gotten
//      synchronously — `startLocalJob`'s `run` closure is exactly the sync call,
//      just not awaited by the tool handler (mcp-server.ts).
//
// Bounded in-process concurrency (default 2, `TITRATION_LOCAL_JOB_CONCURRENCY`):
// extra jobs wait in an in-memory FIFO queue. That queue is NOT durable — it dies
// with the process, which is exactly why failStaleRunningJobs() below exists. Several
// servers may share one database, so ownership is a heartbeat on `updated_at`, not
// "whatever is running when I start".

import { sql } from "./store";
import { createJob, markRunning, completeJob, failJob, touchJob, failStaleJob } from "./jobs";
import { isDurableJobKind, type DurableJobKind, type JobKind, type JobStatus } from "./jobs-core";
import {
  resolveLocalJobConcurrency,
  describeJobFailure,
  isStaleLiveJob,
  LOCAL_JOB_HEARTBEAT_MS,
  LOCAL_JOB_RESTART_REASON,
  LOCAL_JOB_STALE_SECONDS,
} from "./local-jobs-core";

// ── scheduler ────────────────────────────────────────────────────────────────

export interface LocalJobStoreDeps {
  createJob: typeof createJob;
  markRunning: typeof markRunning;
  completeJob: typeof completeJob;
  failJob: typeof failJob;
  touchJob: typeof touchJob;
}

const defaultStoreDeps: LocalJobStoreDeps = { createJob, markRunning, completeJob, failJob, touchJob };

export interface LocalJobRunner {
  startLocalJob(
    tenant: string,
    kind: DurableJobKind,
    input: unknown,
    run: () => Promise<unknown>,
  ): Promise<{ job_id: string }>;
}

export interface CreateLocalJobRunnerOptions {
  concurrency?: number;
  deps?: Partial<LocalJobStoreDeps>;
  env?: Record<string, string | undefined>;
  heartbeatMs?: number;
}

/**
 * Build an in-process job runner. Exported (rather than only a module-level
 * singleton) so the offline suite can inject fake store functions and a small
 * concurrency cap without touching a real database or the shared production
 * scheduler — `startLocalJob` below is the one production instance.
 */
export function createLocalJobRunner(options: CreateLocalJobRunnerOptions = {}): LocalJobRunner {
  const deps: LocalJobStoreDeps = { ...defaultStoreDeps, ...options.deps };
  const concurrency = options.concurrency ?? resolveLocalJobConcurrency(options.env ?? process.env);

  let inFlight = 0;
  const queue: Array<() => Promise<void>> = [];

  // Every job this process owns (queued in the FIFO or running) is heartbeated so
  // another server's stale sweep never mistakes it for an orphan.
  const live = new Set<string>();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  function own(jobId: string): void {
    live.add(jobId);
    heartbeat ??= setInterval(() => {
      for (const id of live) {
        deps.touchJob(id).catch((e) => console.error(`[local-jobs] heartbeat for job ${id} failed (fail-open):`, e));
      }
    }, options.heartbeatMs ?? LOCAL_JOB_HEARTBEAT_MS);
    heartbeat.unref?.();
  }
  function release(jobId: string): void {
    live.delete(jobId);
    if (live.size === 0 && heartbeat) { clearInterval(heartbeat); heartbeat = undefined; }
  }

  function runTask(task: () => Promise<void>): void {
    inFlight++;
    void task().finally(() => {
      inFlight--;
      const next = queue.shift();
      if (next) runTask(next);
    });
  }

  function schedule(task: () => Promise<void>): void {
    if (inFlight < concurrency) runTask(task);
    else queue.push(task);
  }

  // Never rejects: every failure mode inside — markRunning/run/completeJob throwing,
  // or failJob itself throwing while reporting a prior failure — is caught, logged
  // with console.error, and (best-effort) recorded on the job row. A background job
  // must never turn into an unhandled rejection that could bring the process down.
  async function execute(jobId: string, kind: DurableJobKind, run: () => Promise<unknown>): Promise<void> {
    try {
      const moved = await deps.markRunning(jobId);
      if (!moved) return; // already running/terminal — nothing to do (defensive; single scheduler owns dispatch)
      try {
        const result = await run();
        await deps.completeJob(jobId, result);
      } catch (e) {
        console.error(`[local-jobs] ${kind} job ${jobId} failed:`, e);
        await deps.failJob(jobId, describeJobFailure(e));
      }
    } catch (e) {
      console.error(`[local-jobs] ${kind} job ${jobId} — unexpected scheduler failure:`, e);
      await deps.failJob(jobId, describeJobFailure(e)).catch((inner) => {
        console.error(`[local-jobs] ${kind} job ${jobId} — could not record the failure:`, inner);
      });
    } finally {
      release(jobId);
    }
  }

  async function startLocalJob(
    tenant: string,
    kind: DurableJobKind,
    input: unknown,
    run: () => Promise<unknown>,
  ): Promise<{ job_id: string }> {
    const { job_id } = await deps.createJob(tenant, kind, input);
    own(job_id);
    schedule(() => execute(job_id, kind, run));
    return { job_id };
  }

  return { startLocalJob };
}

const productionRunner = createLocalJobRunner();

/**
 * Start a verify / establish_baseline job: creates the `jobs` row (queued), returns
 * `{ job_id }` immediately, then runs `run()` in the background inside THIS process —
 * markRunning → completeJob(result) | failJob(error). Bounded concurrency; extra
 * calls wait in an in-memory FIFO. `input` should be the same lightweight request
 * summary job_status has always reported (never the full corpus, never secrets).
 */
export const startLocalJob = productionRunner.startLocalJob;

// ── boot sweep ───────────────────────────────────────────────────────────────

export interface StaleJobRow {
  id: string;
  kind: JobKind;
  status: JobStatus;
  /** Seconds since the row's last heartbeat, measured by the database clock. */
  ageSeconds: number;
}

export interface FailStaleRunningJobsDeps {
  listLiveJobs: () => Promise<StaleJobRow[]>;
  /** Resolves false when the row turned out not to be stale (its owner touched it). */
  failJob: (jobId: string, error: string) => Promise<boolean | void>;
}

const defaultSweepDeps: FailStaleRunningJobsDeps = {
  listLiveJobs: async () => {
    const rows = await sql`
      select id, kind, status, extract(epoch from (now() - updated_at))::float8 as age_seconds
      from jobs where status in ('queued', 'running')`;
    return rows.map((r: any) => ({
      id: String(r.id), kind: r.kind as JobKind, status: r.status as JobStatus, ageSeconds: Number(r.age_seconds),
    }));
  },
  failJob: (jobId, error) => failStaleJob(jobId, error, LOCAL_JOB_STALE_SECONDS),
};

/**
 * Stale sweep (at boot and periodically): a `running`/`queued` verify or
 * establish_baseline job whose heartbeat stopped is a dead man's row — the in-memory
 * scheduler that owned it (and its FIFO queue) died with its server, so nothing will
 * ever move it out of a non-terminal state. Fail each one with the typed
 * LOCAL_JOB_RESTART_REASON so a caller polling job_status gets a clear "re-run it"
 * instead of a poll that hangs forever. Jobs with a recent heartbeat belong to
 * another live server sharing this database and are never touched.
 *
 * goal_titrate is client-driven (the caller itself resends/polls turns) and is
 * deliberately excluded — `isDurableJobKind` is the same verify/establish_baseline
 * set lib/jobs-core.ts already defines for durable dispatch.
 *
 * Fail-open at every layer: a listing failure sweeps nothing (logged, never thrown —
 * a boot-time DB hiccup must not crash server startup); a single row's failJob
 * failing is logged and the sweep continues with the rest.
 */
export async function failStaleRunningJobs(
  now: Date = new Date(),
  deps: FailStaleRunningJobsDeps = defaultSweepDeps,
): Promise<{ failed: string[] }> {
  let rows: StaleJobRow[];
  try {
    rows = await deps.listLiveJobs();
  } catch (e) {
    console.error("[local-jobs] boot sweep: could not list live jobs (fail-open, nothing swept):", e);
    return { failed: [] };
  }

  const failed: string[] = [];
  for (const row of rows) {
    if (!isDurableJobKind(row.kind)) continue; // goal_titrate is client-driven — never swept
    if (!isStaleLiveJob(row.ageSeconds)) continue; // a live server still owns it
    try {
      if ((await deps.failJob(row.id, LOCAL_JOB_RESTART_REASON)) === false) continue;
      failed.push(row.id);
    } catch (e) {
      console.error(`[local-jobs] stale sweep: could not fail stale job ${row.id} (fail-open):`, e);
    }
  }

  if (failed.length > 0) {
    console.error(
      `[local-jobs] stale sweep at ${now.toISOString()}: failed ${failed.length} job(s) whose server stopped before they finished:`,
      failed,
    );
  }
  return { failed };
}
