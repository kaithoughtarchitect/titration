// Titration MCP — extraction ritual v2: the PURE card-proposal discipline + validation (no I/O, no imports).
//
// SPEC-extraction-ritual.md (v2). `propose_cards` is the advisory "orchestration tool, done
// safe": given a completed run + the nearest existing cards, a SINGLE strong-model call DRAFTS
// candidate cards for the user's agent to review, confirm, and create. It creates NOTHING. This
// module is the discipline (PROPOSE_SYSTEM) + the user-prompt assembly + the PURE validation/
// normalization (allowed types, per-type stakes, high-stakes-edge flagging, dedup pass-through)
// — offline-testable without a DB or a model. The single callJudge lives in card-propose.ts.
//
// Mirrors harness-validate-core / harness-design-core exactly:
//   • SINGLE strong-model call (advisory, NOT a verdict) — the >=2-cross-vendor rule (verdict
//     surfaces only, gotcha #8a) does NOT apply.
//   • The model DRAFTS; the host enforces the invariants DETERMINISTICALLY here (allowed types,
//     METHOD => requires_confirmation, contradicts/supersedes => high_stakes edge) so quality
//     rules never drift into model arithmetic.
//   • NO imports (store.ts throws at import without TITRATION_DATABASE_URL).
//
// Shared skeleton with the graph edge-proposal module (auto-EDGE proposal): this proposes NODES;
// that module proposes EDGES, but both are single-advisory-call + pure-split-of-conservative-vs-high-stakes.
// It reuses this shape (the harness-design-core <-> harness-validate-core mirror), it does not re-author it.

import { canonicalizeCard, type CardSection } from "./card-contract-core";

// The four NON-VERDICT card types this tool may propose. FINDING/REGRESSION are auto-captured by
// the verdict flywheel and are deliberately excluded (proposing them here would duplicate that).
export const PROPOSABLE_TYPES = ["METHOD", "MODEL_PROFILE", "PROMPT_BEHAVIOR", "DATASET_NOTE"] as const;
export type ProposableType = (typeof PROPOSABLE_TYPES)[number];

// Highest-stakes type: a generalization other runs will lean on -> always requires confirmation.
const HIGH_STAKES_TYPES = new Set<string>(["METHOD"]);

// The finite predicate vocabulary (mirrors titration_protocol.md / ingest VALID_PRED).
const PREDICATES = new Set<string>([
  "supersedes", "superseded_by", "supports", "contradicts", "complements",
  "extends", "instance_of", "observed_in", "documented_in", "cures",
]);
// High-stakes predicates: a wrong one is worse than a missing one -> never auto-created, PROPOSED-only.
const HIGH_STAKES_PREDICATES = new Set<string>(["contradicts", "supersedes"]);

const CONFIDENCES = new Set<string>(["low", "medium", "high", "critical"]);

export type Confidence = "low" | "medium" | "high" | "critical";

export interface ProposedEdge {
  predicate: string;
  to: string; // an existing card ref (T-XXX-NNN) or a run ref (RUN-...)
  high_stakes: boolean; // contradicts/supersedes -> the agent must confirm before card_relate
}

export interface ProposedCard {
  type: ProposableType;
  title: string;
  body: string; // markdown draft (summary + evidence + application)
  sections: CardSection[];
  confidence: Confidence;
  tags: string[];
  sample_size: string | null;
  reproducibility: string | null;
  origin_ref: string | null;
  requires_confirmation: boolean; // true for METHOD (high-stakes generalization)
  duplicate_of: string | null; // an existing card ref this would duplicate -> UPDATE that, do not create anew
  rationale: string; // why it clears the worthiness gate
  suggested_edges: ProposedEdge[];
}

export interface CardProposal {
  advisory: true; // advisory-not-blocking: nothing is created; the agent reviews + acts
  proposals: ProposedCard[];
  skipped_verdict_types: number; // count of FINDING/REGRESSION the model tried to propose (rejected here)
  summary: string;
  note: string; // fixed reminder of what the agent must still do
}

const PROPOSAL_NOTE =
  "ADVISORY — nothing was created. Review each proposal; for the ones worth keeping, card_create the card (or update the duplicate_of card with an explicit card_ref) and card_relate the suggested edges, including an observed_in edge to the run. Cards/edges marked requires_confirmation / high_stakes must not be created without your explicit confirmation.";

// ── PROPOSE_SYSTEM — the discipline port (the /t-card worthiness gate + per-type stakes) ──
export const PROPOSE_SYSTEM = `You are the card-extraction brain of the Titration apparatus. Given a completed run (a harness / analysis / corpus run the user's agent just finished) and the nearest existing cards in the tenant ledger, you PROPOSE candidate knowledge cards worth keeping — for the user's agent to review, confirm, and create. You create nothing; you DRAFT.

YOU CANNOT SEE THE WORK. You have only the run summary and the existing-card context the local agent supplied. Propose only what that text supports — never invent evidence, never propose grounding you were not given.

ONLY the four NON-VERDICT card types: METHOD, MODEL_PROFILE, PROMPT_BEHAVIOR, DATASET_NOTE. Do NOT propose FINDING or REGRESSION — those are auto-captured by the verdict flywheel; proposing them here duplicates that.

THE WORTHINESS GATE — propose a card ONLY if it is ALL of: reusable beyond this one run · changes future behavior · grounded in concrete evidence from the summary · not already covered by a supplied existing card. If a candidate duplicates an existing card, do NOT propose a new card — set "duplicate_of" to that card's ref so the agent UPDATES it instead. When nothing clears the bar, return an empty proposals array. Never force a card.

PER-TYPE STAKES:
- METHOD — a generalization other runs will lean on. HIGHEST stakes: propose only when clearly and broadly reusable, never speculatively.
- MODEL_PROFILE / PROMPT_BEHAVIOR — an observed durable trait of a specific model or prompt.
- DATASET_NOTE — a factual property of a corpus (low stakes).

SUGGESTED EDGES — for each proposed card, suggest typed edges to EXISTING cards or to the run. Conservative: supports / complements / extends / cures / instance_of. HIGH-STAKES: contradicts / supersedes — assert these only with strong evidence; a wrong one is worse than a missing one. Always suggest an observed_in edge to the run ref when one is provided. Only use predicates from this set: supersedes, superseded_by, supports, contradicts, complements, extends, instance_of, observed_in, documented_in, cures.

DIAGNOSE, don't pad. The title is a claim; the body is its evidence + application. Be concrete and specific to this run.

OUTPUT — JSON ONLY, no prose outside it, no markdown fences:
{
  "summary": "<1-2 sentences: what this run is worth keeping, or that nothing clears the bar>",
  "proposals": [
    {
      "type": "METHOD|MODEL_PROFILE|PROMPT_BEHAVIOR|DATASET_NOTE",
      "title": "<concise claim>",
      "body": "<markdown: summary, evidence, application>",
      "confidence": "low|medium|high|critical",
      "tags": ["short-slug", "..."],
      "sample_size": "<evidence size, or not recorded>",
      "reproducibility": "<high|medium|low|not assessed>",
      "origin_ref": "<RUN-... when supplied, otherwise null>",
      "duplicate_of": "<existing card ref this duplicates, or null>",
      "rationale": "<why it clears the worthiness gate>",
      "suggested_edges": [ { "predicate": "supports|extends|observed_in|...", "to": "<card ref or run ref>" } ]
    }
  ]
}
Emit an empty proposals array (not a forced card) when nothing is worth keeping.`;

// ── pure user-prompt assembly ──────────────────────────────────────────────────────
export function buildProposeUserPrompt(runSummary: string, existingCards: string, runRef: string | null): string {
  const parts: string[] = [];
  parts.push("COMPLETED RUN (extract durable, non-verdict learnings from this — the server cannot see the work, judge only what is here):");
  parts.push(String(runSummary ?? "").trim());
  parts.push(
    "\nNEAREST EXISTING CARDS (do NOT propose a duplicate of any of these — set duplicate_of to its ref instead; suggest edges TO these where warranted):\n" +
      (String(existingCards ?? "").trim() || "(none supplied)"),
  );
  parts.push("\nRUN REF for observed_in edges: " + (runRef && runRef.trim() ? runRef.trim() : "(none — omit observed_in)"));
  parts.push("\nPropose the cards worth keeping. Return the JSON only.");
  return parts.join("\n");
}

// ── pure validation / normalization (the offline-testable contract) ─────────────────

function normType(raw: any): ProposableType | null {
  const t = String(raw ?? "").trim().toUpperCase().replace(/-/g, "_");
  return (PROPOSABLE_TYPES as readonly string[]).includes(t) ? (t as ProposableType) : null;
}

function normConfidence(raw: any): Confidence {
  const c = String(raw ?? "").trim().toLowerCase();
  return (CONFIDENCES.has(c) ? c : "medium") as Confidence;
}

function normTags(raw: any): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((t) => String(t ?? "").trim()).filter(Boolean);
}

function normOptionalText(raw: any): string | null {
  const text = String(raw ?? "").trim();
  return text && text.toLowerCase() !== "null" ? text : null;
}

function normEdges(raw: any): ProposedEdge[] {
  if (!Array.isArray(raw)) return [];
  const out: ProposedEdge[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const predicate = String((e as any).predicate ?? "").trim().toLowerCase();
    const to = String((e as any).to ?? "").trim();
    if (!PREDICATES.has(predicate) || !to) continue; // drop invalid predicate / empty target
    out.push({ predicate, to, high_stakes: HIGH_STAKES_PREDICATES.has(predicate) });
  }
  return out;
}

// Validate + normalize the model's draft into the advisory CardProposal. Verdict-type proposals
// (FINDING/REGRESSION) and type-less/title-less entries are DROPPED (counted in skipped_verdict_types
// for the former) rather than created — the host enforces the allowed-type + stakes invariants, the
// model never gets to. Throws only on a structurally-unusable response (not an object / no proposals
// field at all), so a malformed call fails loudly instead of silently proposing nothing.
export function assembleProposal(raw: any, authoritativeOriginRef: string | null = null): CardProposal {
  if (!raw || typeof raw !== "object") throw new Error("propose_cards response is not a JSON object");
  if (!("proposals" in raw)) throw new Error("propose_cards response has no proposals field");
  const rawProposals = Array.isArray(raw.proposals) ? raw.proposals : [];

  let skippedVerdict = 0;
  const proposals: ProposedCard[] = [];
  for (const p of rawProposals) {
    if (!p || typeof p !== "object") continue;
    const rawType = String((p as any).type ?? "").trim().toUpperCase().replace(/-/g, "_");
    if (rawType === "FINDING" || rawType === "REGRESSION") { skippedVerdict++; continue; } // flywheel owns these
    const type = normType(rawType);
    const title = String((p as any).title ?? "").trim();
    const body = String((p as any).body ?? "").trim();
    if (!type || !title || !body) continue; // unusable draft — drop
    const dup = String((p as any).duplicate_of ?? "").trim();
    const confidence = normConfidence((p as any).confidence);
    const tags = normTags((p as any).tags);
    const sampleSize = normOptionalText((p as any).sample_size);
    const reproducibility = normOptionalText((p as any).reproducibility);
    const originRef = normOptionalText(authoritativeOriginRef) ?? normOptionalText((p as any).origin_ref);
    const canonical = canonicalizeCard({
      type,
      title,
      body,
      tags,
      confidence,
      sample_size: sampleSize,
      reproducibility,
      origin_ref: originRef,
    });
    proposals.push({
      type,
      title,
      body: canonical.body,
      sections: canonical.sections,
      confidence,
      tags,
      sample_size: sampleSize,
      reproducibility,
      origin_ref: originRef,
      requires_confirmation: HIGH_STAKES_TYPES.has(type),
      duplicate_of: dup && dup.toLowerCase() !== "null" ? dup : null,
      rationale: String((p as any).rationale ?? "").trim(),
      suggested_edges: normEdges((p as any).suggested_edges),
    });
  }

  const summary =
    String(raw.summary ?? "").trim() ||
    (proposals.length ? `${proposals.length} candidate card${proposals.length === 1 ? "" : "s"} proposed.` : "Nothing in this run cleared the worthiness gate.");

  return { advisory: true, proposals, skipped_verdict_types: skippedVerdict, summary, note: PROPOSAL_NOTE };
}
