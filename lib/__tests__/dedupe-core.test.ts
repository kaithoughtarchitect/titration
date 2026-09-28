// Titration MCP — dedupe-core unit test (no network, no DB, no model).
// Pins the PURE near-duplicate decision the I/O layer (store.ts cardCreate) routes on:
//   • computeWordOverlap (containment→1.0, intersection/max, the >=0.7 boundary)
//   • the single-word exact-gate on EITHER side, INCLUDING a deliberate divergence from a naive
//     fuzzy-key match — a multi-word candidate vs a single-word neighbor (and the reverse) ⇒
//     exact-only ⇒ create. Pinned here by test, not by the source comment.
//   • cross-type ⇒ create; the 3-way decision (create / reinforce / supersede-proposed); tie⇒reinforce
//   • bumpSampleSize parse (n=5→n=6) + skip ('5 x 7 cards'→reinforced×k marker, NO throw)
// Mirrors retrieval-metrics-core.test.ts (check/total/failures + process.exit(failures===0?0:1)).
// Run: npx tsx lib/__tests__/dedupe-core.test.ts

import {
  normalizeToWords,
  computeWordOverlap,
  bumpSampleSize,
  dedupeDecision,
  CONFIDENCE_RANK,
  type DedupeCandidate,
  type DedupeNeighbor,
} from "../dedupe-core";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail = "") {
  total++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}
function throws(fn: () => unknown): string | null {
  try { fn(); return null; } catch (e: any) { return String(e?.message ?? e); }
}
function near(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}

// Below the 0.92 cosine threshold — so the TITLE gate (not the cosine gate) decides near-dup in these
// cases. Used to isolate the single-word / overlap logic from the cosine short-circuit.
const LOW = 0.5;

// ── normalizeToWords: lowercase, split on _/whitespace/hyphen, drop empties ────────
check("normalizeToWords splits hyphen/underscore/space + lowercases",
  JSON.stringify(normalizeToWords("Hair-Pulling_Intensity test")) === JSON.stringify(["hair", "pulling", "intensity", "test"]));
check("normalizeToWords drops empties from leading/trailing/doubled separators",
  JSON.stringify(normalizeToWords("  hair__pulling  ")) === JSON.stringify(["hair", "pulling"]));
check("normalizeToWords on empty string => []", normalizeToWords("").length === 0);

// ── computeWordOverlap: containment → 1.0, intersection/max, the >=0.7 boundary ────
check("computeWordOverlap containment (['hair','pulling'] ⊂ ['hair','pulling','intensity']) => 1.0",
  computeWordOverlap(["hair", "pulling"], ["hair", "pulling", "intensity"]) === 1.0);
check("computeWordOverlap reverse containment is also 1.0 (subset on the other side)",
  computeWordOverlap(["hair", "pulling", "intensity"], ["hair", "pulling"]) === 1.0);
// partial: intersection 2, max 3 => 2/3 (no side is a subset of the other)
check("computeWordOverlap partial = intersection/max (2/3)",
  near(computeWordOverlap(["hair", "pulling", "soft"], ["hair", "pulling", "intensity"]), 2 / 3));
check("computeWordOverlap no overlap => 0",
  computeWordOverlap(["alpha", "beta"], ["gamma", "delta"]) === 0);
check("computeWordOverlap both empty => 0",
  computeWordOverlap([], []) === 0);
// Boundary: build a 10-word vs 10-word pair sharing 7 words → 7/10 = 0.70 (passes >=0.7) and 6/10 = 0.60 (below).
const tenA = ["w1", "w2", "w3", "w4", "w5", "w6", "w7", "a8", "a9", "a10"];
const tenShare7 = ["w1", "w2", "w3", "w4", "w5", "w6", "w7", "b8", "b9", "b10"]; // 7 shared / max 10 = 0.70
const tenShare6 = ["w1", "w2", "w3", "w4", "w5", "w6", "c7", "c8", "c9", "c10"]; // 6 shared / max 10 = 0.60
check("computeWordOverlap boundary 0.70 (7 of 10 shared) >= 0.7 passes",
  near(computeWordOverlap(tenA, tenShare7), 0.7));
check("computeWordOverlap below boundary 0.60 (6 of 10 shared) < 0.7",
  near(computeWordOverlap(tenA, tenShare6), 0.6));

// Threshold semantics proven via dedupeDecision (the consumer): 0.70 ⇒ near-dup (reinforce), 0.60 ⇒ create.
const candBoundary: DedupeCandidate = { type: "FINDING", title: tenA.join(" "), body: "x", confidence: "medium" };
const neighShare7: DedupeNeighbor = { card_ref: "T-FND-700", type: "FINDING", title: tenShare7.join(" "), score: LOW, confidence: "medium", status: "active", sample_size: "n=3" };
const neighShare6: DedupeNeighbor = { card_ref: "T-FND-600", type: "FINDING", title: tenShare6.join(" "), score: LOW, confidence: "medium", status: "active", sample_size: "n=3" };
check("overlap >=0.7 boundary ⇒ near-dup ⇒ reinforce (title gate, cosine below threshold)",
  dedupeDecision(candBoundary, [neighShare7]).action === "reinforce");
check("overlap 0.60 (< 0.7) ⇒ NOT a near-dup ⇒ create",
  dedupeDecision(candBoundary, [neighShare6]).action === "create");

// ── single-word exact-gate (BOTH sides) + a deliberate divergence ───────────────────────
// Both single-word + identical ⇒ exact match ⇒ near-dup ⇒ reinforce (equal confidence).
const swCand: DedupeCandidate = { type: "FINDING", title: "consent", body: "x", confidence: "medium" };
const swNeighSame: DedupeNeighbor = { card_ref: "T-FND-SW1", type: "FINDING", title: "Consent", score: LOW, confidence: "medium", status: "active", sample_size: "n=2" };
check("single-word both sides, exact normalized-title equality ⇒ near-dup ⇒ reinforce",
  dedupeDecision(swCand, [swNeighSame]).action === "reinforce");
// Both single-word but DIFFERENT words ⇒ no exact match ⇒ (cosine below threshold) ⇒ create.
const swNeighDiff: DedupeNeighbor = { card_ref: "T-FND-SW2", type: "FINDING", title: "refusal", score: LOW, confidence: "medium", status: "active", sample_size: "n=2" };
check("single-word both sides, different words ⇒ no fuzzy ⇒ create",
  dedupeDecision(swCand, [swNeighDiff]).action === "create");

// DELIBERATE DIVERGENCE (pinned by THIS test):
// multi-word candidate vs single-word neighbor ⇒ exact-only ⇒ no length match ⇒ create
// (a naive fuzzy-key match would SKIP this pair; here it is gated to exact-only, which a length mismatch fails).
const mwCand: DedupeCandidate = { type: "FINDING", title: "hair pulling", body: "x", confidence: "medium" };
const swNeighHair: DedupeNeighbor = { card_ref: "T-FND-SW3", type: "FINDING", title: "hair", score: LOW, confidence: "medium", status: "active", sample_size: "n=4" };
check("multi-word candidate vs single-word neighbor ⇒ exact-only ⇒ create (overlap would be 1.0 containment but the single-word gate blocks it)",
  dedupeDecision(mwCand, [swNeighHair]).action === "create");
// The REVERSE: single-word candidate vs multi-word neighbor ⇒ exact-only ⇒ create.
const swCandHair: DedupeCandidate = { type: "FINDING", title: "hair", body: "x", confidence: "medium" };
const mwNeighHairPull: DedupeNeighbor = { card_ref: "T-FND-SW4", type: "FINDING", title: "hair pulling", score: LOW, confidence: "medium", status: "active", sample_size: "n=4" };
check("reverse: single-word candidate vs multi-word neighbor ⇒ exact-only ⇒ create",
  dedupeDecision(swCandHair, [mwNeighHairPull]).action === "create");
// Guard: the SAME multi-word/single-word pair WOULD reinforce if cosine clears the threshold (proves
// the single-word gate only blocks the TITLE path, not the cosine path — both must miss for create).
const swNeighHairHot: DedupeNeighbor = { ...swNeighHair, card_ref: "T-FND-SW3b", score: 0.95 };
check("same multi-vs-single pair but cosine 0.95 >= 0.92 ⇒ near-dup ⇒ reinforce (cosine path independent of the title gate)",
  dedupeDecision(mwCand, [swNeighHairHot]).action === "reinforce");

// ── cross-type guard ⇒ create (identical title/body, different type) ──────────────
const xtCand: DedupeCandidate = { type: "FINDING", title: "scene transition pacing", body: "identical", confidence: "high" };
const xtNeigh: DedupeNeighbor = { card_ref: "T-MET-XT", type: "METHOD", title: "scene transition pacing", score: 0.99, confidence: "high", status: "active", sample_size: "n=9" };
check("cross-type near-identical (cosine 0.99, identical title) ⇒ create (cross-type guard)",
  dedupeDecision(xtCand, [xtNeigh]).action === "create");

// ── the 3-way decision + tie⇒reinforce ────────────────────────────────────────────
// (a) no neighbor ⇒ create
check("3-way: empty neighbor list ⇒ create",
  dedupeDecision({ type: "FINDING", title: "anything", body: "x", confidence: "medium" }, []).action === "create");

// (b) near-dup, EQUAL confidence ⇒ reinforce (a tie is not a clear upgrade)
const tieCand: DedupeCandidate = { type: "FINDING", title: "hair pulling intensity", body: "x", confidence: "medium" };
const tieNeigh: DedupeNeighbor = { card_ref: "T-FND-018", type: "FINDING", title: "hair pulling", score: 0.94, confidence: "medium", status: "active", sample_size: "n=5" };
const tieDecision = dedupeDecision(tieCand, [tieNeigh]);
check("3-way: near-dup EQUAL confidence (cosine 0.94) ⇒ reinforce", tieDecision.action === "reinforce");
check("3-way: reinforce targets the matched ref T-FND-018",
  tieDecision.action === "reinforce" && tieDecision.targetRef === "T-FND-018");
check("3-way: reinforce nextSampleSize bumps n=5 ⇒ n=6 (from the matched neighbor's sample_size)",
  tieDecision.action === "reinforce" && tieDecision.nextSampleSize === "n=6");

// (c) near-dup, LOWER candidate confidence ⇒ reinforce (still not an upgrade)
const lowerCand: DedupeCandidate = { type: "FINDING", title: "hair pulling intensity", body: "x", confidence: "low" };
const higherNeigh: DedupeNeighbor = { card_ref: "T-FND-019", type: "FINDING", title: "hair pulling", score: 0.94, confidence: "high", status: "active", sample_size: "n=5" };
check("3-way: near-dup LOWER candidate confidence ⇒ reinforce (not propose)",
  dedupeDecision(lowerCand, [higherNeigh]).action === "reinforce");

// (d) near-dup, STRICTLY HIGHER candidate confidence ⇒ supersede-proposed
const upgradeCand: DedupeCandidate = { type: "FINDING", title: "hair pulling intensity", body: "x", confidence: "high" };
const lowerNeigh: DedupeNeighbor = { card_ref: "T-FND-020", type: "FINDING", title: "hair pulling", score: 0.94, confidence: "medium", status: "active", sample_size: "n=5" };
const upDecision = dedupeDecision(upgradeCand, [lowerNeigh]);
check("3-way: near-dup STRICTLY HIGHER confidence ⇒ supersede-proposed", upDecision.action === "supersede-proposed");
check("3-way: supersede-proposed targets the matched ref + carries a reason",
  upDecision.action === "supersede-proposed" && upDecision.targetRef === "T-FND-020" && upDecision.reason.length > 0);

// (e) confidence-rank ordering sanity (drives the strict-> upgrade test)
check("CONFIDENCE_RANK ordering low<medium<high<critical",
  CONFIDENCE_RANK.low < CONFIDENCE_RANK.medium &&
  CONFIDENCE_RANK.medium < CONFIDENCE_RANK.high &&
  CONFIDENCE_RANK.high < CONFIDENCE_RANK.critical);

// ── bumpSampleSize: parse n=<int> + skip unparseable (NO throw) ────────────────────
check("bumpSampleSize parses n=5 ⇒ n=6", bumpSampleSize("n=5") === "n=6");
check("bumpSampleSize parses 'n = 185' (spaces) ⇒ 'n=186'", bumpSampleSize("n = 185") === "n=186");
check("bumpSampleSize null ⇒ a reinforced×2 marker (seed)", bumpSampleSize(null) === "reinforced×2");
check("bumpSampleSize undefined ⇒ a reinforced×2 marker (seed)", bumpSampleSize(undefined) === "reinforced×2");
check("bumpSampleSize unparseable '5 x 7 cards' ⇒ appends a reinforced×2 marker, NO throw",
  throws(() => bumpSampleSize("5 x 7 cards")) === null && bumpSampleSize("5 x 7 cards") === "5 x 7 cards reinforced×2");
check("bumpSampleSize increments an existing reinforced×2 marker ⇒ reinforced×3",
  bumpSampleSize("5 x 7 cards reinforced×2") === "5 x 7 cards reinforced×3");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${total - failures}/${total}`);
process.exit(failures === 0 ? 0 : 1);
