// Titration MCP (OSS) — live DB smoke test for local evolution capture. NOT
// part of the offline unit suite (run-tests.mjs only globs lib/__tests__/*.test.ts)
// — this needs a real Postgres (npm run setup already applied) and is invoked
// directly, WITHOUT an OpenRouter key: every function under test
// (createJob/preflightEvolution/upsertChangeNote) is a plain DB read/write, never
// a judge/embedding call, so OPENROUTER_API_KEY must be unset for this run.
//
// Proves:
//   (a) a fresh job with no turns yet passes preflight for its first turn.
//   (b) upsertChangeNote writes a note for an existing turn (verified by a raw
//       read: prompt_required false, expected_prompt_hash null, capture_source
//       the local literal — self-host never claims a stored prompt body).
//   (c) preflightEvolution for the NEXT turn now passes (the predecessor turn
//       has a recorded note).
//   (d) upsertChangeNote on a turn_no that was never graded refuses (the
//       assertTurnAnchored-style "the turn must exist" guard).
//   (e) a SECOND job whose one graded turn has NO note → preflightEvolution for
//       its next turn refuses with the typed LocalEvolutionPreflightError,
//       naming the blocking turn.
//   (f) cleanup deletes every row this smoke created (both jobs, both tenants'
//       rows) — safe to re-run without manual cleanup.
//
// Run: TITRATION_DATABASE_URL=postgres://... OPENROUTER_API_KEY= \
//      npx tsx scripts/smoke-evolution.ts

import "../server/bootstrap-env";

import postgres from "postgres";
import { postgresOptions } from "../lib/db-connect-core";
import { tenantIdForWrite, close as closeStorePool } from "../lib/store";
import { createJob } from "../lib/jobs";
import { preflightEvolution, upsertChangeNote } from "../lib/evolution-local";
import { LocalEvolutionPreflightError } from "../lib/evolution-local-core";

const SMOKE_PROJECT = "smoke-evolution";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : `  — ${detail}`}`);
  if (!condition) failures++;
}

async function checkAsync(name: string, fn: () => Promise<boolean>): Promise<void> {
  try {
    check(name, await fn());
  } catch (e) {
    check(name, false, `threw unexpectedly: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function expectThrow(name: string, fn: () => Promise<unknown>, matching: RegExp, typed?: (e: unknown) => boolean): Promise<void> {
  try {
    await fn();
    check(name, false, "did not throw");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const messageOk = matching.test(message);
    const typeOk = typed ? typed(e) : true;
    check(name, messageOk && typeOk, `message=${message} typeOk=${typeOk}`);
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.TITRATION_DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("Set TITRATION_DATABASE_URL before running scripts/smoke-evolution.ts.");
    process.exit(1);
  }
  // Every path this smoke exercises is embedding-free. Remove the key from this process
  // (bootstrap-env may have loaded it from .env), so a stray OpenRouter call cannot
  // succeed: it would fail and fail the smoke, instead of spending.
  delete process.env.OPENROUTER_API_KEY;

  // Verification connection, separate from lib/store.ts's own pool (mirrors
  // scripts/smoke-projects.ts) — this smoke can insert raw fixture rows and
  // inspect/clean them up without going through the lib functions it is testing.
  const verify = postgres(databaseUrl, postgresOptions(databaseUrl, process.env));

  // Idempotent pre-clean + cleanup (called both before and after): a previous
  // failed run may have left the smoke project behind. Delete in FK-safe order —
  // goal_titrate_change_note before goal_titrate_turns before jobs before tenants
  // (only goal_titrate_change_note.tenant_id cascades; jobs/goal_titrate_turns do not).
  async function deleteSmokeProject(): Promise<void> {
    const [t] = await verify`select id from tenants where slug = ${SMOKE_PROJECT}`;
    if (!t) return;
    await verify`delete from goal_titrate_change_note where tenant_id = ${t.id}`;
    await verify`delete from goal_titrate_turns where tenant_id = ${t.id}`;
    await verify`delete from jobs where tenant_id = ${t.id}`;
    await verify`delete from tenants where id = ${t.id}`;
  }

  // A graded turn's INSERT (job_id, tenant_id, turn_no, verdict, outcome) exactly
  // as lib/goal-titrate.ts's stepGoalTitrate writes it — inserted directly here
  // (never via verify()/judges) so this smoke spends no model call and no key.
  async function insertGradedTurn(tenantId: string, jobId: string, turnNo: number): Promise<void> {
    await verify`
      insert into goal_titrate_turns (job_id, tenant_id, turn_no, verdict, outcome)
      values (${jobId}, ${tenantId}, ${turnNo}, ${verify.json({} as any)}, ${verify.json({} as any)})`;
  }

  try {
    await deleteSmokeProject();
    const [preExisting] = await verify`select id from tenants where slug = ${SMOKE_PROJECT}`;
    check("pre-clean: the smoke project does not exist yet", preExisting === undefined);

    const tid = await tenantIdForWrite(SMOKE_PROJECT);

    // ── Job A: the happy path — capture, then the next turn's preflight passes ──
    const jobA = await createJob(SMOKE_PROJECT, "goal_titrate", { goal: "smoke-evolution A", baseline_id: "smoke-baseline" });

    // (a) a fresh job with no turns yet passes preflight for its first turn.
    await checkAsync(
      "(a) preflight for turn 1 of a fresh job (no predecessor) passes",
      async () => { await preflightEvolution(SMOKE_PROJECT, jobA.job_id, 1); return true; },
    );

    await insertGradedTurn(tid, jobA.job_id, 1);

    // (b) capture writes a note for the just-graded turn.
    await checkAsync(
      "(b) upsertChangeNote writes a note for turn 1",
      async () => { await upsertChangeNote(SMOKE_PROJECT, jobA.job_id, 1, "smoke: added a hard dedup rule", "code"); return true; },
    );
    const [noteRow] = await verify`
      select note, artifact_kind, prompt_required, expected_prompt_hash, capture_source
      from goal_titrate_change_note where tenant_id = ${tid} and job_id = ${jobA.job_id} and turn_no = 1`;
    check("(b) the note row exists with the declared note", noteRow?.note === "smoke: added a hard dedup rule", JSON.stringify(noteRow));
    check("(b) prompt_required is false (no prompt_content table locally)", noteRow?.prompt_required === false, JSON.stringify(noteRow));
    check("(b) expected_prompt_hash is null (no exact prompt body is ever stored locally)", noteRow?.expected_prompt_hash === null, JSON.stringify(noteRow));
    check("(b) capture_source records the local self-host write path", noteRow?.capture_source === "self-host-step", JSON.stringify(noteRow));

    // (c) preflight for the NEXT turn now passes (turn 1 has a note).
    await checkAsync(
      "(c) preflight for turn 2 passes now that turn 1 has a note",
      async () => { await preflightEvolution(SMOKE_PROJECT, jobA.job_id, 2); return true; },
    );

    // (d) upsertChangeNote on a turn_no that was never graded refuses (the turn must exist).
    await expectThrow(
      "(d) upsertChangeNote on an ungraded turn_no refuses (assertTurnAnchored semantics)",
      () => upsertChangeNote(SMOKE_PROJECT, jobA.job_id, 99, "should never land", "code"),
      /turn 99 was not found/,
    );

    // ── Job B: the refusal path — one graded turn, no note ──────────────────────
    const jobB = await createJob(SMOKE_PROJECT, "goal_titrate", { goal: "smoke-evolution B", baseline_id: "smoke-baseline" });
    await insertGradedTurn(tid, jobB.job_id, 1);

    // (e) a job whose one graded turn has no note refuses the next turn's preflight,
    // with the typed error naming the blocking turn.
    await expectThrow(
      "(e) preflight for job B's turn 2 refuses — turn 1 was graded but never captured",
      () => preflightEvolution(SMOKE_PROJECT, jobB.job_id, 2),
      /turn 1.*change note is missing/,
      (e) => e instanceof LocalEvolutionPreflightError,
    );

    // ── (f) cleanup ──────────────────────────────────────────────────────────────
    await deleteSmokeProject();
    const [afterCleanup] = await verify`select id from tenants where slug = ${SMOKE_PROJECT}`;
    check("(f) cleanup deleted the smoke project's tenant row", afterCleanup === undefined);
    const remainingNotes = await verify`select count(*)::int as n from goal_titrate_change_note where job_id in (${jobA.job_id}, ${jobB.job_id})`;
    check("(f) cleanup deleted every note row this smoke created", remainingNotes[0].n === 0);
    const remainingTurns = await verify`select count(*)::int as n from goal_titrate_turns where job_id in (${jobA.job_id}, ${jobB.job_id})`;
    check("(f) cleanup deleted every turn row this smoke created", remainingTurns[0].n === 0);
    const remainingJobs = await verify`select count(*)::int as n from jobs where id in (${jobA.job_id}, ${jobB.job_id})`;
    check("(f) cleanup deleted both job rows this smoke created", remainingJobs[0].n === 0);
  } finally {
    await verify.end();
    await closeStorePool();
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  smoke-evolution (${failures} failing check(s))`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
