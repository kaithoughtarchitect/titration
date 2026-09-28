// Titration MCP — the shared async job store.
//
// The verdict engine's heavy tools
// (`verify`; `establish_baseline`; `goal_titrate`) are async above a size/flag
// threshold: the tool returns `{ job_id }` immediately and completion is observed
// by POLLING `job_status`. There is no durable worker in self-hosted Titration —
// queued verify/establish_baseline work runs
// in-process, in the SAME stdio server that accepted the call, via
// `startLocalJob` (lib/local-jobs.ts), over this same job store. The
// client-driven goal_titrate loop retains createJob and the job-transition
// helpers below directly.
// The existing sync-first corpus-size guard becomes the FAST-PATH SWITCH
// (`shouldRunAsync`): a small corpus still grades inline (unchanged), a large one
// is dispatched as a job so the MCP client is never blocked for minutes.
//
// The state machine is queued → running → succeeded | failed. Transitions are
// PURE (`canTransition` / `isTerminal`, offline-tested) and the DB writes enforce
// the same legal-from set in their WHERE clause, so an illegal transition (e.g.
// double-completing, reviving a terminal job) is a no-op, not a corruption.
//
// jsonb DISCIPLINE (gotcha #3a, verified 2026-06-16): write `input`/`result` with
// `${sql.json(obj as any)}` (single-encode) and read with the defensive parse —
// NEVER `${JSON.stringify(obj)}::jsonb` (postgres-js double-encodes into a jsonb
// scalar STRING, so reads come back as a string and field lookups silently operate
// on characters). The live `baselines` table still proves it (3 legacy string rows).
//
// The PURE state machine (canTransition / isTerminal / shouldRunAsync) lives in
// jobs-core.ts so it is offline-testable without a DB; this module is the postgres
// I/O layer and re-exports the core for a single import surface.

import { sql, tenantId, tenantIdForWrite, assertWritable } from "./store";
import { type JobKind, type JobStatus } from "./jobs-core";

export { canTransition, isTerminal, shouldRunAsync, SYNC_CORPUS_MAX } from "./jobs-core";
export type { DurableJobKind, JobKind, JobStatus } from "./jobs-core";
export { createTrustedLocalJobContext, JobQueueError } from "./job-queue";
export type { JobExecutionContext } from "./job-queue";

// ── job rows ────────────────────────────────────────────────────────────────

export interface JobRow {
  job_id: string;
  tenant: string;
  kind: JobKind;
  status: JobStatus;
  input: any; // lightweight request summary (NOT the full corpus)
  result: any | null; // terminal VerifyResult/EstablishResult; null until succeeded
  error: string | null;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
  // goal_titrate runs only (Issue 1, 2026-08-25): the recorded-turn count and the
  // time the latest turn landed. Before these, a mid-flight run reported status
  // "running" with result null and an updated_at frozen at turn 1, so "did my last
  // send land?" was unanswerable after a client timeout — which cost a duplicate turn
  // out of a hard budget. Absent (undefined) on verify/establish jobs.
  turn_count?: number;
  last_turn_at?: string | null;
}

const ERR_MAX = 4000; // cap stored error text

// Defensive jsonb read (gotcha #3a): postgres-js normally returns jsonb parsed,
// but any legacy double-encoded row comes back as a string — parse it so callers
// never operate on characters.
function parseJsonb(v: any): any {
  return typeof v === "string" ? JSON.parse(v) : v;
}

// Create a queued job. Tenant-scoped + writable-guarded (`__base__` rejected — a
// job is per-tenant verdict-engine state, like a baseline). `input` is a small
// summary, not the shipped corpus.
// Called directly by the client-driven goal_titrate control row and its explicit
// transitions, and by startLocalJob (lib/local-jobs.ts) for an async verify /
// establish_baseline dispatch — there is no separate durable-worker path.
export async function createJob(tenant: string, kind: JobKind, input: unknown): Promise<{ job_id: string }> {
  assertWritable(tenant);
  const tid = await tenantIdForWrite(tenant);
  const [row] = await sql`
    insert into jobs (tenant_id, kind, status, input)
    values (${tid}, ${kind}, 'queued', ${sql.json((input ?? {}) as any)})
    returning id`;
  return { job_id: row.id };
}

// queued → running. Returns false if the job was not in `queued` (already
// dispatched / terminal) — the atomic double-dispatch guard.
export async function markRunning(jobId: string): Promise<boolean> {
  const rows = await sql`
    update jobs set status = 'running', updated_at = now()
    where id = ${jobId} and status = 'queued'
    returning id`;
  return rows.length > 0;
}

// running → succeeded (no-op if the job is no longer running).
export async function completeJob(jobId: string, result: unknown): Promise<void> {
  await sql`
    update jobs
    set status = 'succeeded', result = ${sql.json((result ?? null) as any)},
        updated_at = now(), terminal_at = now()
    where id = ${jobId} and status = 'running'`;
}

// queued|running → failed (no-op if already terminal).
export async function failJob(jobId: string, error: string): Promise<void> {
  await sql`
    update jobs
    set status = 'failed', error = ${String(error).slice(0, ERR_MAX)},
        updated_at = now(), terminal_at = now()
    where id = ${jobId} and status in ('queued', 'running')`;
}

// Poll a job by id, scoped to its tenant (isolation — a tenant can't read another's
// job). Throws if it does not exist in that tenant (the caller surfaces it cleanly).
export async function getJob(tenant: string, jobId: string): Promise<JobRow> {
  const tid = await tenantId(tenant);
  const [r] = await sql`
    select id, kind, status, input, result, error, created_at, updated_at, terminal_at
    from jobs where id = ${jobId} and tenant_id = ${tid}`;
  if (!r) throw new Error(`job '${jobId}' not found in tenant '${tenant}'`);
  const row: JobRow = {
    job_id: r.id,
    tenant,
    kind: r.kind,
    status: r.status,
    input: r.input == null ? null : parseJsonb(r.input),
    result: r.result == null ? null : parseJsonb(r.result),
    error: r.error,
    created_at: r.created_at,
    updated_at: r.updated_at,
    terminal_at: r.terminal_at,
  };
  // Issue 1 (2026-08-25): a goal_titrate run's only progress signal is its turn
  // history — surface it on the poll handle so a caller can answer "did my last send
  // land?" without a dashboard. Tenant-scoped like everything else here. FAIL-OPEN:
  // job_status is the RECOVERY handle a timed-out caller reaches for — an enrichment
  // failure must degrade to the pre-2026-08-25 shape (fields absent), never turn a
  // working poll into a hard error.
  if (r.kind === "goal_titrate") {
    try {
      const [t] = await sql`
        select count(*)::int as turn_count, max(created_at) as last_turn_at
        from goal_titrate_turns where job_id = ${jobId} and tenant_id = ${tid}`;
      row.turn_count = t?.turn_count ?? 0;
      row.last_turn_at = t?.last_turn_at ?? null;
    } catch (e) {
      console.error("[jobs] turn_count enrichment failed (fail-open, fields omitted):", e);
    }
  }
  return row;
}

// Legacy/test-only fire-and-forget runner with no production caller — superseded
// by lib/local-jobs.ts's startLocalJob (bounded concurrency, in-memory FIFO) for
// the async verify/establish_baseline dispatch. The smoke harness has ALREADY
// created `{ job_id }`; this drives queued → running → succeeded|failed and NEVER
// throws to the caller — a failure lands in the job row as status='failed'
// (labeled, never silent). The markRunning guard makes a duplicate dispatch a
// no-op. Client-driven goal_titrate retains the explicit transition helpers above.
export function runJobAsync(jobId: string, fn: () => Promise<unknown>): void {
  void (async () => {
    const moved = await markRunning(jobId).catch(() => false);
    if (!moved) return; // already running / terminal — don't double-run
    try {
      const result = await fn();
      await completeJob(jobId, result);
    } catch (e: any) {
      await failJob(jobId, String(e?.message ?? e)).catch(() => {});
    }
  })();
}
