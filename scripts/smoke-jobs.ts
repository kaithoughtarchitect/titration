// Titration MCP (OSS) — live DB smoke test for local job execution. NOT part
// of the offline unit suite (run-tests.mjs only globs lib/__tests__/*.test.ts) —
// this needs a real Postgres (npm run setup already applied) and is invoked
// directly, WITHOUT an OpenRouter key: every stub `run` below is a plain local
// function (a timer or a thrown Error), never a judge/embedding call, so
// OPENROUTER_API_KEY must be unset for this run.
//
// Proves:
//   (a) startLocalJob returns { job_id } immediately, then runs its stub in the
//       background inside THIS process; polling getJob reaches 'succeeded' with
//       the stub's own result.
//   (b) a stub that throws lands the job 'failed' with the thrown message.
//   (c) a job left 'running' by a (simulated) dead process is failed by
//       failStaleRunningJobs with the typed restart reason.
//   (d) cleanup deletes every job/tenant row this smoke created.
//
// Run: TITRATION_DATABASE_URL=postgres://... OPENROUTER_API_KEY= \
//      npx tsx scripts/smoke-jobs.ts

import "../server/bootstrap-env";

import postgres from "postgres";
import { postgresOptions } from "../lib/db-connect-core";
import { close as closeStorePool } from "../lib/store";
import { getJob, type JobRow } from "../lib/jobs";
import { startLocalJob, failStaleRunningJobs } from "../lib/local-jobs";
import { LOCAL_JOB_RESTART_REASON } from "../lib/local-jobs-core";

const SMOKE_PROJECT = "smoke-jobs";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : `  — ${detail}`}`);
  if (!condition) failures++;
}

async function pollUntilTerminal(tenant: string, jobId: string, timeoutMs = 5000): Promise<JobRow> {
  const start = Date.now();
  for (;;) {
    const row = await getJob(tenant, jobId);
    if (row.status === "succeeded" || row.status === "failed") return row;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`job ${jobId} did not reach a terminal state within ${timeoutMs}ms (status=${row.status})`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.TITRATION_DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("Set TITRATION_DATABASE_URL before running scripts/smoke-jobs.ts.");
    process.exit(1);
  }
  // Every path this smoke exercises is embedding-free. Remove the key from this process
  // (bootstrap-env may have loaded it from .env), so a stray OpenRouter call cannot
  // succeed: it would fail and fail the smoke, instead of spending.
  delete process.env.OPENROUTER_API_KEY;

  // Verification connection, separate from lib/store.ts's own pool (mirrors
  // scripts/smoke-projects.ts / smoke-evolution.ts) — this smoke can insert a raw
  // fixture row (the "simulated dead process" job) and inspect/clean up without
  // going through the lib functions it is testing.
  const verify = postgres(databaseUrl, postgresOptions(databaseUrl, process.env));

  // Idempotent pre-clean + cleanup (called both before and after): a previous
  // failed run may have left the smoke project behind.
  async function deleteSmokeProject(): Promise<void> {
    const [t] = await verify`select id from tenants where slug = ${SMOKE_PROJECT}`;
    if (!t) return;
    await verify`delete from jobs where tenant_id = ${t.id}`;
    await verify`delete from tenants where id = ${t.id}`;
  }

  const createdJobIds: string[] = [];

  try {
    await deleteSmokeProject();
    const [preExisting] = await verify`select id from tenants where slug = ${SMOKE_PROJECT}`;
    check("pre-clean: the smoke project does not exist yet", preExisting === undefined);

    // ── (a) success path: startLocalJob returns immediately, runs in the background ──
    const successStub = { ok: true, stub: "smoke-jobs success" };
    const startedAt = Date.now();
    const { job_id: successJobId } = await startLocalJob(
      SMOKE_PROJECT,
      "verify",
      { note: "smoke-jobs stub — no corpus, no model call" },
      async () => {
        await new Promise((r) => setTimeout(r, 200));
        return successStub;
      },
    );
    createdJobIds.push(successJobId);
    const returnedImmediately = Date.now() - startedAt < 150; // well under the stub's own 200ms
    check("(a) startLocalJob returns { job_id } before its 200ms stub finishes", returnedImmediately, `took ${Date.now() - startedAt}ms`);

    const successRow = await pollUntilTerminal(SMOKE_PROJECT, successJobId);
    check("(a) polling getJob reaches 'succeeded'", successRow.status === "succeeded", JSON.stringify(successRow));
    check(
      "(a) the succeeded job's result is exactly the stub's own return value",
      successRow.result?.ok === successStub.ok && successRow.result?.stub === successStub.stub,
      JSON.stringify(successRow.result),
    );
    check("(a) kind is recorded as 'verify'", successRow.kind === "verify");

    // ── (b) failing stub: the job lands 'failed' with the thrown message ─────────────
    const { job_id: failJobId } = await startLocalJob(
      SMOKE_PROJECT,
      "establish_baseline",
      { note: "smoke-jobs failing stub" },
      async () => {
        throw new Error("smoke-jobs stub failure");
      },
    );
    createdJobIds.push(failJobId);
    const failRow = await pollUntilTerminal(SMOKE_PROJECT, failJobId);
    check("(b) polling getJob reaches 'failed'", failRow.status === "failed", JSON.stringify(failRow));
    check("(b) the failed job's error is the thrown message", failRow.error === "smoke-jobs stub failure", String(failRow.error));
    check("(b) kind is recorded as 'establish_baseline'", failRow.kind === "establish_baseline");

    // ── (c) boot sweep: a job left 'running' by a (simulated) dead process ───────────
    const { job_id: staleJobId } = await startLocalJob(
      SMOKE_PROJECT,
      "verify",
      { note: "smoke-jobs stale-running fixture" },
      async () => {
        // Never resolves within this smoke's lifetime — stands in for a job whose
        // owning process died mid-grade. The row is forced to 'running' below
        // regardless of whether the scheduler's own markRunning has landed yet.
        await new Promise(() => {});
        return null;
      },
    );
    createdJobIds.push(staleJobId);
    // Force the row to 'running' directly (bypassing the scheduler) — simulates the
    // exact state a dead process leaves behind: a row stuck non-terminal with nothing
    // left to ever move it. Retried briefly in case the scheduler's own markRunning
    // (queued -> running) is still in flight and would otherwise race this UPDATE.
    let forcedRunning = false;
    for (let attempt = 0; attempt < 10 && !forcedRunning; attempt++) {
      // Backdate the heartbeat past the stale window: a dead owner stops touching its rows.
      await verify`update jobs set status = 'running', updated_at = now() - interval '1 hour' where id = ${staleJobId}`;
      const [row] = await verify`select status from jobs where id = ${staleJobId}`;
      forcedRunning = row?.status === "running";
      if (!forcedRunning) await new Promise((r) => setTimeout(r, 20));
    }
    check("(c) the fixture job was forced into 'running' before the sweep", forcedRunning);

    // A job another live server still owns: running, with a fresh heartbeat.
    const { job_id: liveJobId } = await startLocalJob(SMOKE_PROJECT, "verify", { note: "smoke-jobs live-owner fixture" },
      async () => { await new Promise(() => {}); return null; });
    createdJobIds.push(liveJobId);
    await verify`update jobs set status = 'running', updated_at = now() where id = ${liveJobId}`;

    const { failed: sweptIds } = await failStaleRunningJobs(new Date());
    check("(c) the boot sweep reports the fixture job as failed", sweptIds.includes(staleJobId), JSON.stringify(sweptIds));
    check("(c) a job with a fresh heartbeat (another live server) is spared", !sweptIds.includes(liveJobId), JSON.stringify(sweptIds));
    const liveRow = await getJob(SMOKE_PROJECT, liveJobId);
    check("(c) the live job is still running after the sweep", liveRow.status === "running", JSON.stringify(liveRow));

    const staleRow = await getJob(SMOKE_PROJECT, staleJobId);
    check("(c) job_status now reports 'failed' for the swept job", staleRow.status === "failed", JSON.stringify(staleRow));
    check("(c) the error is the typed restart reason", staleRow.error === LOCAL_JOB_RESTART_REASON, String(staleRow.error));

    // ── (d) cleanup ────────────────────────────────────────────────────────────────
    await deleteSmokeProject();
    const [afterCleanup] = await verify`select id from tenants where slug = ${SMOKE_PROJECT}`;
    check("(d) cleanup deleted the smoke project's tenant row", afterCleanup === undefined);
    const remainingJobs = await verify`select count(*)::int as n from jobs where id in ${verify(createdJobIds)}`;
    check("(d) cleanup deleted every job row this smoke created", remainingJobs[0].n === 0);
  } finally {
    await verify.end();
    await closeStorePool();
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  smoke-jobs (${failures} failing check(s))`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
