// Titration MCP — graph edge_propose I/O (single advisory call). Mirrors card-propose.ts.
//
// Reads the SOURCE card + its nearest neighbors (the candidate targets) + the source's existing
// edges (for dedup), makes ONE advisory callJudge, and returns proposed typed edges for the agent
// to confirm. Creates NOTHING — it only reads, so it works on any tenant; confirmed edges are applied
// through card_relate in a writable project workspace.
// The pure validate/split/dedup core lives in edge-propose-core.ts.

import { callJudge, HELPER_TIMEOUT_MS, type JudgeSpec } from "./judge";
import { cardGet, cardSearch } from "./store";
import { familyForOpenRouterSlug } from "./referee-catalog-core";
import { resolveHelperJudgeSpec } from "./judges-roster";
import { EDGE_PROPOSE_SYSTEM, buildEdgeProposeUserPrompt, assembleEdgeProposal, type EdgeProposal } from "./edge-propose-core";

const SOURCE_CAP = 12000;

export interface ProposeEdgesInput {
  card_ref: string; // the source card to propose edges FROM (REQUIRED)
  tenant: string; // REQUIRED — reads the source + neighbors (read-only)
  k?: number; // neighbor candidates to consider (1-25, default 8)
  propose_model?: string; // override the single strong model
}

function cap(s: string, n: number): string {
  const t = (s ?? "").trim();
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}

export async function proposeEdges(input: ProposeEdgesInput): Promise<EdgeProposal> {
  if (!input?.card_ref) throw new Error("card_ref is required (the source card to propose edges from)");
  if (!input?.tenant) throw new Error("tenant is required");
  const k = Math.min(Math.max(Number(input?.k) || 8, 1), 25);

  const source: any = await cardGet(input.card_ref, input.tenant);
  const sourceText = cap(`${source.card_ref} [${source.type}] ${source.title}\n\n${source.body}`, SOURCE_CAP);
  const existingEdges: string[] = Array.isArray(source.edges) ? source.edges : [];

  // Pull neighbors as candidate targets (k+1 then drop the source if it surfaces). Approved memory only
  // (`activeOnly`), matching every sibling caller (effective-retrieval, card_search, card-propose, flywheel):
  // a proposal must not be grounded in a pending/candidate card a reviewer has not yet approved.
  const neighbors: any = await cardSearch(`${source.title}\n\n${source.body}`.slice(0, 4000), input.tenant, k + 1, { activeOnly: true });
  const rows = (Array.isArray(neighbors?.results) ? neighbors.results : []).filter((r: any) => r.card_ref !== input.card_ref).slice(0, k);
  const candidateRefs: string[] = rows.map((r: any) => r.card_ref);

  if (candidateRefs.length === 0) {
    return { advisory: true, from: input.card_ref, proposals: [], summary: `No neighbor candidates found for ${input.card_ref}.`, note: "ADVISORY — no candidates to relate." };
  }

  const candidates = rows.map((r: any) => `${r.card_ref} [${r.type}] ${r.title}`).join("\n");
  const userPrompt = buildEdgeProposeUserPrompt(sourceText, candidates, existingEdges.join("\n"));

  // SINGLE strong-model call — advisory, NOT a verdict (the >=2-judge rule does not
  // apply). An explicit propose_model override wins; otherwise TITRATION_HELPER_MODEL
  // else the first available verified door (subscription CLIs first), typed refusal if none.
  const spec: JudgeSpec = input?.propose_model
    ? { id: "edge-propose", family: familyForOpenRouterSlug(input.propose_model), door: "openrouter", model: input.propose_model }
    : await resolveHelperJudgeSpec();
  const raw = await callJudge(spec, EDGE_PROPOSE_SYSTEM, userPrompt, { timeoutMs: HELPER_TIMEOUT_MS });

  return assembleEdgeProposal(raw, { fromRef: input.card_ref, candidateRefs, existingEdges });
}
