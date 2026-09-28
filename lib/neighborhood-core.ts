// Titration MCP — graph richer retrieval: the PURE bounded multi-hop walk core (no I/O).
//
// cardSearch (lib/store.ts) does the
// embed/SQL/hydration I/O and feeds this pure core the seed hits + their pre-filtered card→card
// edges; this core assembles the bounded/decayed/deduped one-hop neighborhood DETERMINISTICALLY.
// Same shape as edge-propose-core / dedupe-core: an import-clean pure decision module paired with
// its I/O caller. Creates nothing; reads nothing; the host (cardSearch) enforces the I/O-layer
// invariants (superseded neighbors excluded at the fetch, tenant-correct hydration).
// NO imports (store.ts throws at import without TITRATION_DATABASE_URL; this core stays offline-testable).
// NO Date.now()/Math.random() — the walk is a pure function of (seeds, edges).

// The high-value walk vocabulary, forward direction only (from_card_id → to_card_id). Provenance /
// inverse predicates (observed_in / documented_in / superseded_by) are deliberately excluded — they
// point at runs/docs, not reasoning-relevant sibling cards. Validated against lib/store.ts PREDICATES
// (the source of truth) by the offline suite, NOT a compile-time derivation.
export const WALK_PREDICATES = ["cures", "supersedes", "contradicts", "extends"] as const;

export interface SeedHit {
  card_ref: string; // a direct cosine hit ref
  score: number; // its cosine score (already rounded by cardSearch)
}

export interface WalkEdge {
  from: string; // the seed card ref the edge starts from
  predicate: string; // re-filtered to WALK_PREDICATES here; widened to string to accept the DB enum
  to: string; // the neighbor card ref — active targets only (the I/O layer pre-filters status)
}

export interface RelatedCard {
  card_ref: string; // neighbor (never a seed; never superseded — both pre-filtered)
  via: string; // "<seedRef> <predicate>", e.g. "T-MET-001 cures"
  hop: number; // 2 (this build expands one extra hop)
  score: number; // round(seed.score * PER_HOP_DECAY) to 3 decimals (matches cardSearch's toFixed(3))
}

// Caps + decay are module-level consts (Phase 2b TRIM): the sole caller overrides nothing, so an
// overridable AssembleOpts object was speculative flexibility. The offline suite pins every value;
// promote a const back to a param only when a 2nd caller actually needs a different value.
const PER_NODE_CAP = 2; // max neighbors expanded per seed per hop
const TOTAL_CAP = 6; // max related cards overall
const PER_HOP_DECAY = 0.5; // multiply the seed score per hop

const WALK_PREDICATE_SET = new Set<string>(WALK_PREDICATES);

// Round to 3 decimals the same way cardSearch does (Number(Number(x).toFixed(3))) so a decayed
// related score is on the same scale as the direct results[].score.
function round3(n: number): number {
  return Number(Number(n).toFixed(3));
}

// Assemble the bounded one-hop neighborhood from the direct seed hits and their (pre-filtered)
// card→card edges. Deterministic and total: returns [] when no edge qualifies.
//   - filter edges to WALK_PREDICATES;
//   - skip any neighbor that is itself a seed (a neighbor is never a seed);
//   - decay: score = round(seed.score * PER_HOP_DECAY) to 3 decimals;
//   - cap PER_NODE_CAP neighbors per seed (seeds taken in descending score order);
//   - dedup across seeds by `to`, keeping the MAX decayed score;
//   - sort by score desc, then card_ref asc;
//   - truncate to TOTAL_CAP.
// The returned RelatedCard is LEAN (no type/title) — the I/O layer (cardSearch) enriches it from the
// edge fetch's to_card_id UUID join before returning it.
export function assembleNeighborhood(seeds: SeedHit[], edges: WalkEdge[]): RelatedCard[] {
  const seenSeeds = new Set(seeds.map((s) => s.card_ref));
  const qualifying = edges.filter((e) => WALK_PREDICATE_SET.has(e.predicate));
  if (qualifying.length === 0) return [];

  // Group qualifying edges by their source seed ref for the per-seed cap.
  const edgesBySeed = new Map<string, WalkEdge[]>();
  for (const e of qualifying) {
    const bucket = edgesBySeed.get(e.from);
    if (bucket) bucket.push(e);
    else edgesBySeed.set(e.from, [e]);
  }

  // dedup across seeds by `to`, keeping the highest decayed score.
  const best = new Map<string, RelatedCard>();
  const seedsByScore = [...seeds].sort((a, b) => b.score - a.score);

  for (const seed of seedsByScore) {
    const seedEdges = edgesBySeed.get(seed.card_ref) ?? [];
    const decayed = round3(seed.score * PER_HOP_DECAY);
    let perNode = 0;
    for (const e of seedEdges) {
      if (perNode >= PER_NODE_CAP) break; // PER_NODE_CAP neighbors per seed
      if (seenSeeds.has(e.to)) continue; // a neighbor is never a seed
      perNode++;
      const candidate: RelatedCard = {
        card_ref: e.to,
        via: `${seed.card_ref} ${e.predicate}`,
        hop: 2,
        score: decayed,
      };
      const existing = best.get(e.to);
      if (!existing || candidate.score > existing.score) best.set(e.to, candidate);
    }
  }

  // sort by score desc, then card_ref asc; truncate to TOTAL_CAP.
  return [...best.values()]
    .sort((a, b) => b.score - a.score || (a.card_ref < b.card_ref ? -1 : a.card_ref > b.card_ref ? 1 : 0))
    .slice(0, TOTAL_CAP);
}
