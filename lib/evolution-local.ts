// Titration MCP (OSS) — the self-hosted evolution-capture I/O (goal_titrate_change_note,
// db/001_schema.sql).
//
// Owns tenant-scoped SQL over goal_titrate_change_note: imports `sql`/`tenantId`/
// `tenantIdForWrite` READ/WRITE from lib/store.ts, and links to the engine goal_titrate
// `job_id` + `turn_no` BY VALUE (plain values, NOT cross-table FKs) so the engine
// (lib/goal-titrate.ts, lib/jobs.ts) stays untouched.
//
// jsonb DISCIPLINE (AGENTS.md DB trap): this table has no jsonb columns — nothing to
// double-encode here. UUID columns: job_id is bound as a plain string value (not an
// array).

import { sql, tenantId, tenantIdForWrite } from "./store";
import {
  buildLocalNoteRow,
  localEvolutionPreflightIssue,
  LocalEvolutionPreflightError,
  type EvolutionArtifactKind,
} from "./evolution-local-core";

// jobs.id / goal_titrate_turns.job_id are uuid columns. A pasted non-UUID must NOT
// reach the query (Postgres throws `invalid input syntax for type uuid`) — guard
// first (mirrors the private goal-titrate-change-note.ts / evolution-gate.ts).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function latestTurnNo(tid: string, jobId: string): Promise<number | null> {
  const [row] = await sql`
    select turn_no from goal_titrate_turns
    where tenant_id = ${tid} and job_id = ${jobId}
    order by turn_no desc limit 1`;
  return row ? Number(row.turn_no) : null;
}

// The turn number a caller is about to grade for this job (latest existing + 1,
// or 1 when none exists yet) — the SAME rule lib/goal-titrate.ts's stepGoalTitrate
// uses internally. Exposed so server/evolution-local.ts's `prepare()` can pass an
// explicit, cross-checkable value into `preflightEvolution` below rather than the
// gate silently trusting an unverified caller claim.
export async function nextGoalTitrateTurnNo(tenant: string, jobId: string): Promise<number> {
  if (!UUID_RE.test(jobId)) throw new Error("evolution capture: malformed goal_titrate job id");
  const tid = await tenantId(tenant);
  const latest = await latestTurnNo(tid, jobId);
  return (latest ?? 0) + 1;
}

// READ-ONLY completeness gate, run BEFORE grading (mirrors the private
// assertLatestEvolutionComplete/evolutionGateIssue pairing exactly, minus the
// prompt-body branch, which can never apply locally — see evolution-local-core.ts).
// Refuses with a typed LocalEvolutionPreflightError naming the blocking turn; any
// other failure (malformed id, unknown project) is a plain Error.
export async function preflightEvolution(tenant: string, jobId: string, nextTurnNo: number): Promise<void> {
  if (!UUID_RE.test(jobId)) {
    throw new LocalEvolutionPreflightError("evolution capture preflight: malformed goal_titrate job id");
  }
  const tid = await tenantId(tenant);
  const latest = await latestTurnNo(tid, jobId);
  let hasNote = false;
  if (latest !== null) {
    const [note] = await sql`
      select 1 as ok from goal_titrate_change_note
      where tenant_id = ${tid} and job_id = ${jobId} and turn_no = ${latest}`;
    hasNote = !!note;
  }
  const issue = localEvolutionPreflightIssue({ nextTurnNo, latestTurnNo: latest, hasNote });
  if (issue) throw new LocalEvolutionPreflightError(issue);
}

// WRITE — insert or update the declared note for one (job_id, turn_no). ANCHOR
// GUARD (mirrors the private assertTurnAnchored, D11): the turn must already exist
// as a tenant-owned goal_titrate job's recorded turn, or this throws rather than
// writing a phantom note for an absent/foreign run. THROWS on any failure (a real
// DB error, an unanchored turn) — the caller (server/evolution-local.ts `capture`)
// relies on that throw to report evolution_capture.complete:false without losing
// the graded step result already returned by stepGoalTitrate (constitution
// invariant 7: a note-write failure must never lose the graded verdict).
export async function upsertChangeNote(
  tenant: string,
  jobId: string,
  turnNo: number,
  note: string,
  artifactKind: EvolutionArtifactKind,
): Promise<void> {
  if (!UUID_RE.test(jobId)) throw new Error("evolution capture: malformed goal_titrate job id");
  if (!Number.isInteger(turnNo) || turnNo < 1) {
    throw new Error("evolution capture: turn_no must be a positive integer");
  }
  const tid = await tenantIdForWrite(tenant);
  const [job] = await sql`
    select 1 as ok from jobs where id = ${jobId} and tenant_id = ${tid} and kind = 'goal_titrate'`;
  if (!job) throw new Error(`evolution capture: goal_titrate job '${jobId}' was not found in this project`);
  const [turn] = await sql`
    select 1 as ok from goal_titrate_turns where job_id = ${jobId} and turn_no = ${turnNo}`;
  if (!turn) throw new Error(`evolution capture: turn ${turnNo} was not found on job '${jobId}'`);

  const row = buildLocalNoteRow({ turn_no: turnNo, note, artifact_kind: artifactKind });
  await sql`
    insert into goal_titrate_change_note
      (tenant_id, job_id, turn_no, note, artifact_kind, prompt_required, expected_prompt_hash, capture_source)
    values
      (${tid}, ${jobId}, ${turnNo}, ${row.note}, ${row.artifact_kind}, ${row.prompt_required}, ${row.expected_prompt_hash}, ${row.capture_source})
    on conflict (job_id, turn_no)
    do update set note = excluded.note,
                  artifact_kind = excluded.artifact_kind,
                  prompt_required = excluded.prompt_required,
                  expected_prompt_hash = excluded.expected_prompt_hash,
                  capture_source = excluded.capture_source,
                  updated_at = now()`;
}
