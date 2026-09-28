// Titration MCP — extraction ritual: propose_cards I/O (single advisory call).
//
// The brain that DRAFTS candidate non-verdict cards from a
// completed run for the user's agent to review + create. The discipline (PROPOSE_SYSTEM), the
// user-prompt assembly, and the PURE validation/normalization live in propose-core.ts (offline-
// tested); this is the thin I/O layer. The split mirrors harness-validate.ts <-> harness-validate-core.ts.
//
//   • SINGLE strong-model call (callJudge) — a proposal is ADVISORY, not a numeric verdict, so the
//     >=2-cross-vendor rule (verdict surfaces only, gotcha #8a) does NOT apply.
//   • Reads the tenant ledger (cardSearch) for DEDUP context only — fail-open; creates NOTHING.
//   • ADVISORY-NOT-BLOCKING: returns drafts; the local agent confirms + calls card_create/card_relate.

import { callJudge, HELPER_TIMEOUT_MS, type JudgeSpec } from "./judge";
import { cardSearch } from "./store";
import { familyForOpenRouterSlug } from "./referee-catalog-core";
import { resolveHelperJudgeSpec } from "./judges-roster";
import { PROPOSE_SYSTEM, buildProposeUserPrompt, assembleProposal, type CardProposal } from "./propose-core";

const INPUT_CAP = 24000; // bound the run summary so it can't blow the model's context
const NEIGHBOR_CAP = 8000; // bound the dedup context

export interface ProposeCardsInput {
  run_summary: string | object; // what the completed run produced (REQUIRED — the server cannot see the work)
  tenant?: string; // optional — if given, pull nearest cards for dedup context
  run_ref?: string; // optional run ref for observed_in suggestions
  existing_cards?: string | object; // optional agent-supplied existing-card context (merged with the tenant pull)
  k?: number; // how many neighbors to pull (1-25, default 8)
  propose_model?: string; // override the single strong model
}

function asText(v: unknown, cap: number): string {
  if (v == null) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  const t = s.trim();
  return t.length <= cap ? t : t.slice(0, cap - 1) + "…";
}

// Pull the nearest existing cards for dedup context (read-only, fail-open). The proposer must see
// what already exists so it sets duplicate_of rather than drafting a near-duplicate.
async function pullNeighbors(tenant: string, query: string, k: number): Promise<string> {
  try {
    // Dedup is against the tenant's own actionable cards. Curated platform cards
    // stay internal and cannot be returned as duplicate_of targets the tenant
    // cannot inspect or update.
    const res: any = await cardSearch(query.slice(0, 4000), tenant, k, { activeOnly: true });
    const rows = Array.isArray(res?.results) ? res.results : [];
    return rows.map((r: any) => `${r.card_ref} [${r.type}] ${r.title}`).join("\n");
  } catch {
    return ""; // fail-open: a dedup-context miss degrades quality, never blocks the proposal
  }
}

export async function proposeCards(input: ProposeCardsInput): Promise<CardProposal> {
  const runSummary = asText(input?.run_summary, INPUT_CAP);
  if (!runSummary) {
    throw new Error("run_summary is required — the server cannot see the run, so the local agent must supply what happened (the evidence the proposals are grounded in).");
  }
  const runRef = input?.run_ref && String(input.run_ref).trim() ? String(input.run_ref).trim() : null;

  const pulled =
    typeof input?.tenant === "string" && input.tenant.trim()
      ? await pullNeighbors(input.tenant.trim(), runSummary, Math.min(Math.max(Number(input?.k) || 8, 1), 25))
      : "";
  const supplied = asText(input?.existing_cards, NEIGHBOR_CAP);
  const existingCards = [pulled, supplied].filter(Boolean).join("\n").slice(0, NEIGHBOR_CAP);

  const userPrompt = buildProposeUserPrompt(runSummary, existingCards, runRef);

  // SINGLE strong-model call (callJudge handles temp-0 + one reproducible retry + loose-JSON parse).
  // An explicit propose_model override (any OpenRouter chat model slug) wins;
  // otherwise resolve via TITRATION_HELPER_MODEL else the first available verified
  // door (subscription CLIs first) — never an unverified door, typed refusal if none.
  const spec: JudgeSpec = input?.propose_model
    ? { id: "propose", family: familyForOpenRouterSlug(input.propose_model), door: "openrouter", model: input.propose_model }
    : await resolveHelperJudgeSpec();
  const raw = await callJudge(spec, PROPOSE_SYSTEM, userPrompt, { timeoutMs: HELPER_TIMEOUT_MS });

  // Pure invariant-checked assembly: enforces allowed types, METHOD => requires_confirmation,
  // contradicts/supersedes => high_stakes, dedup pass-through. Creates nothing.
  return assembleProposal(raw, runRef);
}
