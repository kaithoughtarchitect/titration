// Titration MCP — neighborhood-core unit test (no network, no DB, no model).
// Pins the PURE bounded multi-hop walk the I/O layer (store.ts cardSearch, hops===2) feeds:
//   • empty / no-qualifying edges ⇒ [] (the core is total — never throws)
//   • predicate filter — a `supports`/`observed_in` edge is ignored, a `cures` edge is kept
//   • a `to` that is also a seed is skipped (a neighbor is never a seed)
//   • PER_NODE_CAP truncates per seed; TOTAL_CAP truncates overall
//   • decay — score === round(seedScore × 0.5) to 3 decimals (matches cardSearch's toFixed(3))
//   • dedup — same neighbor via two seeds keeps the higher decayed score
//   • deterministic ordering (score desc, then card_ref asc)
//   • WALK_PREDICATES consistency with the high-value set (Phase 3b follow-up 2 — runtime assertion)
// Mirrors dedupe-core.test.ts (check/total/failures + process.exit(failures===0?0:1)).
// Run: npx tsx lib/__tests__/neighborhood-core.test.ts

import {
  assembleNeighborhood,
  WALK_PREDICATES,
  type SeedHit,
  type WalkEdge,
} from "../neighborhood-core";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail = "") {
  total++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}
function round3(n: number): number {
  return Number(Number(n).toFixed(3));
}

// ── WALK_PREDICATES consistency (Phase 3b follow-up 2) ──────────────────────────────
// The walk vocabulary is exactly the high-value conceptual subset, forward-only — and every member
// is a real predicate in store.ts's PREDICATES source of truth (asserted here, not derived at compile).
const STORE_PREDICATES = new Set([
  "supersedes", "superseded_by", "supports", "contradicts", "complements",
  "extends", "instance_of", "observed_in", "documented_in", "cures",
]);
check("WALK_PREDICATES is exactly [cures, supersedes, contradicts, extends]",
  JSON.stringify([...WALK_PREDICATES]) === JSON.stringify(["cures", "supersedes", "contradicts", "extends"]));
check("every WALK_PREDICATE is a member of store.ts PREDICATES (vocabulary source of truth)",
  WALK_PREDICATES.every((p) => STORE_PREDICATES.has(p)));
const PROVENANCE_INVERSE = new Set<string>(["observed_in", "documented_in", "superseded_by"]);
check("WALK_PREDICATES excludes provenance/inverse predicates (observed_in/documented_in/superseded_by)",
  !WALK_PREDICATES.some((p) => PROVENANCE_INVERSE.has(p)));

// ── (a) empty edges ⇒ [] ────────────────────────────────────────────────────────────
check("(a) empty edges ⇒ []",
  assembleNeighborhood([{ card_ref: "T-MET-001", score: 0.9 }], []).length === 0);
check("(a) empty seeds AND empty edges ⇒ []",
  assembleNeighborhood([], []).length === 0);

// ── (b) predicate filter — non-walk predicates ignored, a walk predicate kept ─────────
const oneSeed: SeedHit[] = [{ card_ref: "T-MET-001", score: 0.8 }];
const mixedEdges: WalkEdge[] = [
  { from: "T-MET-001", predicate: "supports", to: "T-FND-100" }, // ignored (not a walk predicate)
  { from: "T-MET-001", predicate: "observed_in", to: "RUN-1" }, // ignored (provenance)
  { from: "T-MET-001", predicate: "cures", to: "T-FND-200" }, // KEPT
];
const filtered = assembleNeighborhood(oneSeed, mixedEdges);
check("(b) only the `cures` edge survives the predicate filter (supports/observed_in dropped)",
  filtered.length === 1 && filtered[0].card_ref === "T-FND-200" && filtered[0].via === "T-MET-001 cures");
check("(b) edges with ONLY non-walk predicates ⇒ [] (no qualifying edge)",
  assembleNeighborhood(oneSeed, [
    { from: "T-MET-001", predicate: "supports", to: "T-FND-100" },
    { from: "T-MET-001", predicate: "complements", to: "T-FND-101" },
  ]).length === 0);

// ── (c) a `to` that is also a seed is skipped ────────────────────────────────────────
const twoSeeds: SeedHit[] = [
  { card_ref: "T-MET-001", score: 0.9 },
  { card_ref: "T-FND-300", score: 0.7 },
];
const seedTargetEdges: WalkEdge[] = [
  { from: "T-MET-001", predicate: "cures", to: "T-FND-300" }, // T-FND-300 is itself a seed ⇒ skipped
  { from: "T-MET-001", predicate: "extends", to: "T-MET-050" }, // a genuine neighbor ⇒ kept
];
const skipSeed = assembleNeighborhood(twoSeeds, seedTargetEdges);
check("(c) a neighbor that is also a seed (T-FND-300) is skipped",
  !skipSeed.some((r) => r.card_ref === "T-FND-300"));
check("(c) the genuine neighbor (T-MET-050) is kept",
  skipSeed.length === 1 && skipSeed[0].card_ref === "T-MET-050");

// ── (d) PER_NODE_CAP truncates per seed (oversupply >2 neighbors to one seed) ─────────
const oversuppliedNode: WalkEdge[] = [
  { from: "T-MET-001", predicate: "cures", to: "T-FND-001" },
  { from: "T-MET-001", predicate: "cures", to: "T-FND-002" },
  { from: "T-MET-001", predicate: "cures", to: "T-FND-003" },
  { from: "T-MET-001", predicate: "cures", to: "T-FND-004" },
];
const capped = assembleNeighborhood([{ card_ref: "T-MET-001", score: 0.8 }], oversuppliedNode);
check("(d) PER_NODE_CAP — a single seed with 4 neighbors yields ≤2",
  capped.length === 2);

// ── (e) TOTAL_CAP truncates overall (oversupply >6 across seeds) ──────────────────────
const manySeeds: SeedHit[] = Array.from({ length: 5 }, (_, i) => ({
  card_ref: `T-MET-${String(i + 1).padStart(3, "0")}`,
  score: 0.9 - i * 0.05,
}));
// 2 distinct neighbors per seed × 5 seeds = 10 candidate neighbors, all unique ⇒ should cap at 6.
const manyEdges: WalkEdge[] = manySeeds.flatMap((s, i) => [
  { from: s.card_ref, predicate: "cures", to: `T-FND-${String(i * 2 + 1).padStart(3, "0")}` },
  { from: s.card_ref, predicate: "extends", to: `T-FND-${String(i * 2 + 2).padStart(3, "0")}` },
]);
const totalCapped = assembleNeighborhood(manySeeds, manyEdges);
check("(e) TOTAL_CAP — 10 unique candidate neighbors truncate to ≤6",
  totalCapped.length === 6);

// ── (f) decay — score === round(seedScore × 0.5) to 3 decimals ───────────────────────
const decaySeed: SeedHit[] = [{ card_ref: "T-MET-001", score: 0.823 }];
const decayEdge: WalkEdge[] = [{ from: "T-MET-001", predicate: "cures", to: "T-FND-999" }];
const decayed = assembleNeighborhood(decaySeed, decayEdge);
check("(f) decay — score === round(0.823 × 0.5) to 3dp (0.412, half-even toFixed)",
  decayed.length === 1 && decayed[0].score === round3(0.823 * 0.5));
check("(f) decay — hop is 2 and via carries the seed ref + predicate",
  decayed.length === 1 && decayed[0].hop === 2 && decayed[0].via === "T-MET-001 cures");

// ── (g) dedup — same neighbor via two seeds keeps the higher decayed score ────────────
const dedupSeeds: SeedHit[] = [
  { card_ref: "T-MET-001", score: 0.9 }, // higher ⇒ decayed 0.45
  { card_ref: "T-MET-002", score: 0.6 }, // lower  ⇒ decayed 0.30
];
const dedupEdges: WalkEdge[] = [
  { from: "T-MET-001", predicate: "cures", to: "T-FND-777" }, // same neighbor
  { from: "T-MET-002", predicate: "extends", to: "T-FND-777" }, // same neighbor, lower score
];
const deduped = assembleNeighborhood(dedupSeeds, dedupEdges);
check("(g) dedup — same neighbor via two seeds appears ONCE",
  deduped.filter((r) => r.card_ref === "T-FND-777").length === 1);
check("(g) dedup — the kept entry carries the HIGHER decayed score (0.45 from T-MET-001)",
  deduped.length === 1 && deduped[0].score === round3(0.9 * 0.5) && deduped[0].via === "T-MET-001 cures");

// ── (g2) dedup TIE — equal decayed scores keep the FIRST-PROCESSED seed (`>` not `>=`) ─
// Two seeds with EQUAL scores both reach the same neighbor. seedsByScore is a stable sort, so the
// seed that appears first in the input is processed first and claims the neighbor; the second seed's
// equal-score candidate must NOT replace it (the keep-max uses `>`, not `>=`). Pins the deterministic
// `via` on an exact score tie — a `>` → `>=` mutation would flip it to "T-MET-002 cures".
const tieSeeds: SeedHit[] = [
  { card_ref: "T-MET-001", score: 0.8 }, // first in input ⇒ processed first
  { card_ref: "T-MET-002", score: 0.8 }, // EQUAL score
];
const tieEdges: WalkEdge[] = [
  { from: "T-MET-001", predicate: "extends", to: "T-FND-555" },
  { from: "T-MET-002", predicate: "cures", to: "T-FND-555" }, // same neighbor, equal decayed score
];
const tied = assembleNeighborhood(tieSeeds, tieEdges);
check("(g2) dedup tie — on EQUAL decayed scores the first-processed seed wins (`>` not `>=`): via stays T-MET-001",
  tied.length === 1 && tied[0].card_ref === "T-FND-555" && tied[0].via === "T-MET-001 extends");

// ── (h) deterministic ordering — score desc, then card_ref asc ────────────────────────
const orderSeeds: SeedHit[] = [
  { card_ref: "S-HIGH", score: 0.8 }, // decayed 0.4
  { card_ref: "S-LOW", score: 0.4 }, // decayed 0.2
];
const orderEdges: WalkEdge[] = [
  { from: "S-LOW", predicate: "cures", to: "T-FND-B" }, // 0.2
  { from: "S-HIGH", predicate: "cures", to: "T-FND-Z" }, // 0.4
  { from: "S-HIGH", predicate: "extends", to: "T-FND-A" }, // 0.4 — ties T-FND-Z, ref breaks tie
];
const ordered = assembleNeighborhood(orderSeeds, orderEdges);
check("(h) ordering — primary sort is score desc (0.4 entries before the 0.2 entry)",
  ordered.length === 3 && ordered[2].card_ref === "T-FND-B" && ordered[2].score < ordered[0].score);
check("(h) ordering — tie on score broken by card_ref asc (T-FND-A before T-FND-Z)",
  ordered[0].card_ref === "T-FND-A" && ordered[1].card_ref === "T-FND-Z");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${total - failures}/${total}`);
process.exit(failures === 0 ? 0 : 1);
