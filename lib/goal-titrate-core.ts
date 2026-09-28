// Titration MCP — the PURE goal_titrate loop core (no I/O, no imports).
//
// `goal_titrate` is the long-running, CLIENT-SHIPS-OUTPUTS loop.
// The engine owns the DISCIPLINE; the client's agent does each turn's work and ships
// that turn's candidate outputs; the engine grades them (via `verify` against a FROZEN
// baseline) and decides continue / converge / stop. This module is that DECISION,
// extracted pure — the same discipline as jobs-core.ts / applyReconsideration /
// decideEscalation / findRateDissent: keep the loop decision here (offline-testable
// without a DB or a judge), keep the LLM grading (`verify`) + the postgres turn store
// in goal-titrate.ts. It deliberately has NO imports — verify.ts transitively imports
// store.ts, which THROWS at import without TITRATION_DATABASE_URL, so the slice of a
// VerifyResult the decision needs is re-declared here (`TurnVerdict`) rather than
// imported.
//
// THE MODEL (settled B4b, 2026-06-16):
//   • Per-turn grading is `verify` against the frozen baseline — so the ≥2-judge guard
//     (gotcha #8a) is inherited by construction (verify.resolvePanel refuses <2).
//   • A SUB-OBJECTIVE is a baseline MODE (verify's per_mode): its rate = the candidate
//     failure rate on that mode; it is "met" when rate ≤ target_rate. A baseline with no
//     modes is a single "all" sub-objective. Zero new grading — reuses verify wholesale.
//   • CONVERGED = a non-inconclusive `passed` verify verdict (real improvement vs the
//     frozen baseline, floor intact) WHERE every sub-objective is met. `passed` alone is
//     not convergence — a big improvement that hasn't yet reached target keeps iterating.
//   • An INCONCLUSIVE turn (noise floor / low-N / judge-variance / direction-split) can
//     never converge and counts as NO PROGRESS (the discipline verify already enforces —
//     a delta you can't distinguish from noise is not a win).
//   • Sub-objectives LOCK at turn 1 (the loop analog of the rubric freeze): the locked
//     list is the baseline's frozen modes; the rubric itself is already sealed in the
//     baseline. The default stop condition is "every sub-objective met" — kept implicit
//     (a configurable stop expression is deferred; it is not needed for the slice).

export const PROGRESS_EPS = 0.05; // a sub-objective "progressed" when its rate fell by more than this turn-over-turn

// One shared terminal taxonomy for the decision core and the public MCP tool contract.
// A reached turn limit is an observation, not a diagnosis that the goal itself is too large.
export const GOAL_TITRATE_TERMINAL_ORIGINS = [
  "goal-complete",
  "turn-budget-reached",
  "progress-stalled",
] as const;

// The minimal slice of a verify VerifyResult the loop decision needs. Re-declared here
// (NOT imported from verify.ts) so this module stays import-clean + DB-free. The I/O
// layer (goal-titrate.ts) maps a real VerifyResult onto this shape.
export interface TurnVerdict {
  passed: boolean; // verify: a real improvement vs the frozen baseline, floor intact
  inconclusive: boolean; // verify: delta inside the noise floor / low-N / judge-variance / direction-split
  metric_delta: number; // candidate − baseline failure rate (negative = improvement)
  baseline_rate: number;
  candidate_rate: number; // aggregate candidate failure rate this turn
  floor_intact: boolean;
  direction_split: boolean;
  failure_origin: string | null; // verify gate-derived (e.g. judge-variance); informational here
  confidence: "low" | "medium" | "high" | null;
  per_mode_candidate: Record<string, { rate: number; n: number }>; // candidate per-mode rates = sub-objective rates
}

// Candidate provenance belongs to the improvement attempt, never the frozen
// baseline goal. Keeping it separate prevents each run from copying and extending
// the baseline prose while retaining an auditable identity for what was tested.
export interface CandidateProvenance {
  name: string;
  version?: string;
  summary?: string;
  deferred_scope?: string;
}

const PROVENANCE_LIMITS = {
  name: 120,
  version: 160,
  summary: 2_000,
  deferred_scope: 1_000,
} as const;

function cleanProvenanceField(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim().replace(/\s+/g, " ");
  return cleaned ? cleaned.slice(0, max) : undefined;
}

// Invalid or empty optional metadata degrades to null; the baseline and verdict
// loop remain usable. A supplied object needs a name so a caller never invents
// a candidate identity from unstructured prose.
export function normalizeCandidateProvenance(value: unknown): CandidateProvenance | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const name = cleanProvenanceField(raw.name, PROVENANCE_LIMITS.name);
  if (!name) return null;
  const version = cleanProvenanceField(raw.version, PROVENANCE_LIMITS.version);
  const summary = cleanProvenanceField(raw.summary, PROVENANCE_LIMITS.summary);
  const deferred_scope = cleanProvenanceField(raw.deferred_scope, PROVENANCE_LIMITS.deferred_scope);
  return {
    name,
    ...(version ? { version } : {}),
    ...(summary ? { summary } : {}),
    ...(deferred_scope ? { deferred_scope } : {}),
  };
}

// The frozen run config — locked at turn 1, stored write-once in jobs.input.
export interface GoalTitrateConfig {
  goal: string; // authoritative frozen baseline goal, loaded by baseline_id at run start
  submitted_goal?: string; // legacy caller prose when it differed; audit-only, never used for grading
  candidate?: CandidateProvenance;
  baseline_id: string;
  budget: number; // max turns before budget-exhausted
  stall_threshold: number; // consecutive no-progress turns → critical-stall
  target_rate: number; // a sub-objective is met when its candidate failure rate ≤ this (default 0)
  sub_objectives: string[]; // the LOCKED sub-objective ids (baseline mode names; ["all"] if none)
  // The grading gates this run is measured by, FROZEN at turn 1 alongside budget and
  // sub_objectives. Carried opaquely: this pure core never interprets the numbers, it
  // only guarantees every turn is graded by the same ones. Before this existed the
  // caller could pass thresholds per-turn on goal_titrate_step, lowering the gate on
  // the very turn being graded (min_n 1 defeats the effective-N floor, min_rate 0 the
  // reproduction refusal) with nothing in the stored verdict recording it. Absent =
  // the engine defaults, which is what every pre-existing run already used.
  thresholds?: Readonly<Record<string, number>>;
  capture?: boolean; // B5 flywheel: locked at turn 1 — on a terminal run, promote a durable card back to the ledger (opt-in; default off). Carried config only; scoreTurn ignores it.
}

// One sub-objective's state, snapshotted each turn into the turn's `outcome`.
export interface SubObjectiveState {
  id: string; // mode name
  rate: number; // current candidate failure rate on this mode (carried forward if unmeasured this turn)
  target: number;
  delta: number; // rate change vs the prior turn (negative = improved); 0 at turn 1 / when unmeasured
  measured: boolean; // did THIS turn's candidate corpus exercise this mode?
  met: boolean; // rate ≤ target
  status: "starting" | "progressing" | "stalled" | "met";
  stall_turns: number; // consecutive turns this sub made no significant progress
}

export type TurnDecision = "continue" | "converged" | "critical-stall" | "budget-exhausted";

// The pure per-turn decision — persisted as the turn's `outcome` jsonb; the LATEST
// turn's outcome is the current loop state the next step reads.
export interface TurnOutcome {
  turn_no: number;
  decision: TurnDecision;
  terminal: boolean; // decision !== "continue"
  converged: boolean; // decision === "converged"
  inconclusive: boolean; // this turn's verify verdict was inconclusive (no readable delta)
  progressed: boolean; // did this turn make significant progress on any sub-objective?
  sub_objectives: SubObjectiveState[];
  overall_progress: number; // fraction of sub-objectives met (0..1)
  stall_turns: number; // run-level consecutive no-progress count
  failure_origin: string | null; // set on a terminal decision (classifyStop); null while continuing
  reason: string;
}

const round = (x: number) => Number(x.toFixed(4));
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

// Map a terminal decision to a goal_titrate failure origin (the engine-observable
// subset of the goal-titrate skill §P.1 taxonomy; engine/instrument failures are
// surfaced separately by the I/O layer as a failed job, never here). Pure.
export function classifyStop(decision: TurnDecision, stalled: boolean): string | null {
  switch (decision) {
    case "converged":
      return "goal-complete";
    case "critical-stall":
      return "progress-stalled";
    case "budget-exhausted":
      return stalled ? "progress-stalled" : "turn-budget-reached";
    default:
      return null; // continue → no terminal origin yet
  }
}

// Lock the sub-objective list at turn 1: the baseline's frozen mode names, deduped;
// a baseline with no modes collapses to a single "all" sub-objective. Pure.
export function lockSubObjectives(baselineModes: string[]): string[] {
  const modes = [...new Set((baselineModes ?? []).filter((m) => typeof m === "string" && m.trim()))];
  return modes.length > 0 ? modes : ["all"];
}

// ── Environment drift across consecutive turns ──────────────────────────────
//
// Two field incidents motivated this: a shared client script was edited mid-day so two
// captures ran on two different rigs, and a search vendor's quota died MID-CAPTURE —
// in both cases every recorded field (corpus hash, engine pin, diff hash, rubric) was
// identical, the verdicts rendered normally, and nothing warned. The caller may declare
// an OPEN fingerprint map {name: hash} per turn (engine commit, client-script sha256, model
// ids, prompt diff…); the engine does not interpret entries — it says when they CHANGED
// between turns. Independently, a large per-mode `n` shift between consecutive turns is
// the quota-death signature the engine can already see from its own data (bucketing is
// derived from what actually ran, so an environment change moves the ns). Pure + total.
export function environmentWarnings(input: {
  prior_fingerprint?: Record<string, string> | null;
  fingerprint?: Record<string, string> | null;
  prior_per_mode?: Record<string, { rate: number; n: number }> | null;
  per_mode?: Record<string, { rate: number; n: number }> | null;
  n_shift_threshold?: number; // relative per-mode n change that warns (default 0.4)
}): string[] {
  const warnings: string[] = [];
  const prior = input.prior_fingerprint ?? null;
  const current = input.fingerprint ?? null;
  if (prior && current) {
    const changed: string[] = [];
    for (const key of new Set([...Object.keys(prior), ...Object.keys(current)])) {
      if (prior[key] !== current[key]) changed.push(key);
    }
    if (changed.length > 0) {
      warnings.push(
        `environment fingerprint differs from the previous turn in ${changed.length} field(s): [${changed.sort().join(", ")}] — ` +
        `the capture environment changed, so this turn and the last may not be comparable measurements.`,
      );
    }
  } else if (prior && !current) {
    warnings.push(
      "an environment fingerprint was declared on the previous turn but not on this one — drift cannot be checked this turn.",
    );
  }
  const threshold = input.n_shift_threshold ?? 0.4;
  const priorModes = input.prior_per_mode ?? null;
  const modes = input.per_mode ?? null;
  if (priorModes && modes) {
    for (const mode of Object.keys(modes)) {
      const before = priorModes[mode];
      const after = modes[mode];
      if (!before || !after || !(before.n > 0)) continue;
      const shift = Math.abs(after.n - before.n) / before.n;
      if (shift > threshold) {
        warnings.push(
          `sub-objective '${mode}' shipped ${before.n} rows last turn and ${after.n} this turn (${pct(shift)} shift) — ` +
          `bucketing derives from what actually ran, so a swing this large usually means the environment changed underneath ` +
          `the capture (vendor quota, a shared script, flags); treat the two turns as different measurements until explained.`,
        );
      }
    }
  }
  return warnings;
}

function priorSub(prior: TurnOutcome | null, id: string): SubObjectiveState | undefined {
  return prior?.sub_objectives.find((s) => s.id === id);
}

// The core per-turn decision. Given THIS turn's verify verdict, the PRIOR turn's
// outcome (null at turn 1), the frozen config, and the 1-based turn number, compute
// the updated sub-objective state + the continue/converge/stop decision. Pure: no DB,
// no judge, no clock — fully offline-testable.
export function scoreTurn(
  verdict: TurnVerdict,
  prior: TurnOutcome | null,
  config: GoalTitrateConfig,
  turn_no: number,
): TurnOutcome {
  const target = config.target_rate;
  const inconclusive = verdict.inconclusive === true;

  const sub_objectives: SubObjectiveState[] = config.sub_objectives.map((id) => {
    const p = priorSub(prior, id);
    const cell = verdict.per_mode_candidate?.[id];
    const measured = !!cell && Number.isFinite(cell.rate);
    // Unmeasured this turn → carry the prior rate; never measured → 1 (conservative:
    // an unexercised sub-objective is assumed unmet so it can't trigger false convergence,
    // mirroring verify's modes_uncovered discipline).
    const rate = measured ? round(cell!.rate) : p ? p.rate : 1;
    const priorRate = p ? p.rate : null;
    const firstReading = priorRate === null;
    const delta = firstReading ? 0 : round(rate - priorRate!);
    const met = rate <= target;
    // Progress requires a real measurement this turn (never an inconclusive verdict).
    // The sub's FIRST reading counts as progress (we advanced from unknown to a
    // measurement — no prior to diff against, and the run-level check credits the
    // vs-baseline improvement); later turns require a meaningful rate drop or newly
    // reaching target.
    const progressedSub =
      measured && !inconclusive && (firstReading || delta < -PROGRESS_EPS || (met && !(p?.met ?? false)));
    const stall_turns = progressedSub ? 0 : (p?.stall_turns ?? 0) + 1;
    const status: SubObjectiveState["status"] = met
      ? "met"
      : turn_no <= 1 && !p
        ? "starting"
        : stall_turns >= config.stall_threshold
          ? "stalled"
          : "progressing";
    return { id, rate, target, delta, measured, met, status, stall_turns };
  });

  const metCount = sub_objectives.filter((s) => s.met).length;
  const overall_progress = round(metCount / sub_objectives.length);
  const allMet = metCount === sub_objectives.length;
  // Run-level progress: an inconclusive turn never counts. Turn 1 (no prior) credits
  // a meaningful improvement vs the FROZEN baseline (or reaching every target);
  // later turns credit any sub that dropped meaningfully or newly met its target.
  const progressed = inconclusive
    ? false
    : !prior
      ? verdict.metric_delta < -PROGRESS_EPS || allMet
      : sub_objectives.some((s) => {
          const wasMet = priorSub(prior, s.id)?.met ?? false;
          return s.measured && (s.delta < -PROGRESS_EPS || (s.met && !wasMet));
        });
  const stall_turns = progressed ? 0 : (prior?.stall_turns ?? 0) + 1;

  // ── decision precedence ─────────────────────────────────────────────────────
  // 1) converged: a real, non-inconclusive improvement with every sub-objective met.
  //    `passed` alone is not enough — it means "better than baseline beyond noise",
  //    not "reached target"; the loop keeps iterating until every sub clears target.
  let decision: TurnDecision;
  if (!inconclusive && verdict.passed && verdict.floor_intact && allMet) {
    decision = "converged";
  } else if (stall_turns >= config.stall_threshold) {
    decision = "critical-stall";
  } else if (turn_no >= config.budget) {
    decision = "budget-exhausted";
  } else {
    decision = "continue";
  }

  const stalledNow = stall_turns >= config.stall_threshold;
  const failure_origin = classifyStop(decision, stalledNow);
  const terminal = decision !== "continue";
  const converged = decision === "converged";

  let reason: string;
  if (converged) {
    reason =
      `CONVERGED on turn ${turn_no}: candidate failure rate ${pct(verdict.candidate_rate)} vs baseline ` +
      `${pct(verdict.baseline_rate)} (Δ ${pct(verdict.metric_delta)}), verify passed, floor intact, all ` +
      `${sub_objectives.length} sub-objective(s) at/under target ${pct(target)}.`;
  } else if (decision === "critical-stall") {
    reason =
      `CRITICAL-STALL: ${stall_turns} consecutive turn(s) with no significant progress ` +
      `(≥ stall_threshold ${config.stall_threshold}). ${metCount}/${sub_objectives.length} sub-objective(s) met. ` +
      `Origin: progress-stalled — the approach is not moving the metric; re-think the candidate, don't keep spending turns.`;
  } else if (decision === "budget-exhausted") {
    reason =
      `BUDGET-EXHAUSTED at turn ${turn_no}/${config.budget}: ${metCount}/${sub_objectives.length} sub-objective(s) met ` +
      `(overall ${pct(overall_progress)}). Origin: ${failure_origin}` +
      (failure_origin === "turn-budget-reached"
        ? ". The turn budget was reached before convergence; the engine has not inferred why."
        : ". Progress had stalled before the turn budget was reached.");
  } else {
    reason = inconclusive
      ? `CONTINUE (turn ${turn_no}): this turn's verdict was INCONCLUSIVE (${verdict.failure_origin ?? "no readable delta"}) — ` +
        `no progress credited. ${metCount}/${sub_objectives.length} met; stall ${stall_turns}/${config.stall_threshold}.`
      : `CONTINUE (turn ${turn_no}): ${metCount}/${sub_objectives.length} sub-objective(s) met (overall ${pct(overall_progress)}), ` +
        `candidate rate ${pct(verdict.candidate_rate)} vs baseline ${pct(verdict.baseline_rate)}; stall ${stall_turns}/${config.stall_threshold}.`;
  }

  return {
    turn_no,
    decision,
    terminal,
    converged,
    inconclusive,
    progressed,
    sub_objectives,
    overall_progress,
    stall_turns,
    failure_origin,
    reason,
  };
}
