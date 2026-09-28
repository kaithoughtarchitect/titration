// Titration MCP (OSS) — self-hosted evolution-capture pure-core unit test (no
// network, no DB, no model — $0).
//
// Part 1 covers the GATE cases for evolutionGateIssue's decision logic.
// Part 2 covers the local-only additions: buildLocalNoteRow (self-host row
// shaping — prompt_required/expected_prompt_hash always false/null) and
// localEvolutionPreflightIssue (the adapter's actual decision function,
// including the caller/DB turn-number cross-check).
//
// Run: npx tsx lib/__tests__/evolution-local-core.test.ts (also under `npm test`)

import {
  evolutionGateIssue,
  buildLocalNoteRow,
  localEvolutionPreflightIssue,
  LocalEvolutionPreflightError,
  LOCAL_CAPTURE_SOURCE,
  LOCAL_EVOLUTION_NOTE_MAX_CHARS,
} from "../evolution-local-core";

let failures = 0, total = 0;
function check(name: string, cond: boolean, detail = "") { total++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`); if (!cond) failures++; }

// ── Part 1 — evolutionGateIssue's decision logic ──────────────────

check("1a no preceding graded turn passes", evolutionGateIssue({ turn_no: null, has_note: false, prompt_required: false, has_prompt: false }) === null);
check("1b code note without prompt content passes", evolutionGateIssue({ turn_no: 1, has_note: true, prompt_required: false, has_prompt: false }) === null);
check("1c prompt note without exact body is refused", /exact prompt body is missing/.test(evolutionGateIssue({ turn_no: 2, has_note: true, prompt_required: true, has_prompt: false }) ?? ""));
check("1d prompt note with exact body passes", evolutionGateIssue({ turn_no: 2, has_note: true, prompt_required: true, has_prompt: true }) === null);
check("1e missing change note is refused", /change note is missing/.test(evolutionGateIssue({ turn_no: 3, has_note: false, prompt_required: false, has_prompt: false }) ?? ""));

// ── Part 2 — buildLocalNoteRow (self-host row shaping) ──────────────────────────

const promptRow = buildLocalNoteRow({ turn_no: 1, note: "  swapped the dedup prompt  ", artifact_kind: "prompt" });
check("2a a 'prompt' artifact_kind still builds prompt_required:false (no prompt_content table locally)", promptRow.prompt_required === false, JSON.stringify(promptRow));
check("2b expected_prompt_hash is always null locally", promptRow.expected_prompt_hash === null);
check("2c capture_source is the local literal", promptRow.capture_source === LOCAL_CAPTURE_SOURCE);
check("2d the note is trimmed", promptRow.note === "swapped the dedup prompt");

const mixedRow = buildLocalNoteRow({ turn_no: 2, note: "code + prompt both changed", artifact_kind: "mixed" });
check("2e a 'mixed' artifact_kind also builds prompt_required:false", mixedRow.prompt_required === false);

const longNote = "x".repeat(LOCAL_EVOLUTION_NOTE_MAX_CHARS + 50);
const cappedRow = buildLocalNoteRow({ turn_no: 3, note: longNote, artifact_kind: "code" });
check("2f the note is capped at the max length", cappedRow.note.length === LOCAL_EVOLUTION_NOTE_MAX_CHARS);

let emptyNoteThrew = false;
try { buildLocalNoteRow({ turn_no: 4, note: "   ", artifact_kind: "code" }); }
catch { emptyNoteThrew = true; }
check("2g an empty (post-trim) note throws rather than silently skipping the write", emptyNoteThrew);

let badKindThrew = false;
try { buildLocalNoteRow({ turn_no: 5, note: "ok", artifact_kind: "legacy" as any }); }
catch { badKindThrew = true; }
check("2h an unrecognized artifact_kind throws", badKindThrew);

// ── Part 3 — localEvolutionPreflightIssue (the adapter's decision) ─────────────

check("3a first turn on a job (no latest turn, nextTurnNo 1) passes", localEvolutionPreflightIssue({ nextTurnNo: 1, latestTurnNo: null, hasNote: false }) === null);
check("3b a captured predecessor turn passes", localEvolutionPreflightIssue({ nextTurnNo: 3, latestTurnNo: 2, hasNote: true }) === null);
const missingNoteIssue = localEvolutionPreflightIssue({ nextTurnNo: 3, latestTurnNo: 2, hasNote: false });
check("3c a predecessor turn with no note refuses, naming that turn", /change note is missing/.test(missingNoteIssue ?? "") && /turn 2/.test(missingNoteIssue ?? ""), String(missingNoteIssue));
const mismatchIssue = localEvolutionPreflightIssue({ nextTurnNo: 9, latestTurnNo: 2, hasNote: true });
check("3d a caller/DB turn-number mismatch is its own typed refusal, not a false pass", /expected to be preparing turn 3/.test(mismatchIssue ?? ""), String(mismatchIssue));
const badNextTurn = localEvolutionPreflightIssue({ nextTurnNo: 0, latestTurnNo: null, hasNote: false });
check("3e a non-positive nextTurnNo is refused before any DB-shaped check runs", /must be a positive integer/.test(badNextTurn ?? ""), String(badNextTurn));

// ── Part 4 — LocalEvolutionPreflightError shape ─────────────────────────────────

const err = new LocalEvolutionPreflightError("evolution capture incomplete for turn 2: the change note is missing; repair that turn before grading another");
check("4a the typed error is an instance of Error", err instanceof Error);
check("4b the typed error carries its own name (not generic 'Error')", err.name === "LocalEvolutionPreflightError");
check("4c the typed error's message is the gate's own wording (surfaced verbatim by mcp-server's toolError)", /change note is missing/.test(err.message));

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${total - failures}/${total}`);
process.exit(failures === 0 ? 0 : 1);
