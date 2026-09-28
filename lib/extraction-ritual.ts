// Titration MCP — the EXTRACTION RITUAL, authored once.
//
// The MCP equivalent of a "review this run and extract learnings" skill, but it travels WITH
// the service instead of being installed: the discipline lives in tool descriptions (the
// always-works, vendor-agnostic carrier every MCP client reads) + a run-end nudge on the result
// of a completed run. The server is reactive and blind to the user's work — so it can never
// DECIDE when to extract; it can only put the ritual where the user's own agent will see it and
// act. The agent supplies the judgment + the timing; the server supplies the primitives + this
// guidance.
//
// Authored ONCE here so the tool descriptions and the nudge cannot drift apart. NO imports on
// store/sql/fetch/embed (this is a pure constant module; store.ts throws at import without
// TITRATION_DATABASE_URL). The one import below (RefusalClass, a type-only import from the
// equally import-clean lib/refusal-capture-core.ts) does not reintroduce that risk.

import type { RefusalClass } from "./refusal-capture-core";

// The full ritual — embedded in the card_create tool description (the tool the agent reads
// right when it is about to create), and the source of the shorter per-tool reminders.
export const EXTRACTION_RITUAL = `THE EXTRACTION RITUAL (the /t-run analog — run it after a harness / analysis / corpus run when durable learnings may exist; trigger it on the user's "extract the cards" or on your own judgment):
1. run_capture the run FIRST — it anchors provenance and returns the run ref every new card links back to.
2. For each candidate learning, card_search FIRST — if an active card already covers the claim, update that card (pass its explicit card_ref) instead of creating a near-duplicate.
3. Keep only what passes the worthiness gate: reusable beyond this one run · changes future behavior · concrete evidence · not already covered by an active card.
4. card_create the survivors using the canonical type-specific sections. Supply sample_size, reproducibility, and origin_ref when the evidence supports them; use explicit "not recorded" / "not assessed" values instead of inventing evidence. Then card_relate an observed_in edge from each new card to the run ref (provenance is REQUIRED), plus any supports / cures / extends / contradicts edges the run established.
PER-TYPE BAR (the six card types are not equal stakes): FINDING and REGRESSION are auto-captured by the verdict flywheel — do NOT hand-create them here. METHOD is the highest-stakes type (a generalization other runs will lean on) — create only when it is clearly reusable, never speculatively. MODEL_PROFILE and PROMPT_BEHAVIOR are observed traits of a model/prompt. DATASET_NOTE is a low-stakes factual property of a corpus.`;

// The run-end nudge — attached (advisory, fail-open) to the result of a completed run so the
// agent sees it at the exact moment a run finishes. It cannot start anything; it informs the
// agent's own decision (the model-controlled, agent-decided trigger mode).
export const EXTRACTION_NUDGE =
  "This run may contain durable learnings (METHOD / MODEL_PROFILE / PROMPT_BEHAVIOR / DATASET_NOTE). If so, run the extraction ritual: card_search to avoid duplicates, then card_create the reusable ones and card_relate an observed_in edge back to this run. FINDING/REGRESSION are auto-captured by the flywheel — skip them here. This is advisory; you decide whether anything is worth keeping.";

// Refusal-class-specific advisory variants. A refusal already got a `pending` METHOD draft auto-captured into
// knowledge_review_queue (lib/refusal-capture.ts); this nudge just points the agent at that
// same class-specific lesson instead of the generic "durable learnings" reminder, so the
// wording matches what actually happened for THIS refusal. Purely advisory text — surfacing it
// changes no verdict, no queue row, no return shape.
export const EXTRACTION_NUDGE_BY_CLASS: Record<RefusalClass, string> = {
  reproduce_fail:
    "This baseline REFUSED to reproduce the failure. A draft METHOD candidate for this refusal class was auto-captured to knowledge_review_queue — review/approve it, and if the corpus itself needs fixing (a corpus-gap), harvest real traces that exercise the mode rather than re-freezing on the same weak corpus.",
  effective_n_low:
    "This verify came back inconclusive on effective-N (too few scorable rows). A draft METHOD candidate for this refusal class was auto-captured to knowledge_review_queue — review/approve it, and expand the corpus before re-running; a low-N delta is not evidence either way.",
  noise_floor:
    "This verify's delta fell inside the noise floor (1 − inter-judge agreement) — inconclusive, not a win. A draft METHOD candidate for this refusal class was auto-captured to knowledge_review_queue — review/approve it, and add signal or sharpen the rubric rather than over-claiming the delta.",
  judge_variance:
    "This verify came back inconclusive on judge variance (either low inter-judge agreement, or judges disagreeing on the SIGN of the change). A draft METHOD candidate for this refusal class was auto-captured to knowledge_review_queue — review/approve it, and recalibrate/escalate judges before re-running.",
  per_mode_regression:
    "This verify improved in aggregate but regressed on at least one mode beyond the noise floor — does not ship. A draft METHOD candidate for this refusal class was auto-captured to knowledge_review_queue — review/approve it, and address the regressed mode(s) directly rather than trusting the aggregate movement.",
};

// Decorate an outgoing tool result with the nudge (additive `extraction_hint` field). Only
// plain objects are decorated — arrays/scalars/null pass through untouched so no result shape
// is broken (e.g. an async `{ job_id }` is fine to annotate; a non-object is left alone).
// `refusalClass` is optional: when the caller knows the run just landed
// in a specific refusal class, passing it surfaces that class-specific variant in place of the
// generic EXTRACTION_NUDGE; omitting it (every existing caller today) is byte-identical to
// before this change — the generic constant remains the fallback.
export function attachExtractionHint<T>(result: T, refusalClass?: RefusalClass | null): T {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const hint = refusalClass ? EXTRACTION_NUDGE_BY_CLASS[refusalClass] : EXTRACTION_NUDGE;
    return { ...(result as Record<string, unknown>), extraction_hint: hint } as T;
  }
  return result;
}

// ── The extract_learnings MCP prompt (the on-command "/t-run now" analog) ───────────────
// An MCP *prompt* (not a tool) the server exposes for clients that support the prompts capability
// (e.g. Claude Code surfaces it as a slash command). It is a CONVENIENCE on top of the universal
// tool-description path — clients without prompt support still get the same discipline from the tool
// descriptions, so nothing depends on it (the vendor-agnostic guarantee). It does NOT change the tool
// count (a prompt is a distinct MCP primitive). The body reuses EXTRACTION_RITUAL so it can't drift.

export const EXTRACT_LEARNINGS_PROMPT_NAME = "extract_learnings";
export const EXTRACT_LEARNINGS_PROMPT_DESCRIPTION =
  "Run the extraction ritual on a completed run — review it and create durable METHOD / MODEL_PROFILE / PROMPT_BEHAVIOR / DATASET_NOTE cards (the /t-run analog). Optional args: run_id, run_summary.";

export function buildExtractLearningsPrompt(args: { run_id?: string; run_summary?: string } = {}): string {
  const runId = args.run_id?.trim();
  const summary = args.run_summary?.trim();
  const ctx: string[] = [];
  if (runId) ctx.push(`Run: ${runId}`);
  if (summary) ctx.push(`Run summary:\n${summary}`);
  const ctxBlock = ctx.length ? `\n\n${ctx.join("\n\n")}` : "";
  return (
    `Run the Titration extraction ritual on the run you just completed${runId ? ` (${runId})` : ""}.\n\n` +
    EXTRACTION_RITUAL +
    ctxBlock +
    `\n\nIf you'd like a draft to start from, call \`propose_cards\` with the run summary — it drafts candidate cards (+ suggested edges) for you to confirm and creates nothing. Then create the ones you confirm via \`card_create\` + \`card_relate\` (and an \`observed_in\` edge to the run).`
  );
}
