// Titration MCP (OSS) — the self-hosted evolution-capture pure core.
//
// Each goal_titrate_step turn's declared "what changed and why" note is written
// to goal_titrate_change_note and gates the NEXT turn on that write's completeness
// (evolutionGateIssue). This build has no separate UI and no prompt_content
// table: capture is LOCAL-ONLY — the note lands directly in this server's own
// Postgres, and NO exact prompt body is ever stored (there is nowhere to put
// one). Import-clean: no store/fetch/clock — no Date.now()/Math.random(). The
// I/O half (lib/evolution-local.ts) does the actual reads/writes;
// server/evolution-local.ts adapts this pair to the McpEvolutionAdapter
// interface (server/mcp-server.ts).
//
// evolutionGateIssue's second branch (`prompt_required && !has_prompt`) can
// never fire from this build's own caller (localEvolutionPreflightIssue always
// passes `prompt_required: false` — self-host semantics: a prompt/mixed turn
// still records its note, it just never claims a stored exact-body prompt),
// but the function itself stays general.

export const EVOLUTION_ARTIFACT_KINDS = ["prompt", "code", "configuration", "mixed", "other"] as const;
export type EvolutionArtifactKind = typeof EVOLUTION_ARTIFACT_KINDS[number];

export interface EvolutionGateState {
  turn_no: number | null;
  has_note: boolean;
  prompt_required: boolean;
  has_prompt: boolean;
}

// Pure sequencing decision. A null turn is the first-step case (no predecessor
// to check).
export function evolutionGateIssue(state: EvolutionGateState): string | null {
  if (state.turn_no === null) return null;
  if (!state.has_note) {
    return `evolution capture incomplete for turn ${state.turn_no}: the change note is missing; repair that turn before grading another`;
  }
  if (state.prompt_required && !state.has_prompt) {
    return `evolution capture incomplete for turn ${state.turn_no}: the exact prompt body is missing; repair that turn before grading another`;
  }
  return null;
}

// Self-host capture_source: this build's ONLY write path for goal_titrate_change_note
// is the local goal_titrate_step adapter (server/evolution-local.ts) — there is no
// remote push client, no repair endpoint, no separate UI push. One literal value names
// that path.
export const LOCAL_CAPTURE_SOURCE = "self-host-step";

// db/026 introduced these columns with no CHECK constraint on their values (free
// text, capped at the seam) — db/001_schema.sql (this repo's consolidated schema)
// carries the same shape. `prompt_required` is HARD-CODED false and
// `expected_prompt_hash` HARD-CODED null here: self-host has no prompt_content
// table, so a turn can never claim a stored exact prompt body, regardless of its
// declared artifact_kind (a "prompt" or "mixed" turn still records its note — it
// just never gates the next turn on a prompt body that cannot exist here).
export const LOCAL_EVOLUTION_NOTE_MAX_CHARS = 500;

export interface LocalNoteRowInput {
  turn_no: number;
  note: string;
  artifact_kind: EvolutionArtifactKind;
}

export interface LocalNoteRow {
  turn_no: number;
  note: string;
  artifact_kind: EvolutionArtifactKind;
  prompt_required: false;
  expected_prompt_hash: null;
  capture_source: string;
}

// Trim + cap (defense-in-depth inline normalization). The real MCP caller
// (server/mcp-server.ts) already validates
// and trims `evolution.note` before this is ever reached, so this is a second,
// cheap safety net for any other caller (the smoke script, a future direct
// writer) rather than the primary guard. An empty result THROWS rather than
// silently skipping the write — a "successful" capture that recorded nothing
// is the success-shaped-hide defect this build must not reintroduce.
export function buildLocalNoteRow(input: LocalNoteRowInput): LocalNoteRow {
  const note = String(input.note ?? "").trim().slice(0, LOCAL_EVOLUTION_NOTE_MAX_CHARS);
  if (!note) throw new Error("evolution capture: note must be a non-empty string");
  if (!(EVOLUTION_ARTIFACT_KINDS as readonly string[]).includes(input.artifact_kind)) {
    throw new Error(`evolution capture: artifact_kind must be one of ${EVOLUTION_ARTIFACT_KINDS.join(", ")}`);
  }
  return {
    turn_no: input.turn_no,
    note,
    artifact_kind: input.artifact_kind,
    prompt_required: false,
    expected_prompt_hash: null,
    capture_source: LOCAL_CAPTURE_SOURCE,
  };
}

// Typed refusal thrown by lib/evolution-local.ts `preflightEvolution`. A plain
// Error subclass (no I/O) so mcp-server.ts's outer try/catch renders `.message`
// verbatim via describeToolError/presentation.toolError — the caller sees the
// gate's own wording, not a generic "request could not be completed".
export class LocalEvolutionPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalEvolutionPreflightError";
  }
}

export interface LocalPreflightState {
  // The turn number the caller is ABOUT to grade (1-based). Supplied by the
  // caller (server/evolution-local.ts, computed the same way lib/goal-titrate.ts
  // computes it: latest existing turn + 1) so a caller/DB desync surfaces as its
  // own typed refusal rather than silently checking the wrong turn.
  nextTurnNo: number;
  // The latest EXISTING turn on this job, or null when none exists yet (this
  // would be turn 1).
  latestTurnNo: number | null;
  // Whether that latest existing turn already has a recorded change note.
  hasNote: boolean;
}

// The decision `lib/evolution-local.ts`'s `preflightEvolution` applies after
// reading the DB. Pure: same inputs, same output, every time.
export function localEvolutionPreflightIssue(state: LocalPreflightState): string | null {
  if (!Number.isInteger(state.nextTurnNo) || state.nextTurnNo < 1) {
    return `evolution capture preflight: nextTurnNo must be a positive integer (got ${state.nextTurnNo})`;
  }
  const expectedNextTurnNo = (state.latestTurnNo ?? 0) + 1;
  if (state.nextTurnNo !== expectedNextTurnNo) {
    return `evolution capture preflight: expected to be preparing turn ${expectedNextTurnNo} for this job, but was asked to prepare turn ${state.nextTurnNo}`;
  }
  // Self-host semantics: prompt_required is always false (no prompt_content
  // table exists locally — see LOCAL_CAPTURE_SOURCE above), so has_prompt is
  // irrelevant and passed as false for clarity.
  return evolutionGateIssue({
    turn_no: state.latestTurnNo,
    has_note: state.hasNote,
    prompt_required: false,
    has_prompt: false,
  });
}
