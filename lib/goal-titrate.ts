// Titration MCP — goal_titrate (the long-running, client-ships-outputs loop).
//
// Hand over a goal + a FROZEN baseline, and the engine runs
// a disciplined multi-turn loop — but it NEVER runs the user's code. The CLIENT's
// agent does each turn's work and ships that turn's candidate outputs; the engine
// GRADES them (via `verify` against the frozen baseline) and decides continue /
// converge / stop. This is the I/O layer: the postgres turn store + the verify call;
// the pure loop DECISION lives in goal-titrate-core.ts (offline-tested).
//
// TWO tools, mirroring B4a's job pattern (server.ts wires them):
//   • goal_titrate (start)      → validate baseline, LOCK the config at turn 1,
//       createJob(kind 'goal_titrate'), return { job_id }. Drives nothing — the client
//       steps it. (No runJobAsync: this is client-driven, not a background computation.)
//   • goal_titrate_step (advance) → grade THIS turn's candidate via verify, score the
//       turn (pure), append a turn row, and on a terminal decision completeJob with the
//       run aggregate. job_status (B4a, reused) polls the run + reads the final result.
//
// REUSE, NOT REBUILD: jobs.ts (createJob/markRunning/completeJob/failJob/getJob — the
// `jobs` row is the uniform async handle, kind already allowed by 004), verify() (the
// per-turn grade — so the ≥2-JUDGE GUARD is INHERITED BY CONSTRUCTION: verify's
// resolvePanel refuses <2 cross-vendor judges, and a step propagates that refusal
// loudly via failJob, never silently downgrades — gotcha #8a), store.ts (sql/tenantId/
// assertWritable), baseline.ts (loadBaseline). jsonb via sql.json + defensive read
// parse (gotcha #3a). The frozen config lives write-once in jobs.input (loop
// fields only — never a duplicate of the baseline's selected-panel lock). The
// mutable per-turn history is the append-only goal_titrate_turns table (005);
// the terminal aggregate is jobs.result. Caller judges stay forwarded into
// verify; selected-panel lock reuse is verify.resolvePanel's.
//
// HONEST LIMITATION: a step-time engine error (verify throws — <2 judges, baseline
// gone) FAILS THE RUN (labeled in the job row) rather than auto-recovering; the
// persisted turns remain as an audit. Resume-a-failed-run is deferred (not in B4b).

import { sql, tenantIdForWrite, assertWritable } from "./store";
import { createJob, markRunning, completeJob, failJob, getJob } from "./jobs";
import { isTerminal } from "./jobs-core";
import { verify, type VerifyResult, type OutputRow, type Thresholds, type VerdictExecutionOptions } from "./verify";
import { resolvePlayerFamilyOrThrow, assertFamilyNotOnPanel } from "./judges-roster-core";
import { loadBaseline } from "./baseline";
import { readLedger, captureVerdict, type LedgerContext, type CaptureResult } from "./flywheel";
import {
  scoreTurn,
  lockSubObjectives,
  normalizeCandidateProvenance,
  environmentWarnings,
  type GoalTitrateConfig,
  type CandidateProvenance,
  type TurnVerdict,
  type TurnOutcome,
  type SubObjectiveState,
  type TurnDecision,
} from "./goal-titrate-core";

const DEFAULTS = { budget: 20, stall_threshold: 3, target_rate: 0 };
const POLL_HINT = "advance with goal_titrate_step { project, job_id, candidate_outputs, evolution, player_model }; poll job_status { project, job_id } until status is 'succeeded' (read result) or 'failed' (read error)";

// Defensive jsonb read (gotcha #3a): a legacy double-encoded row comes back as a
// string — parse it so the loop never operates on characters.
function parseJsonb(v: any): any {
  return typeof v === "string" ? JSON.parse(v) : v;
}

function posInt(v: unknown, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : def;
}
function clamp01(v: unknown, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : def;
}

// ── start: goal_titrate ───────────────────────────────────────────────────────

export interface StartArgs {
  tenant: string;
  goal?: string; // backward-compatible legacy input; the frozen baseline is authoritative
  baseline_id: string;
  candidate?: CandidateProvenance;
  // The Player's model id, checked (at start, before any turn runs) against
  // this baseline's LOCKED panel families. REQUIRED by the MCP tool schema; OPTIONAL
  // here so a caller that omits it (e.g. this file's own dependency-free offline
  // suite) is unaffected. Not persisted into the frozen jobs.input config — every
  // per-turn re-check is goal_titrate_step's own (via its own player_model, forwarded
  // into verify()), never a value read back out of this run's frozen config.
  player_model?: string;
  player_family?: string;
  budget?: number;
  stall_threshold?: number;
  target_rate?: number;
  // The grading gates for this run, FROZEN at turn 1 and applied identically to every
  // turn. This is the ONLY door: goal_titrate_step deliberately does not take them.
  thresholds?: Thresholds;
  ledger?: boolean; // consult the ledger for advisory failed-edit memory at start (default on; kill-switch)
  capture?: boolean; // locked at turn 1 — promote a durable card on the terminal run (opt-in; default off)
}

export interface StartResult {
  job_id: string;
  status: "queued";
  turn: 0;
  goal: string;
  baseline_id: string;
  baseline_rate: number;
  sub_objectives: string[];
  budget: number;
  stall_threshold: number;
  target_rate: number;
  ledger_context: LedgerContext; // B5 flywheel: advisory failed-edit memory for this goal (never gates the run)
  poll: string;
}

export async function startGoalTitrate(args: StartArgs): Promise<StartResult> {
  const baselineId = String(args.baseline_id ?? "").trim();
  if (!baselineId) throw new Error("baseline_id is required (establish_baseline first, then pass its baseline_id)");
  assertWritable(args.tenant); // reject __base__ before any work — a run is per-tenant state

  // Confirm the baseline exists (throws if not) and read its frozen modes — these
  // BECOME the locked sub-objectives. The rubric is already sealed in the baseline;
  // locking the sub-objectives + budget here is the loop's turn-1 freeze.
  const baseline = await loadBaseline(args.tenant, baselineId);
  const goal = String(baseline.goal ?? "").trim();
  if (!goal) throw new Error(`baseline '${baselineId}' has no frozen goal`);
  // The Player's family, checked against this baseline's
  // resolved panel families at START — before any turn is spent. Every per-turn
  // re-check on THIS run is goal_titrate_step's own (it forwards its own
  // player_model into verify()); this is a distinct, earlier check so a doomed run
  // never gets a job_id at all. player_model is OPTIONAL here (the trimmed-empty
  // guard below), preserving this file's own dependency-free offline suite, which
  // predates the gate and passes none of this.
  const startPlayerModel = typeof args.player_model === "string" ? args.player_model.trim() : "";
  if (startPlayerModel && baseline.judge_panel) {
    const resolvedPlayerFamily = resolvePlayerFamilyOrThrow(startPlayerModel, args.player_family);
    assertFamilyNotOnPanel(resolvedPlayerFamily, baseline.judge_panel.resolved.map((snap) => snap.family), {
      playerModel: startPlayerModel,
      playerFamily: args.player_family,
    });
  }
  const submittedGoal = String(args.goal ?? "").trim();
  const candidate = normalizeCandidateProvenance(args.candidate);
  const config: GoalTitrateConfig = {
    goal,
    ...(submittedGoal && submittedGoal !== goal ? { submitted_goal: submittedGoal } : {}),
    ...(candidate ? { candidate } : {}),
    baseline_id: baselineId,
    budget: posInt(args.budget, DEFAULTS.budget),
    stall_threshold: posInt(args.stall_threshold, DEFAULTS.stall_threshold),
    target_rate: clamp01(args.target_rate, DEFAULTS.target_rate),
    sub_objectives: lockSubObjectives(Object.keys(baseline.per_mode ?? {})),
    ...(args.thresholds ? { thresholds: { ...args.thresholds } as Readonly<Record<string, number>> } : {}),
    capture: args.capture === true, // B5: the run's capture policy is FROZEN here (turn-1 freeze), read at the terminal step
  };

  // B5 flywheel READ (advisory, fail-open): surface failed-edit memory for this goal
  // at the start. Never gates the run — a read miss returns an empty context.
  const ledger_context =
    args.ledger !== false
      ? await readLedger(args.tenant, { kind: "goal_titrate", goal })
      : { consulted: false, tenant: args.tenant, query: "", cards: [], error: null };

  // createJob asserts writability + tenant again and stores the frozen config as the
  // lightweight request summary (NOT a corpus — outputs ship per step). kind
  // 'goal_titrate' is already allowed by the 004 CHECK. Do not copy judge_panel
  // into this write-once input; the baseline owns the selected-panel lock.
  const { job_id } = await createJob(args.tenant, "goal_titrate", config);
  return {
    job_id,
    status: "queued",
    turn: 0,
    goal,
    baseline_id: baselineId,
    baseline_rate: baseline.baseline_rate,
    sub_objectives: config.sub_objectives,
    budget: config.budget,
    stall_threshold: config.stall_threshold,
    target_rate: config.target_rate,
    ledger_context,
    poll: POLL_HINT,
  };
}

// ── step: goal_titrate_step ───────────────────────────────────────────────────

export interface StepArgs {
  tenant: string;
  job_id: string;
  candidate_outputs: OutputRow[];
  judges?: string[];
  // Re-checked on EVERY step against this run's frozen baseline's locked
  // panel (forwarded straight into verify() below — that is the one place the
  // check lives; see EstablishArgs.player_model in verify.ts for the full contract).
  player_model?: string;
  player_family?: string;
  // NO `thresholds` — deliberately. `goal_titrate` (start) never accepted them, so a
  // per-turn override was the only way to set them, and it let the caller move the
  // grading gate on the very turn being graded: `min_n: 1` defeats the effective-N
  // floor, `min_rate: 0` the reproduction refusal, `panel_floor_share: 1` the
  // corroboration floor. A VerifyResult does not echo the thresholds it used, so a
  // weakened turn was indistinguishable from a default one in the stored verdict.
  // That is the builder editing its own gate. Every turn of a run now grades at the
  // engine defaults — the same ruler for the whole run, which is the only way turn N
  // and turn N+1 are comparable at all.
  // B2: optional open environment-fingerprint map {name: hash} (engine commit, client-script
  // sha256, model ids, prompt diff…). The engine never interprets entries — it warns
  // when the declared map DIFFERS from the previous turn's, because two turns captured
  // on different rigs are different measurements wearing identical verdict records.
  fingerprint?: Record<string, string>;
}

export interface AuditEntry {
  turn: number;
  decision: TurnDecision;
  inconclusive: boolean;
  overall_progress: number;
  stall_turns: number;
  reason: string;
}

export interface GoalTitrateResult {
  converged: boolean;
  decision: TurnDecision;
  failure_origin: string | null;
  turns: number;
  goal: string;
  baseline_id: string;
  sub_objectives: SubObjectiveState[];
  overall_progress: number;
  reason: string;
  audit_trail: AuditEntry[];
}

export interface StepResult {
  job_id: string;
  turn: number;
  continue: boolean; // !terminal — another goal_titrate_step is expected
  decision: TurnDecision;
  converged: boolean;
  terminal: boolean;
  inconclusive: boolean;
  failure_origin: string | null;
  reason: string;
  sub_objectives: SubObjectiveState[];
  overall_progress: number;
  stall_turns: number;
  verdict: VerifyResult; // the full per-turn verify verdict (the graded candidate vs the frozen baseline)
  environment_warnings: string[]; // B2: declared-fingerprint drift + per-mode n swings vs the previous turn (empty when nothing moved / nothing declared)
  poll?: string; // present while continuing
  result?: GoalTitrateResult; // present + persisted to jobs.result when terminal
  ledger_capture?: CaptureResult; // B5 flywheel: present on a terminal run when capture was locked on (the promoted card)
}

function toTurnVerdict(v: VerifyResult): TurnVerdict {
  return {
    passed: v.passed,
    inconclusive: v.inconclusive,
    metric_delta: v.metric_delta,
    baseline_rate: v.baseline_rate,
    candidate_rate: v.candidate_rate,
    floor_intact: v.floor_intact,
    direction_split: v.direction_split,
    failure_origin: v.failure_origin,
    confidence: v.confidence,
    per_mode_candidate: v.per_mode.candidate,
  };
}

async function loadLatestOutcome(jobId: string): Promise<TurnOutcome | null> {
  const [r] = await sql`
    select outcome from goal_titrate_turns
    where job_id = ${jobId} order by turn_no desc limit 1`;
  return r ? (parseJsonb(r.outcome) as TurnOutcome) : null;
}

// B2: the latest turn's outcome PLUS its stored verify verdict (per-mode ns live there)
// so environment drift — a declared-fingerprint change or a large per-mode n swing —
// can be compared turn to turn. The stored outcome may carry an extra `fingerprint`
// key (written below); TurnOutcome tolerates it as jsonb passthrough.
async function loadLatestTurn(jobId: string): Promise<{
  outcome: (TurnOutcome & { fingerprint?: Record<string, string> }) | null;
  verdict: VerifyResult | null;
}> {
  const [r] = await sql`
    select outcome, verdict from goal_titrate_turns
    where job_id = ${jobId} order by turn_no desc limit 1`;
  if (!r) return { outcome: null, verdict: null };
  // Defensive jsonb read (CLAUDE.md DB trap): the verdict is consulted only for the
  // ADVISORY n-shift comparison, so a malformed/legacy blob fails open to null (skip
  // the warning) rather than blocking the next turn of a live run.
  let verdict: VerifyResult | null = null;
  try {
    verdict = r.verdict == null ? null : (parseJsonb(r.verdict) as VerifyResult);
  } catch (e) {
    console.error("[goal-titrate] latest turn verdict parse failed (fail-open, n-shift check skipped):", e);
  }
  return {
    outcome: parseJsonb(r.outcome) as TurnOutcome & { fingerprint?: Record<string, string> },
    verdict,
  };
}

async function buildAuditTrail(jobId: string): Promise<AuditEntry[]> {
  const rows = await sql`
    select outcome from goal_titrate_turns
    where job_id = ${jobId} order by turn_no asc`;
  return rows.map((r: any) => {
    const o = parseJsonb(r.outcome) as TurnOutcome;
    return {
      turn: o.turn_no,
      decision: o.decision,
      inconclusive: o.inconclusive,
      overall_progress: o.overall_progress,
      stall_turns: o.stall_turns,
      reason: o.reason,
    };
  });
}

export interface GoalTitrateStepDependencies {
  readonly verify: typeof verify;
}

const defaultStepDependencies: GoalTitrateStepDependencies = { verify };

export async function stepGoalTitrate(args: StepArgs, opts: VerdictExecutionOptions = {}): Promise<StepResult> {
  return stepGoalTitrateWithDependencies(defaultStepDependencies, args, opts);
}

export async function stepGoalTitrateWithDependencies(
  dependencies: GoalTitrateStepDependencies,
  args: StepArgs,
  // Keepalive seam only: beforeProviderCall is threaded into the per-turn verify so
  // the MCP door can keep a long grading response warm. draftOnRefusal stays UNSET here
  // by design — the per-turn call never drafts.
  opts: VerdictExecutionOptions = {},
): Promise<StepResult> {
  const jobId = String(args.job_id ?? "").trim();
  if (!jobId) throw new Error("job_id is required (start a run with goal_titrate first)");

  // Load the run (tenant-scoped — isolation). Refuse a non-goal_titrate or already-
  // terminal job cleanly (a client error; do NOT fail an already-finished run).
  const job = await getJob(args.tenant, jobId);
  if (job.kind !== "goal_titrate") throw new Error(`job '${jobId}' is kind '${job.kind}', not a goal_titrate run`);
  if (isTerminal(job.status)) throw new Error(`goal_titrate run '${jobId}' is already terminal (${job.status}); start a new run`);

  const config = parseJsonb(job.input) as GoalTitrateConfig;
  const priorTurn = await loadLatestTurn(jobId);
  const prior = priorTurn.outcome;
  const turn_no = (prior?.turn_no ?? 0) + 1;
  await markRunning(jobId); // queued → running on turn 1; a no-op thereafter

  // Grade THIS turn's candidate against the frozen baseline. verify enforces the
  // ≥2-judge guard (resolvePanel) + the noise-floor / per-mode / direction-split
  // discipline. Selected-panel lock reuse is also verify.resolvePanel's: extra
  // caller judges are forwarded here and ignored there, not refused. A throw here
  // (no judges, baseline gone, empty corpus) FAILS the run loudly — never a silent
  // single-judge downgrade (gotcha #8a).
  let v: VerifyResult;
  try {
    v = await dependencies.verify(
      {
        tenant: args.tenant,
        baseline_id: config.baseline_id,
        candidate_outputs: args.candidate_outputs,
        judges: args.judges,
        // Forwarded straight into verify(), which re-checks THIS turn's
        // Player family against the frozen baseline's locked referees before grading.
        ...(args.player_model ? { player_model: args.player_model, player_family: args.player_family } : {}),
        // The RUN's thresholds, frozen at turn 1 — never this call's. See StepArgs.
        ...(config.thresholds ? { thresholds: config.thresholds as Thresholds } : {}),
      },
      opts.beforeProviderCall ? { beforeProviderCall: opts.beforeProviderCall } : {},
    );
  } catch (cause: unknown) {
    const msg = `turn ${turn_no} grading failed: ${cause instanceof Error ? cause.message : String(cause)}`;
    const gradingError = new Error(msg, { cause });
    try {
      await failJob(jobId, msg);
    } catch (persistenceError) {
      throw new AggregateError(
        [gradingError, persistenceError],
        `turn ${turn_no} grading failed and the failed job state could not be persisted`,
      );
    }
    throw gradingError;
  }

  const outcome = scoreTurn(toTurnVerdict(v), prior, config, turn_no);

  // B2: environment drift — declared-fingerprint changes and large per-mode n swings
  // between consecutive turns. Warnings ride the RESPONSE (and the fingerprint is
  // persisted with the outcome for the next turn's comparison); the stored decision
  // record itself stays pristine.
  const environment_warnings = environmentWarnings({
    prior_fingerprint: prior?.fingerprint ?? null,
    fingerprint: args.fingerprint ?? null,
    prior_per_mode: priorTurn.verdict?.per_mode?.candidate ?? null,
    per_mode: v.per_mode?.candidate ?? null,
  });

  // Append the turn (insert-only; the unique (job_id, turn_no) constraint rejects a
  // double-submitted turn rather than silently mutating one).
  const tid = await tenantIdForWrite(args.tenant);
  const storedOutcome = args.fingerprint && Object.keys(args.fingerprint).length > 0
    ? { ...outcome, fingerprint: args.fingerprint }
    : outcome;
  await sql`
    insert into goal_titrate_turns (job_id, tenant_id, turn_no, verdict, outcome)
    values (${jobId}, ${tid}, ${turn_no}, ${sql.json(v as any)}, ${sql.json(storedOutcome as any)})`;
  // Issue 1 (2026-08-25): move the job's heartbeat every time a turn lands.
  // markRunning above is queued→running-once by design, so before this line a
  // mid-flight run's updated_at froze at turn 1 and a timed-out caller could not tell
  // a landed turn from a lost one — the ambiguity that burned a budgeted turn on a
  // duplicate. (job_status additionally reports turn_count/last_turn_at.)
  // FAIL-OPEN by law: the turn above is already committed and authoritative — a
  // transient failure on this cosmetic touch must never make a LANDED turn look like
  // an error (a resend would collide with the unique constraint after a real spend).
  void sql`update jobs set updated_at = now() where id = ${jobId}`
    .catch((e) => console.error("[goal-titrate] jobs.updated_at heartbeat failed (fail-open):", e));

  let result: GoalTitrateResult | undefined;
  let ledger_capture: CaptureResult | undefined;
  if (outcome.terminal) {
    result = {
      converged: outcome.converged,
      decision: outcome.decision,
      failure_origin: outcome.failure_origin,
      turns: turn_no,
      goal: config.goal,
      baseline_id: config.baseline_id,
      sub_objectives: outcome.sub_objectives,
      overall_progress: outcome.overall_progress,
      reason: outcome.reason,
      audit_trail: await buildAuditTrail(jobId),
    };
    await completeJob(jobId, result); // running → succeeded; the run reached a terminal verdict (converged OR stopped-with-diagnosis)
    // B5 flywheel WRITE (opt-in, locked at turn 1; fail-open): promote a durable card
    // for the WHOLE run — a FINDING on convergence, a REGRESSION on a stalled/exhausted
    // run. captureVerdict never throws (it can't unwind the already-completed run).
    if (config.capture === true) {
      ledger_capture = await captureVerdict(args.tenant, {
        kind: "goal_titrate",
        goal: config.goal,
        baseline_id: config.baseline_id,
        job_id: jobId,
        candidate: config.candidate ?? null,
        result,
      });
    }
  }

  return {
    job_id: jobId,
    turn: turn_no,
    continue: !outcome.terminal,
    decision: outcome.decision,
    converged: outcome.converged,
    terminal: outcome.terminal,
    inconclusive: outcome.inconclusive,
    failure_origin: outcome.failure_origin,
    reason: environment_warnings.length > 0
      ? `${outcome.reason} ⚠ ${environment_warnings.join(" ⚠ ")}`
      : outcome.reason,
    sub_objectives: outcome.sub_objectives,
    overall_progress: outcome.overall_progress,
    stall_turns: outcome.stall_turns,
    verdict: v,
    environment_warnings,
    ...(outcome.terminal ? { result, ...(ledger_capture ? { ledger_capture } : {}) } : { poll: POLL_HINT }),
  };
}
