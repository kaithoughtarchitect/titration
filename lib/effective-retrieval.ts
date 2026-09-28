// The public card surface: `card_search` and `card_get` route through
// this module's `effectiveCardSearch` / `effectiveCardGet` so every result is
// merged with the shared read-only `__base__` layer and labelled `layer: "project"
// | "base"` before it reaches a caller. This file (plus effective-retrieval-core.ts
// for the pure assembly) IS the frozen public response envelope
// (`results[] {id, layer, card_ref, ...}`, `related[]`, `layer_counts {project,
// base}` — see lib/__tests__/card-envelope.test.ts) — it is no longer an
// internal-only advisory seam. `harness_design`'s precedent pull (lib/harness-
// design.ts) also reuses these functions; that caller is advisory-only and never
// forwards the raw layered envelope into a judge/grader prompt.

import { cardDistill, cardGet, cardSearch, type CardSearchResult } from "./store";
import { embedOne } from "./embed";
import {
  assembleEffectiveSearch,
  parseCardId,
  type KnowledgeLayer,
  type LayerInput,
} from "./effective-retrieval-core";

const BASE_TENANT = "__base__";

export interface EffectiveSearchOptions {
  type?: string[];
  hops?: 1 | 2;
}

function asLayerInput(result: CardSearchResult): LayerInput {
  return { results: result.results, ...(result.related ? { related: result.related } : {}) };
}

export async function effectiveCardSearch(
  query: string,
  tenant = BASE_TENANT,
  k = 5,
  opts?: EffectiveSearchOptions,
) {
  if (!query) throw new Error("query is required");
  // One semantic query should cost one embedding even though it searches two physical layers.
  const queryVector = await embedOne(query);
  const activeOpts = { ...opts, activeOnly: true, queryVector };
  if (tenant === BASE_TENANT) {
    const base = await cardSearch(query, BASE_TENANT, k, activeOpts);
    const assembled = assembleEffectiveSearch(null, asLayerInput(base), k);
    return {
      tenant,
      model: base.model,
      query: base.query,
      layers: ["base"] as KnowledgeLayer[],
      ...assembled,
    };
  }

  const [projectResult, base] = await Promise.all([
    cardSearch(query, tenant, k, activeOpts),
    cardSearch(query, BASE_TENANT, k, activeOpts),
  ]);
  const assembled = assembleEffectiveSearch(asLayerInput(projectResult), asLayerInput(base), k);
  return {
    tenant,
    model: projectResult.model,
    query: projectResult.query,
    layers: ["project", "base"] as KnowledgeLayer[],
    ...assembled,
  };
}

export async function effectiveCardGet(
  cardRefOrId: string,
  tenant = BASE_TENANT,
  requestedLayer?: KnowledgeLayer,
) {
  // A caller who already knows the layer (harness-design.ts's precedent pull,
  // which carries `h.layer` from a prior search) skips id-parsing entirely — its
  // `cardRefOrId` is always a bare ref in that case. Everyone else (the MCP
  // `card_get` tool) may pass a bare ref OR a prefixed id ("project:T-MET-001" /
  // "base:T-MET-001" — the exact `id` a search result just returned); resolving
  // both is required.
  const { ref, layer } = requestedLayer ? { ref: cardRefOrId, layer: requestedLayer } : parseCardId(cardRefOrId);

  if (tenant === BASE_TENANT || layer === "base") {
    return { ...(await cardGet(ref, BASE_TENANT, { activeOnly: true })), layer: "base" as const };
  }
  if (layer === "project") {
    return { ...(await cardGet(ref, tenant, { activeOnly: true })), layer: "project" as const };
  }

  // Bare ref, no explicit layer: project first, then base.
  try {
    return { ...(await cardGet(ref, tenant, { activeOnly: true })), layer: "project" as const };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/not found in tenant/i.test(message)) throw error;
    return { ...(await cardGet(ref, BASE_TENANT, { activeOnly: true })), layer: "base" as const };
  }
}

export async function effectiveCardDistill(
  tenant: string,
  opts: { type?: string; tag?: string } = {},
) {
  const addLayer = (source: Awaited<ReturnType<typeof cardDistill>>, layer: KnowledgeLayer) => {
    const byType: Record<string, Array<{ id: string; card_ref: string; title: string; confidence: string | null; layer: KnowledgeLayer }>> = {};
    for (const [type, rows] of Object.entries(source.by_type)) {
      byType[type] = rows.map((row) => ({ ...row, id: `${layer}:${row.card_ref}`, card_ref: row.card_ref, layer }));
    }
    return byType;
  };

  if (tenant === BASE_TENANT) {
    const base = await cardDistill(BASE_TENANT, opts);
    return { ...base, layers: ["base"] as KnowledgeLayer[], layer_counts: { project: 0, base: base.count }, by_type: addLayer(base, "base") };
  }

  const [projectResult, base] = await Promise.all([cardDistill(tenant, opts), cardDistill(BASE_TENANT, opts)]);
  const projectTypes = addLayer(projectResult, "project");
  const baseTypes = addLayer(base, "base");
  const byType: Record<string, Array<{ id: string; card_ref: string; title: string; confidence: string | null; layer: KnowledgeLayer }>> = {};
  for (const type of new Set([...Object.keys(projectTypes), ...Object.keys(baseTypes)])) {
    byType[type] = [...(projectTypes[type] ?? []), ...(baseTypes[type] ?? [])];
  }
  return {
    tenant,
    count: projectResult.count + base.count,
    filter: opts,
    layers: ["project", "base"] as KnowledgeLayer[],
    layer_counts: { project: projectResult.count, base: base.count },
    by_type: byType,
  };
}
