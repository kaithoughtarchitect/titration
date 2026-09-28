// Titration MCP — harness_design I/O (precedent pull + single design call).
//
// The single-strong-model brain that returns a PROPOSED design package. This is
// the I/O layer; the schema, the discipline prompt (DESIGN_SYSTEM), and the pure
// invariant-checked assembly live in harness-design-core.ts (offline-tested). The
// split mirrors flywheel.ts ↔ flywheel-core.ts.
//
// Two reuses, NOT re-authored (handoff §3 / gotcha — do NOT rebuild):
//   • store.ts cardSearch + cardGet — pull precedent (Tier-A) to GROUND the design.
//     Precedent NEVER enters a judge/grader prompt elsewhere; here it only grounds a
//     DESIGN (advisory, human-reviewed) — not a verdict. Advisory-only preserved.
//   • judge.ts callJudge — a SINGLE strong-model call (NOT 3-judge consensus). A
//     design is advisory + human-reviewed; PROPOSED-first is the trust gate, so the
//     ≥2-cross-vendor-judge rule (verdict surfaces only) deliberately does NOT apply.

import { effectiveCardSearch, effectiveCardGet } from "./effective-retrieval";
import type { KnowledgeLayer } from "./effective-retrieval-core";
import { callJudge, HELPER_TIMEOUT_MS, type JudgeSpec } from "./judge";
import { familyForOpenRouterSlug } from "./referee-catalog-core";
import { resolveHelperJudgeSpec } from "./judges-roster";
import {
  DESIGN_SYSTEM,
  buildDesignUserPrompt,
  buildRepairPrompt,
  assembleDesignPackage,
  CHANGE_TYPES,
  type ChangeType,
  type DesignPackage,
  type PrecedentCard,
} from "./harness-design-core";

const MAX_PRECEDENT = 3; // top-k precedent cards (by relevance) whose bodies ground the design
const QUERY_CAP = 500; // bound the embedded precedent query (cardSearch embeds it)

export interface HarnessDesignInput {
  system_description: string;
  change_type: ChangeType;
  baseline_facts?: string;
  codebase_facts?: string | object; // verified repo facts; the only source for concrete values
  tenant?: string; // caller's tenant to ALSO search for precedent (besides __base__); reads only
  design_model?: string; // override the single strong model (default: TITRATION_HELPER_MODEL else the first available verified door)
}

// Pull precedent from the caller's cards plus the public base starter pack and keep
// the top-MAX_PRECEDENT by relevance. Base cards are public, so they are cited as-is.
// Fully fail-open: precedent is advisory grounding — a DB miss degrades to "no
// precedent" (the prompt builder handles an empty list), it never blocks the design.
async function pullPrecedent(query: string, callerTenant?: string): Promise<PrecedentCard[]> {
  const tenant = callerTenant?.trim() || "__base__";
  const hits: { layer: KnowledgeLayer; card_ref: string; type: string; title: string; score: number }[] = [];
  try {
    const r = await effectiveCardSearch(query, tenant, 5);
    for (const h of r.results) {
      hits.push({
        layer: h.layer,
        card_ref: h.card_ref,
        type: h.type,
        title: h.title,
        score: h.score,
      });
    }
  } catch {
    /* fail-open: a search miss contributes no precedent */
  }
  hits.sort((a, b) => b.score - a.score);

  const out: PrecedentCard[] = [];
  for (const h of hits.slice(0, MAX_PRECEDENT)) {
    let body = "";
    try {
      const c = await effectiveCardGet(h.card_ref, tenant, h.layer);
      body = c.body ?? "";
    } catch {
      /* fail-open: keep the ref/title even if the body fetch fails */
    }
    out.push({
      tenant: h.layer === "base" ? "__base__" : tenant,
      card_ref: h.card_ref,
      title: h.title,
      type: h.type,
      score: h.score,
      body,
    });
  }
  return out;
}

export async function harnessDesign(input: HarnessDesignInput): Promise<DesignPackage> {
  const desc = String(input?.system_description ?? "").trim();
  if (!desc) throw new Error("system_description is required");
  if (!CHANGE_TYPES.includes(input.change_type)) {
    throw new Error(`change_type must be one of: ${CHANGE_TYPES.join(" | ")}`);
  }

  const query = `${desc} (${input.change_type})`.slice(0, QUERY_CAP);
  const precedent = await pullPrecedent(query, input.tenant);

  const userPrompt = buildDesignUserPrompt(
    {
      system_description: desc,
      change_type: input.change_type,
      baseline_facts: input.baseline_facts,
      codebase_facts: typeof input.codebase_facts === "string" ? input.codebase_facts
        : input.codebase_facts ? JSON.stringify(input.codebase_facts, null, 2) : undefined,
    },
    precedent,
  );

  // SINGLE strong-model call (callJudge handles temp-0 + one reproducible retry +
  // loose-JSON parsing). Not a panel — a design is not a verdict. An explicit
  // design_model override wins; otherwise TITRATION_HELPER_MODEL else the first
  // available verified door (subscription CLIs first), typed refusal if none.
  const spec: JudgeSpec = input.design_model
    ? { id: "design", family: familyForOpenRouterSlug(input.design_model), door: "openrouter", model: input.design_model }
    : await resolveHelperJudgeSpec();
  const raw = await callJudge(spec, DESIGN_SYSTEM, userPrompt, { timeoutMs: HELPER_TIMEOUT_MS });

  // Pure, invariant-checked assembly (throws on a malformed design — better than shipping a broken
  // instrument). status is forced to PROPOSED inside.
  //
  // INVARIANT-REPAIR retry: the design call is a non-deterministic model that OCCASIONALLY emits a
  // ship_gate label with a prose (unquantified) threshold despite the prompt forbidding it (~a few % —
  // measured), which makes assembleDesignPackage throw `invariants violated` → a hard failure with no
  // recourse. On that SPECIFIC failure, re-ask the brain ONCE with the exact violations fed back
  // (buildRepairPrompt), then re-assemble. Cheap: the extra call fires ONLY on the rare failure path,
  // and a 2nd failure still throws (genuinely broken → fail-loud, never a silent broken instrument).
  // (callJudge's own retry covers transient/parse errors — a DIFFERENT layer; this repairs a semantic slip.)
  try {
    return assembleDesignPackage(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/invariants violated/i.test(msg)) throw e; // only repair the model-compliance slip
    const repaired = await callJudge(spec, DESIGN_SYSTEM, buildRepairPrompt(userPrompt, msg), { timeoutMs: HELPER_TIMEOUT_MS });
    return assembleDesignPackage(repaired); // a 2nd invariant failure throws → fail-loud
  }
}
