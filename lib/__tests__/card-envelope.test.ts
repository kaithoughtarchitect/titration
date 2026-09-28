// Titration MCP — the public card_search / card_get envelope, frozen.
//
// Offline ($0 / no DB / no model): exercises the PURE assembler
// (assembleEffectiveSearch, lib/effective-retrieval-core.ts) directly with fixture
// LayerInput rows, so this pins the exact shape lib/effective-retrieval.ts's
// effectiveCardSearch returns as `{ ...assembled }` without needing a DB or an
// embedding call. The frozen contract:
//   results[] { id, layer, card_ref, type, title, score, edges }
//   related[]? { id, layer, card_ref, type, title, score, via, hop }   (present only with hops)
//   layer_counts { project, base }
// A schema drift here (a renamed/added/removed key) fails a `check`, not just a
// TypeScript compile — the whole point of a FROZEN envelope test.
// Run: npx tsx lib/__tests__/card-envelope.test.ts

import { assembleEffectiveSearch, type LayerInput } from "../effective-retrieval-core";

let failures = 0;
let total = 0;
function check(name: string, condition: boolean, detail = "") {
  total++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : ` - ${detail}`}`);
  if (!condition) failures++;
}

const HIT_KEYS = ["card_ref", "type", "title", "score", "edges", "id", "layer"].sort();
const RELATED_KEYS = ["card_ref", "type", "title", "score", "via", "hop", "id", "layer"].sort();

function keysOf(obj: object): string[] {
  return Object.keys(obj).sort();
}

const project: LayerInput = {
  results: [{ card_ref: "T-FND-001", type: "FINDING", title: "project finding", score: 0.9, edges: ["cures -> T-REG-002"] }],
};
const base: LayerInput = {
  results: [{ card_ref: "T-MET-001", type: "METHOD", title: "base method", score: 0.6, edges: [] }],
};

// ── no `related` requested (hops absent/1): the envelope carries no `related` key at all ──
const noHops = assembleEffectiveSearch(project, base, 5);
check("no-hops envelope top-level keys are exactly {results, layer_counts}", JSON.stringify(keysOf(noHops)) === JSON.stringify(["layer_counts", "results"]));
check("no-hops envelope has no `related` key (not merely empty)", !("related" in noHops));
check("every result hit exposes exactly the frozen key set", noHops.results.every((r) => JSON.stringify(keysOf(r)) === JSON.stringify(HIT_KEYS)));
check("id is the layered `${layer}:${card_ref}` identity", noHops.results.every((r) => r.id === `${r.layer}:${r.card_ref}`));
check("every layer is 'project' or 'base'", noHops.results.every((r) => r.layer === "project" || r.layer === "base"));
check("layer_counts is exactly {project, base}", JSON.stringify(keysOf(noHops.layer_counts)) === JSON.stringify(["base", "project"]));
check("layer_counts values are the pre-limit per-layer candidate counts", noHops.layer_counts.project === 1 && noHops.layer_counts.base === 1);

// ── `related` requested (hops:2): the envelope ADDITIVELY carries `related[]` ──────────
const projectWithRelated: LayerInput = {
  ...project,
  related: [{ card_ref: "T-REG-002", type: "REGRESSION", title: "project related", score: 0.5, via: "T-FND-001 cures", hop: 2 }],
};
const baseWithRelated: LayerInput = { ...base, related: [] };
const withHops = assembleEffectiveSearch(projectWithRelated, baseWithRelated, 5);
check("hops envelope top-level keys are exactly {results, related, layer_counts}", JSON.stringify(keysOf(withHops)) === JSON.stringify(["layer_counts", "related", "results"]));
check("related is present (array) even when the base layer contributed none", Array.isArray(withHops.related));
check(
  "every related card exposes exactly the frozen key set",
  (withHops.related ?? []).every((r) => JSON.stringify(keysOf(r)) === JSON.stringify(RELATED_KEYS)),
);
check("related id is the layered `${layer}:${card_ref}` identity", (withHops.related ?? []).every((r) => r.id === `${r.layer}:${r.card_ref}`));

// ── base-only caller (project === "__base__" upstream): no project layer at all ───────
const baseOnly = assembleEffectiveSearch(null, base, 5);
check("base-only envelope has no project-layer hits", baseOnly.results.every((r) => r.layer === "base"));
check("base-only layer_counts.project is 0", baseOnly.layer_counts.project === 0);
check("base-only envelope keys are still the frozen shape", JSON.stringify(keysOf(baseOnly)) === JSON.stringify(["layer_counts", "results"]));

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${total - failures}/${total}`);
process.exit(failures === 0 ? 0 : 1);
