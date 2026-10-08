// Titration MCP — local job execution unit test (no network, no real DB, no model).
//
// Pins the in-process scheduler (lib/local-jobs.ts) self-hosted Titration runs
// async verify/establish_baseline work through, and the boot sweep that fails
// jobs a dead process left non-terminal. Every DB write is an INJECTED fake —
// createLocalJobRunner / failStaleRunningJobs take deps precisely so this suite
// never opens a real Postgres connection.
//
// Import note: lib/local-jobs.ts imports lib/store.ts, which throws at import
// time if TITRATION_DATABASE_URL is unset — set a dummy value BEFORE the dynamic
// import below (mirrors lib/__tests__/progress-keepalive.test.ts). The real `sql`
// client is never invoked: only the injected fakes are exercised.
//
// Run: npx tsx lib/__tests__/local-jobs.test.ts

import {
  resolveLocalJobConcurrency,
  describeJobFailure,
  LOCAL_JOB_RESTART_REASON,
  DEFAULT_LOCAL_JOB_CONCURRENCY,
  LOCAL_JOB_HEARTBEAT_MS,
  LOCAL_JOB_STALE_SECONDS,
  isStaleLiveJob,
} from "../local-jobs-core";
import { isDurableJobKind, type JobKind } from "../jobs-core";

process.env.TITRATION_DATABASE_URL ??= "postgres://127.0.0.1:1/titration-offline-import-only";
const { createLocalJobRunner, failStaleRunningJobs } = await import("../local-jobs");

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail = "") {
  total++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}

// The whole point of the scheduler: a background job throwing must NEVER become
// an unhandled rejection that could bring the stdio process down.
const unhandled: unknown[] = [];
process.on("unhandledRejection", (reason) => { unhandled.push(reason); });

async function flush(ticks = 3): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 0));
}

// ── pure helpers (local-jobs-core.ts) ─────────────────────────────────────────

check("resolveLocalJobConcurrency: unset env → default", resolveLocalJobConcurrency({}) === DEFAULT_LOCAL_JOB_CONCURRENCY);
check("resolveLocalJobConcurrency: blank → default", resolveLocalJobConcurrency({ TITRATION_LOCAL_JOB_CONCURRENCY: "  " }) === DEFAULT_LOCAL_JOB_CONCURRENCY);
check("resolveLocalJobConcurrency: '0' → default (never disables concurrency)", resolveLocalJobConcurrency({ TITRATION_LOCAL_JOB_CONCURRENCY: "0" }) === DEFAULT_LOCAL_JOB_CONCURRENCY);
check("resolveLocalJobConcurrency: negative → default", resolveLocalJobConcurrency({ TITRATION_LOCAL_JOB_CONCURRENCY: "-1" }) === DEFAULT_LOCAL_JOB_CONCURRENCY);
check("resolveLocalJobConcurrency: non-numeric → default", resolveLocalJobConcurrency({ TITRATION_LOCAL_JOB_CONCURRENCY: "abc" }) === DEFAULT_LOCAL_JOB_CONCURRENCY);
check("resolveLocalJobConcurrency: non-integer → default", resolveLocalJobConcurrency({ TITRATION_LOCAL_JOB_CONCURRENCY: "1.5" }) === DEFAULT_LOCAL_JOB_CONCURRENCY);
check("resolveLocalJobConcurrency: valid override honored", resolveLocalJobConcurrency({ TITRATION_LOCAL_JOB_CONCURRENCY: "5" }) === 5);
check("resolveLocalJobConcurrency: whitespace-padded override honored", resolveLocalJobConcurrency({ TITRATION_LOCAL_JOB_CONCURRENCY: " 3 " }) === 3);

check("describeJobFailure: Error → its message", describeJobFailure(new Error("boom")) === "boom");
check("describeJobFailure: non-Error thrown value → String(...)", describeJobFailure("plain string") === "plain string");

check("LOCAL_JOB_RESTART_REASON names the restart", /restart/i.test(LOCAL_JOB_RESTART_REASON));
check("LOCAL_JOB_RESTART_REASON tells the caller what to do", /re-run/i.test(LOCAL_JOB_RESTART_REASON));

check("isDurableJobKind: verify is durable", isDurableJobKind("verify") === true);
check("isDurableJobKind: establish_baseline is durable", isDurableJobKind("establish_baseline") === true);
check("isDurableJobKind: goal_titrate is NOT durable (client-driven)", isDurableJobKind("goal_titrate") === false);

// ── startLocalJob: fake store, no real DB ─────────────────────────────────────

type FakeCreateJob = (tenant: string, kind: JobKind, input: unknown) => Promise<{ job_id: string }>;

function makeFakeStore() {
  let counter = 0;
  const created: Array<{ tenant: string; kind: JobKind; input: unknown }> = [];
  const markRunningCalls: string[] = [];
  const completed: Array<{ jobId: string; result: unknown }> = [];
  const failed: Array<{ jobId: string; error: string }> = [];

  const createJob: FakeCreateJob = async (tenant, kind, input) => {
    const job_id = `job-${++counter}`;
    created.push({ tenant, kind, input });
    return { job_id };
  };
  const markRunning = async (jobId: string): Promise<boolean> => {
    markRunningCalls.push(jobId);
    return true;
  };
  const completeJob = async (jobId: string, result: unknown): Promise<void> => {
    completed.push({ jobId, result });
  };
  const failJob = async (jobId: string, error: string): Promise<void> => {
    failed.push({ jobId, error });
  };

  const touched: string[] = [];
  const touchJob = async (jobId: string): Promise<void> => {
    touched.push(jobId);
  };

  return { created, markRunningCalls, completed, failed, touched, deps: { createJob, markRunning, completeJob, failJob, touchJob } };
}

// 1) completes → succeeded with result; returns { job_id } immediately (before run() settles).
{
  const store = makeFakeStore();
  const runner = createLocalJobRunner({ concurrency: 2, deps: store.deps });
  let runStarted = false;
  let resolveRun!: (v: { ok: true }) => void;
  const runPromise = new Promise<{ ok: true }>((res) => { resolveRun = res; });

  const { job_id } = await runner.startLocalJob("proj-a", "verify", { baseline_id: "b1" }, async () => {
    runStarted = true;
    return runPromise;
  });

  check("startLocalJob: input recorded via createJob (never the full corpus by construction of the caller)", store.created.length === 1 && store.created[0]!.kind === "verify" && store.created[0]!.tenant === "proj-a");
  check("startLocalJob returns { job_id } before the background run finishes", typeof job_id === "string" && job_id.length > 0);

  await flush();
  check("run() has started by now (markRunning happened, admitted immediately — only 1 job, well under the cap)", runStarted && store.markRunningCalls.includes(job_id));
  check("not completed yet — run() is still pending", store.completed.length === 0);

  resolveRun({ ok: true });
  await flush();
  check("completeJob called with the job's own result once run() resolves", store.completed.length === 1 && store.completed[0]!.jobId === job_id && (store.completed[0]!.result as any).ok === true);
  check("failJob never called on the success path", store.failed.length === 0);
}

// 2) throw → failed with message, no crash.
{
  const store = makeFakeStore();
  const runner = createLocalJobRunner({ concurrency: 2, deps: store.deps });

  const { job_id } = await runner.startLocalJob("proj-b", "establish_baseline", { rubric: "r" }, async () => {
    throw new Error("grading blew up");
  });
  await flush();

  check("a thrown run() lands the job as failed with the error message", store.failed.length === 1 && store.failed[0]!.jobId === job_id && store.failed[0]!.error === "grading blew up");
  check("completeJob is never called on the failure path", store.completed.length === 0);
}

// 2b) a synchronous throw inside run() (before it even returns a promise) is caught the same way.
{
  const store = makeFakeStore();
  const runner = createLocalJobRunner({ concurrency: 2, deps: store.deps });

  const { job_id } = await runner.startLocalJob("proj-b2", "verify", {}, () => {
    throw new Error("sync boom");
  });
  await flush();

  check("a run() that throws synchronously (never returns a promise) still fails the job, not the process", store.failed.length === 1 && store.failed[0]!.jobId === job_id && store.failed[0]!.error === "sync boom");
}

// 3) concurrency cap respected: a 3rd job waits until one of the first two finishes.
// BOTH of the first two jobs are gated (never a same-tick resolve) so there is no
// race between "job 2 finishes on its own" and "job 3 gets scheduled" — the only
// way job 3 can start is the scheduler admitting it into a slot we explicitly free.
{
  const store = makeFakeStore();
  const runner = createLocalJobRunner({ concurrency: 2, deps: store.deps });
  const started: string[] = [];
  let resolveJob1!: () => void;
  let resolveJob2!: () => void;
  const job1Gate = new Promise<void>((res) => { resolveJob1 = res; });
  const job2Gate = new Promise<void>((res) => { resolveJob2 = res; });

  const { job_id: id1 } = await runner.startLocalJob("t", "verify", {}, async () => { started.push("j1"); await job1Gate; return "r1"; });
  const { job_id: id2 } = await runner.startLocalJob("t", "verify", {}, async () => { started.push("j2"); await job2Gate; return "r2"; });
  const { job_id: id3 } = await runner.startLocalJob("t", "verify", {}, async () => { started.push("j3"); return "r3"; });

  await flush();
  check("job 1 admitted immediately (cap is 2)", started.includes("j1"));
  check("job 2 admitted immediately (cap is 2)", started.includes("j2"));
  check("job 3 waits in the FIFO — both slots are held by job 1 and job 2", !started.includes("j3"));
  check("job 3 has not even been marked running yet (still queued)", !store.markRunningCalls.includes(id3));

  resolveJob1(); // job 1 finishes, freeing exactly one concurrency slot
  await flush();

  check("job 3 starts once job 1 frees a slot", started.includes("j3"));
  check("job 1 completed with its own result", store.completed.some((c) => c.jobId === id1 && c.result === "r1"));
  check("job 2 has NOT completed yet — still gated, holding its slot", !store.completed.some((c) => c.jobId === id2));

  resolveJob2(); // job 2 finishes; job 3 (admitted above) finishes on its own
  await flush();

  check("job 2 completed with its own result", store.completed.some((c) => c.jobId === id2 && c.result === "r2"));
  check("job 3 completed with its own result", store.completed.some((c) => c.jobId === id3 && c.result === "r3"));
  check("exactly 3 jobs were created, no duplicates", store.created.length === 3);
}

// 4) an unexpected throw from the STORE itself (not the grading call) still never crashes —
// the row is best-effort failed and the scheduler moves on.
{
  const store = makeFakeStore();
  const flakyDeps = {
    ...store.deps,
    markRunning: async (_jobId: string) => { throw new Error("db hiccup"); },
  };
  const runner = createLocalJobRunner({ concurrency: 2, deps: flakyDeps });

  const { job_id } = await runner.startLocalJob("t", "verify", {}, async () => "never reached");
  await flush();

  check("markRunning throwing is caught and best-effort recorded via failJob", store.failed.length === 1 && store.failed[0]!.jobId === job_id);
}

// ── failStaleRunningJobs: fake listing, no real DB ────────────────────────────

// 5) boot sweep only touches verify/establish rows — goal_titrate is client-driven.
{
  const rows = [
    { id: "r1", kind: "verify" as JobKind, status: "running" as const, ageSeconds: 600 },
    { id: "r2", kind: "establish_baseline" as JobKind, status: "queued" as const, ageSeconds: 600 },
    { id: "r3", kind: "goal_titrate" as JobKind, status: "running" as const, ageSeconds: 600 },
    { id: "r4", kind: "goal_titrate" as JobKind, status: "queued" as const, ageSeconds: 600 },
  ];
  const failedCalls: Array<{ jobId: string; error: string }> = [];
  const { failed } = await failStaleRunningJobs(new Date("2026-09-26T00:00:00Z"), {
    listLiveJobs: async () => rows,
    failJob: async (jobId, error) => { failedCalls.push({ jobId, error }); },
  });

  check("sweep fails the verify row", failed.includes("r1"));
  check("sweep fails the establish_baseline row", failed.includes("r2"));
  check("sweep does NOT touch the running goal_titrate row (client-driven)", !failed.includes("r3"));
  check("sweep does NOT touch the queued goal_titrate row (client-driven)", !failed.includes("r4"));
  check("exactly the 2 durable rows were failed, nothing else", failed.length === 2 && failedCalls.length === 2);
  check("every swept row uses the typed restart reason", failedCalls.every((c) => c.error === LOCAL_JOB_RESTART_REASON));
}

// 6) boot sweep is fail-open: a listing failure sweeps nothing rather than throwing.
{
  let threw = false;
  let result: { failed: string[] } | undefined;
  try {
    result = await failStaleRunningJobs(new Date(), {
      listLiveJobs: async () => { throw new Error("db down"); },
      failJob: async () => {},
    });
  } catch {
    threw = true;
  }
  check("a listing failure never throws (fail-open boot sweep)", !threw);
  check("a listing failure sweeps zero rows", result?.failed.length === 0);
}

// 7) boot sweep keeps going if one row's failJob throws.
{
  const rows = [
    { id: "ok-1", kind: "verify" as JobKind, status: "running" as const, ageSeconds: 600 },
    { id: "bad-1", kind: "establish_baseline" as JobKind, status: "queued" as const, ageSeconds: 600 },
    { id: "ok-2", kind: "verify" as JobKind, status: "queued" as const, ageSeconds: 600 },
  ];
  const { failed } = await failStaleRunningJobs(new Date(), {
    listLiveJobs: async () => rows,
    failJob: async (jobId) => { if (jobId === "bad-1") throw new Error("write failed"); },
  });
  check("a single row's failJob throwing does not stop the rest of the sweep", failed.includes("ok-1") && failed.includes("ok-2"));
  check("the row whose failJob threw is not reported as successfully failed", !failed.includes("bad-1"));
}

// 8) another live server's jobs are spared: only rows without a recent heartbeat are failed.
{
  const rows = [
    { id: "live-running", kind: "verify" as JobKind, status: "running" as const, ageSeconds: 5 },
    { id: "live-queued", kind: "establish_baseline" as JobKind, status: "queued" as const, ageSeconds: LOCAL_JOB_STALE_SECONDS - 1 },
    { id: "dead", kind: "verify" as JobKind, status: "running" as const, ageSeconds: LOCAL_JOB_STALE_SECONDS },
    { id: "unknown-age", kind: "verify" as JobKind, status: "running" as const, ageSeconds: Number.NaN },
  ];
  const failedCalls: string[] = [];
  const { failed } = await failStaleRunningJobs(new Date(), {
    listLiveJobs: async () => rows,
    failJob: async (jobId) => { failedCalls.push(jobId); },
  });
  check("a job with a recent heartbeat (another live server) is never failed", !failedCalls.includes("live-running") && !failedCalls.includes("live-queued"));
  check("a job whose heartbeat stopped for the stale window is failed", failed.length === 1 && failed[0] === "dead");
  check("an unreadable age is treated as live, not stale (fail-safe toward the owner)", !failedCalls.includes("unknown-age"));
}

// 9) a row its owner touched between listing and failing survives, and is not reported.
{
  const rows = [{ id: "raced", kind: "verify" as JobKind, status: "running" as const, ageSeconds: 600 }];
  const { failed } = await failStaleRunningJobs(new Date(), {
    listLiveJobs: async () => rows,
    failJob: async () => false,
  });
  check("a guarded fail that matched no stale row is not reported as failed", failed.length === 0);
}

// 10) the owning runner heartbeats its queued and running jobs, and stops when idle.
{
  const store = makeFakeStore();
  const runner = createLocalJobRunner({ concurrency: 1, deps: store.deps, heartbeatMs: 5 });
  let release1!: () => void;
  const gate1 = new Promise<void>((res) => { release1 = res; });
  const { job_id: running } = await runner.startLocalJob("t", "verify", {}, async () => { await gate1; return "r"; });
  const { job_id: queued } = await runner.startLocalJob("t", "verify", {}, async () => "q");
  await new Promise((r) => setTimeout(r, 30));
  check("a running job is heartbeated by its owner", store.touched.includes(running));
  check("a job still waiting in the FIFO is heartbeated too", store.touched.includes(queued));
  release1();
  await flush(5);
  const afterDone = store.touched.length;
  await new Promise((r) => setTimeout(r, 30));
  check("both jobs finished", store.completed.length === 2);
  check("no heartbeats once the runner owns no live jobs", store.touched.length === afterDone);
}

// 11) a slow heartbeat never overlaps itself: ticks are skipped until the pass finishes.
{
  const store = makeFakeStore();
  let touches = 0;
  let finishTouch!: () => void;
  const stuck = new Promise<void>((res) => { finishTouch = res; });
  const runner = createLocalJobRunner({
    concurrency: 1, heartbeatMs: 5,
    deps: { ...store.deps, touchJob: async () => { touches++; await stuck; } },
  });
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  await runner.startLocalJob("t", "verify", {}, async () => { await gate; return "r"; });
  await new Promise((r) => setTimeout(r, 40));
  check("a stuck heartbeat query is not re-issued on later ticks", touches === 1, String(touches));
  finishTouch();
  await new Promise((r) => setTimeout(r, 40));
  check("heartbeats resume once the slow pass finishes", touches > 1, String(touches));
  release();
  await flush(5);
}

check("isStaleLiveJob: below the window is live", isStaleLiveJob(LOCAL_JOB_STALE_SECONDS - 1) === false);
check("isStaleLiveJob: at the window is stale", isStaleLiveJob(LOCAL_JOB_STALE_SECONDS) === true);
check("isStaleLiveJob: NaN is not stale", isStaleLiveJob(Number.NaN) === false);
check("stale window spans several heartbeats", LOCAL_JOB_STALE_SECONDS * 1000 >= 3 * LOCAL_JOB_HEARTBEAT_MS);

await flush(5);
check("no unhandled rejection occurred anywhere in this suite (the process never crashes)", unhandled.length === 0, JSON.stringify(unhandled));

console.log(`\n${failures === 0 ? "ALL PASS" : failures + "/" + total + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
