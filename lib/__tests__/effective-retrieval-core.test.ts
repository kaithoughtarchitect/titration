// Effective project+base retrieval assembly, offline ($0 / no DB / no model).
// Exercises the KnowledgeLayer rename ("tenant" -> "project") applied throughout,
// plus coverage for parseCardId (bare-or-prefixed card_get id parsing).
// Run: npx tsx lib/__tests__/effective-retrieval-core.test.ts

import { assembleEffectiveSearch, layeredId, parseCardId, type LayerInput } from "../effective-retrieval-core";

let failures = 0;
let total = 0;
function check(name: string, condition: boolean, detail = "") {
  total++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : ` - ${detail}`}`);
  if (!condition) failures++;
}

const project: LayerInput = {
  results: [
    { card_ref: "T-FND-001", type: "FINDING", title: "project", score: 0.91, edges: [] },
    { card_ref: "T-MET-001", type: "METHOD", title: "project collision", score: 0.7, edges: [] },
  ],
  related: [{ card_ref: "T-REG-001", type: "REGRESSION", title: "project related", score: 0.4, via: "T-FND-001 cures", hop: 2 }],
};
const base: LayerInput = {
  results: [
    { card_ref: "T-MET-001", type: "METHOD", title: "base collision", score: 0.95, edges: [] },
    { card_ref: "T-MET-002", type: "METHOD", title: "base second", score: 0.8, edges: [] },
  ],
  related: [{ card_ref: "T-MET-003", type: "METHOD", title: "base related", score: 0.5, via: "T-MET-001 extends", hop: 2 }],
};

const merged = assembleEffectiveSearch(project, base, 4);
// BEFORE (private): layeredId("base", "T-MET-001") !== layeredId("tenant", "T-MET-001")
check("layered id is collision-safe", layeredId("base", "T-MET-001") !== layeredId("project", "T-MET-001"));
check("both colliding refs survive", merged.results.filter((r) => r.card_ref === "T-MET-001").length === 2);
check("results rank globally by score", merged.results.map((r) => r.score).join(",") === "0.95,0.91,0.8,0.7");
// BEFORE (private): merged.results.every((r) => r.layer === "tenant" || r.layer === "base")
check("every result exposes its source layer", merged.results.every((r) => r.layer === "project" || r.layer === "base"));
// BEFORE (private): merged.layer_counts.tenant === 2 && merged.layer_counts.base === 2
check("layer counts describe pre-limit candidates", merged.layer_counts.project === 2 && merged.layer_counts.base === 2);
// BEFORE (private): merged.related?.some((r) => r.id === "tenant:T-REG-001") === true
check("related cards retain source labels", merged.related?.some((r) => r.id === "base:T-MET-003") === true && merged.related?.some((r) => r.id === "project:T-REG-001") === true);

const baseOnly = assembleEffectiveSearch(null, base, 1);
check("base-only view is supported", baseOnly.results.length === 1 && baseOnly.results[0].layer === "base");

// ── parseCardId (bare-or-prefixed card_get id parsing) ────────────────
check("a bare ref has no resolved layer", JSON.stringify(parseCardId("T-MET-001")) === JSON.stringify({ ref: "T-MET-001", layer: null }));
check("a 'project:' prefix resolves to the project layer", JSON.stringify(parseCardId("project:T-MET-001")) === JSON.stringify({ ref: "T-MET-001", layer: "project" }));
check("a 'base:' prefix resolves to the base layer", JSON.stringify(parseCardId("base:T-MET-001")) === JSON.stringify({ ref: "T-MET-001", layer: "base" }));
check("an unrecognized prefix is treated as a bare ref (colon and all)", JSON.stringify(parseCardId("tenant:T-MET-001")) === JSON.stringify({ ref: "tenant:T-MET-001", layer: null }));
check("a prefix with no remainder falls back to a bare ref", JSON.stringify(parseCardId("base:")) === JSON.stringify({ ref: "base:", layer: null }));
check("surrounding whitespace is trimmed", JSON.stringify(parseCardId("  base:T-MET-001  ")) === JSON.stringify({ ref: "T-MET-001", layer: "base" }));
check(
  "parseCardId inverts layeredId (round-trip, project)",
  JSON.stringify(parseCardId(layeredId("project", "T-MET-001"))) === JSON.stringify({ ref: "T-MET-001", layer: "project" }),
);
check(
  "parseCardId inverts layeredId (round-trip, base)",
  JSON.stringify(parseCardId(layeredId("base", "T-MET-001"))) === JSON.stringify({ ref: "T-MET-001", layer: "base" }),
);

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${total - failures}/${total}`);
process.exit(failures === 0 ? 0 : 1);
