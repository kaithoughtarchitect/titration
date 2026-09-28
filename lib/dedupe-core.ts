// Titration MCP — write-time dedup: the PURE near-duplicate decision (no I/O, no imports).
//
// When the flywheel auto-captures a verdict into the Tier-A graph, an identical/near-identical
// re-capture of an existing card should NOT create a new node — it should REINFORCE the matched
// card (the #1 graph-rot vector). This module is the discipline: given a candidate card + its
// nearest same-type active neighbors (cosine-ranked), it returns one of three decisions —
// create / reinforce / supersede-proposed — with zero side effects.
//
// Mirrors the house pure-core discipline of retrieval-metrics-core.ts / propose-core.ts EXACTLY:
//   • NO imports of store/embed/postgres/fetch — the I/O layer (store.ts cardCreate) does the
//     embedding + neighbor SELECT and hands this pure layer plain DedupeNeighbor[] rows. This module
//     is offline-unit-testable without a DB or an API key.
//   • No Date.now()/randomness/clock — pure functions only. `sample_size` text is passed IN via the
//     matched neighbor, so the reinforcement bump (bumpSampleSize) runs entirely in the pure layer.
//
// The word-overlap / single-word exact-gate algorithm here is based on a proven fuzzy-key-match
// design:
//   • computeWordOverlap  — intersection/max, containment→1.0; NOT Jaccard
//   • normalizeToWords    — lowercase, split /[_\s-]+/, drop empty
//   • single-word exact-gate + >=0.7 overlap threshold
//
// Two deliberate divergences from that reference design (LOCKED):
//   • reinforce touches ONLY sample_size/updated_at — it NEVER mutates the curated body/title/tags/
//     confidence (the curated body is the moat — a fuzzy match is not proof of semantic identity).
//   • a clear upgrade only PROPOSES supersession (advisory) — it NEVER auto-flips status or auto-creates
//     a `supersedes` edge (never auto-create high-stakes edges). And a confidence TIE → reinforce
//     (strict `>` for upgrade) — the reference design uses `>=` because it auto-writes; we PROPOSE, so
//     a tie would just generate proposal noise.

// confidence enum → ordinal rank, for the strict-greater "is this candidate a clear upgrade?" test.
// Mirrors db/001_schema.sql's `confidence` enum (low,medium,high,critical). A missing/unknown
// confidence ranks 0 (treated as the floor — never a clear upgrade over a ranked neighbor).
export const CONFIDENCE_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

// A nearest-neighbor candidate, marshalled by the I/O layer's neighbor SELECT (store.ts cardCreate).
// Caller contract: same tenant, SAME type (type = candidate.type), status='active', cosine-desc, top-N.
// `sample_size` is carried so bumpSampleSize runs entirely in the pure (unit-tested) layer.
export interface DedupeNeighbor {
  card_ref: string;
  type: string;
  title: string;
  score: number; // cosine similarity (1 - distance), from the neighbor SELECT
  confidence?: string | null;
  status?: string; // carried for caller symmetry only — the I/O layer pre-filters status='active', so this is not read here
  sample_size?: string | null; // free-form text (the cards.sample_size column, db/001_schema.sql) — e.g. 'n=186', '5 x 7 cards'
}

// The card being written. The I/O layer passes the candidate's own fields straight through.
export interface DedupeCandidate {
  type: string;
  title: string;
  body: string;
  confidence?: string | null;
  sample_size?: string | null;
}

// The three-way decision. Discriminated on `action` so the I/O layer can switch exhaustively:
//   create             → no near-dup; fall through to the normal insert (reuse the precheck embedding).
//   reinforce          → near-dup, equal-or-lower confidence; UPDATE the matched card's sample_size +
//                        updated_at, return early, NO insert. (Never mutates body/title/tags/confidence.)
//   supersede-proposed → near-dup, STRICTLY higher confidence; insert the new card AND surface a
//                        proposed_supersession advisory. NO status flip, NO `supersedes` edge.
export type DedupeDecision =
  | { action: "create" }
  | { action: "reinforce"; targetRef: string; nextSampleSize: string }
  | { action: "supersede-proposed"; targetRef: string; reason: string };

// Tunables for dedupeDecision; defaults match the reference design's constants.
export interface DedupeOpts {
  cosineNear?: number; // default 0.92 — a cosine >= this is a near-dup regardless of title overlap.
  overlapThreshold?: number; // default 0.7 — the fuzzy-match threshold, inclusive `>=`.
}

// lowercase, split on _ / whitespace / hyphen, trim, drop empties.
export function normalizeToWords(text: string): string[] {
  return (text ?? "")
    .toLowerCase()
    .split(/[_\s-]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
}

// |A ∩ B| / max(|A|,|B|), with a containment override (overlap === min length ⇒ 1.0). NOT Jaccard.
// Empty-on-both ⇒ 0.
export function computeWordOverlap(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let overlap = 0;
  for (const w of setA) if (setB.has(w)) overlap++;
  const minLen = Math.min(setA.size, setB.size);
  if (minLen > 0 && overlap === minLen) return 1.0; // containment ⇒ full match
  const maxLen = Math.max(setA.size, setB.size);
  if (maxLen === 0) return 0;
  return overlap / maxLen;
}

// Parse a leading `n=<int>` in the matched card's free-form sample_size and increment it. If no
// `n=<int>` is present, increment (or seed) a `reinforced×<k>` marker instead. NEVER throws on an
// unparseable value (sample_size is free-form text, not a clean counter).
export function bumpSampleSize(prev: string | null | undefined): string {
  const s = (prev ?? "").trim();
  const nMatch = s.match(/^n\s*=\s*(\d+)/i);
  if (nMatch) {
    const next = parseInt(nMatch[1], 10) + 1;
    return s.replace(/^n\s*=\s*\d+/i, `n=${next}`);
  }
  const rMatch = s.match(/reinforced\s*[×x]\s*(\d+)/i);
  if (rMatch) {
    const next = parseInt(rMatch[1], 10) + 1;
    return s.replace(/reinforced\s*[×x]\s*\d+/i, `reinforced×${next}`);
  }
  return s.length > 0 ? `${s} reinforced×2` : "reinforced×2";
}

// The 3-way dedup decision. `neighbors` is the caller's pre-filtered, cosine-desc, same-type,
// active, top-N list; this function ALSO skips any neighbor whose type !== candidate.type defensively
// (cross-type guard — never reinforce/propose across types, mirroring the reference design's
// category-scoped gate).
//
// A neighbor is a NEAR-DUP iff: cosine score >= cosineNear, OR title word-overlap >= overlapThreshold.
// WHERE either side's title normalizes to a single word, the overlap test requires EXACT normalized-
// title equality (no fuzzy match) — fires on EITHER side (candidate-single OR neighbor-single). This
// ADAPTS the reference design's asymmetric fuzzy-key-match gate: that design SKIPS a multi-word
// candidate vs a single-word existing key entirely, whereas here we still allow a possible EXACT
// match — a deliberate, LOCKED divergence (pinned by a dedupe-core.test.ts case, not just this comment).
//
// On the first near-dup match (neighbors are cosine-desc, so [0] is the strongest):
//   • strictly-higher candidate confidence ⇒ supersede-proposed (advisory only)
//   • else (equal or lower, incl. a tie)   ⇒ reinforce (bump sample_size)
// No near-dup ⇒ create.
export function dedupeDecision(
  candidate: DedupeCandidate,
  neighbors: DedupeNeighbor[],
  opts?: DedupeOpts,
): DedupeDecision {
  const cosineNear = opts?.cosineNear ?? 0.92;
  const overlapThreshold = opts?.overlapThreshold ?? 0.7;
  const candWords = normalizeToWords(candidate.title);

  for (const n of neighbors) {
    if (n.type !== candidate.type) continue; // cross-type guard (defensive)

    const neighWords = normalizeToWords(n.title);
    const singleWordEitherSide = candWords.length === 1 || neighWords.length === 1;

    let titleMatch: boolean;
    if (singleWordEitherSide) {
      // exact normalized-title equality only — no fuzzy overlap on single-word titles
      titleMatch =
        candWords.length === neighWords.length &&
        candWords.every((w, i) => w === neighWords[i]);
    } else {
      titleMatch = computeWordOverlap(candWords, neighWords) >= overlapThreshold;
    }

    const nearDup = n.score >= cosineNear || titleMatch;
    if (!nearDup) continue;

    const candRank = CONFIDENCE_RANK[candidate.confidence ?? ""] ?? 0;
    const matchRank = CONFIDENCE_RANK[n.confidence ?? ""] ?? 0;

    if (candRank > matchRank) {
      return {
        action: "supersede-proposed",
        targetRef: n.card_ref,
        reason: `candidate '${candidate.title}' (${candidate.confidence}) is a higher-confidence near-duplicate of '${n.title}' (${n.confidence})`,
      };
    }
    return {
      action: "reinforce",
      targetRef: n.card_ref,
      nextSampleSize: bumpSampleSize(n.sample_size),
    };
  }

  return { action: "create" };
}
