// Pure assembly for the layered card surface: caller-project active memory +
// shared __base__ active memory. This is the SAME pure assembler the public
// `card_search` / `card_get` MCP tools return through (lib/effective-retrieval.ts
// is the I/O layer that calls it); see that file's header for the public-envelope
// contract this module's shapes are frozen against.
//
// A project card and a base card may legally share a card_ref. `id` is therefore
// the stable layered identity; bare card_ref remains display/provenance text
// only.
// No DB/embed imports, clocks, or randomness: deterministic and offline-testable.

// "project" (caller-private) | "base" (shared curated). Internal code and
// the DB keep "tenant" naming — this is the one place the public-facing
// label lives, because it is returned to the caller as part of the card envelope.
export type KnowledgeLayer = "project" | "base";

export interface RetrievalHit {
  card_ref: string;
  type: string;
  title: string;
  score: number;
  edges: string[];
}

export interface RetrievalRelated {
  card_ref: string;
  type: string;
  title: string;
  score: number;
  via: string;
  hop: number;
}

export interface LayerInput {
  results: RetrievalHit[];
  related?: RetrievalRelated[];
}

export type LayeredHit = RetrievalHit & { id: string; layer: KnowledgeLayer };
export type LayeredRelated = RetrievalRelated & { id: string; layer: KnowledgeLayer };

export interface EffectiveSearchAssembly {
  results: LayeredHit[];
  related?: LayeredRelated[];
  layer_counts: { project: number; base: number };
}

export function layeredId(layer: KnowledgeLayer, cardRef: string): string {
  return `${layer}:${cardRef}`;
}

function tagHits(rows: RetrievalHit[], layer: KnowledgeLayer): LayeredHit[] {
  return rows.map((row) => ({ ...row, id: layeredId(layer, row.card_ref), layer }));
}

function tagRelated(rows: RetrievalRelated[], layer: KnowledgeLayer): LayeredRelated[] {
  return rows.map((row) => ({ ...row, id: layeredId(layer, row.card_ref), layer }));
}

function byScoreThenId<T extends { score: number; id: string }>(a: T, b: T): number {
  return b.score - a.score || a.id.localeCompare(b.id);
}

export function assembleEffectiveSearch(
  projectLayer: LayerInput | null,
  baseLayer: LayerInput,
  k: number,
): EffectiveSearchAssembly {
  const limit = Math.min(Math.max(Math.trunc(k) || 0, 1), 25);
  const projectHits = projectLayer ? tagHits(projectLayer.results, "project") : [];
  const baseHits = tagHits(baseLayer.results, "base");
  const results = [...projectHits, ...baseHits].sort(byScoreThenId).slice(0, limit);

  const hasRelated = (projectLayer !== null && "related" in projectLayer) || "related" in baseLayer;
  if (!hasRelated) {
    return {
      results,
      layer_counts: { project: projectHits.length, base: baseHits.length },
    };
  }

  const directIds = new Set(results.map((row) => row.id));
  const allRelated = [
    ...(projectLayer ? tagRelated(projectLayer.related ?? [], "project") : []),
    ...tagRelated(baseLayer.related ?? [], "base"),
  ];
  const related = allRelated
    .filter((row) => !directIds.has(row.id))
    .sort(byScoreThenId)
    .slice(0, 6);

  return {
    results,
    related,
    layer_counts: { project: projectHits.length, base: baseHits.length },
  };
}

// `card_get` accepts either a bare ref ("T-MET-001") or a prefixed layered id
// ("project:T-MET-001" / "base:T-MET-001" — the exact `id` shape card_search just
// returned). Pure string parsing only: a recognized prefix ("project" or "base")
// followed by ':' and a non-empty remainder is peeled off; anything else
// (no colon, an unrecognized prefix, or an empty remainder) is treated as a bare
// ref with `layer: null`, which the I/O layer resolves project-first-then-base.
export function parseCardId(id: string): { ref: string; layer: KnowledgeLayer | null } {
  const trimmed = id.trim();
  const idx = trimmed.indexOf(":");
  if (idx > 0) {
    const prefix = trimmed.slice(0, idx);
    if (prefix === "project" || prefix === "base") {
      const ref = trimmed.slice(idx + 1).trim();
      if (ref) return { ref, layer: prefix };
    }
  }
  return { ref: trimmed, layer: null };
}
