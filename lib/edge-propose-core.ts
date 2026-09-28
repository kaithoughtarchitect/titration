// Titration MCP — graph edge-proposal sibling: the PURE edge-proposal discipline (no I/O).
//
// propose_cards proposes NODES; this proposes EDGES between EXISTING cards. Same shape as propose-core /
// harness-validate-core: SINGLE advisory callJudge (in edge-propose.ts) -> this pure validate/split
// core -> advisory return. Creates nothing. The host enforces the invariants DETERMINISTICALLY:
//   - only the finite conservative + high-stakes predicate vocabulary,
//   - targets restricted to the supplied candidate refs (no hallucinated/out-of-set refs, no self-edge),
//   - dedup vs the source's existing edges,
//   - contradicts/supersedes flagged high_stakes (PROPOSED-only, never auto-created).
// NO imports (store.ts throws at import without TITRATION_DATABASE_URL).

// Predicates this tool may propose. Provenance/inverse predicates (observed_in / documented_in /
// superseded_by) are excluded — they are not conceptual relationships to discover here.
const CONSERVATIVE = ["supports", "complements", "extends", "cures", "instance_of"] as const;
const HIGH_STAKES_PREDICATES = new Set<string>(["contradicts", "supersedes"]);
const PROPOSABLE_PREDICATES = new Set<string>([...CONSERVATIVE, ...HIGH_STAKES_PREDICATES]);

export interface ProposedEdge {
  predicate: string;
  to: string; // a candidate card ref (T-XXX-NNN) — always one of the supplied candidates
  high_stakes: boolean; // contradicts/supersedes -> the agent must confirm before card_relate
  rationale: string;
}

export interface EdgeProposal {
  advisory: true;
  from: string; // the source card ref
  proposals: ProposedEdge[];
  summary: string;
  note: string;
}

const EDGE_NOTE =
  "ADVISORY — no edges were created. Review each; card_relate the ones you confirm. Edges marked high_stakes (contradicts / supersedes) must not be created without your explicit confirmation.";

export const EDGE_PROPOSE_SYSTEM = `You are the edge-proposal brain of the Titration knowledge graph. Given a SOURCE card and a set of CANDIDATE existing cards, propose typed relationship edges FROM the source TO candidates — only edges that are TRUE and defensible from the cards' content. You create nothing; you DRAFT for a human to confirm.

HARD RULES:
- Propose edges ONLY to the listed candidate card refs. NEVER invent a ref. NEVER propose a self-edge.
- Do NOT propose an edge that already exists (the source's existing edges are listed for you).
- Use ONLY these predicates: supports, complements, extends, cures, instance_of (conservative); contradicts, supersedes (HIGH-STAKES — assert only with strong evidence; a wrong one is worse than a missing one). Do NOT use observed_in / documented_in / superseded_by (provenance/inverse — not your job).

DIAGNOSE: each proposed edge must be defensible from the two cards' content. Prefer FEWER correct edges over many speculative ones. When nothing is clearly warranted, return an empty proposals array.

OUTPUT — JSON ONLY, no prose, no fences:
{
  "summary": "<1-2 sentences>",
  "proposals": [
    { "predicate": "supports|complements|extends|cures|instance_of|contradicts|supersedes", "to": "<candidate ref>", "rationale": "<why, from the content>" }
  ]
}`;

export function buildEdgeProposeUserPrompt(source: string, candidates: string, existingEdges: string): string {
  return [
    "SOURCE CARD (propose edges FROM this card):\n" + String(source ?? "").trim(),
    "\nCANDIDATE CARDS (propose edges only TO these refs):\n" + (String(candidates ?? "").trim() || "(none)"),
    "\nSOURCE'S EXISTING EDGES (do NOT propose any of these again):\n" + (String(existingEdges ?? "").trim() || "(none)"),
    "\nPropose the defensible edges. Return the JSON only.",
  ].join("\n");
}

export interface AssembleEdgeOpts {
  fromRef: string;
  candidateRefs: string[]; // the only legal targets
  existingEdges: string[]; // "predicate -> target" form, from edgesFor
}

export function assembleEdgeProposal(raw: any, opts: AssembleEdgeOpts): EdgeProposal {
  if (!raw || typeof raw !== "object") throw new Error("edge_propose response is not a JSON object");
  if (!("proposals" in raw)) throw new Error("edge_propose response has no proposals field");
  const rawProposals = Array.isArray(raw.proposals) ? raw.proposals : [];

  const candidateSet = new Set(opts.candidateRefs);
  const existingSet = new Set(opts.existingEdges.map((e) => e.replace(/\s/g, "").toLowerCase())); // "predicate->target"
  const seen = new Set<string>();
  const proposals: ProposedEdge[] = [];

  for (const e of rawProposals) {
    if (!e || typeof e !== "object") continue;
    const predicate = String((e as any).predicate ?? "").trim().toLowerCase();
    const to = String((e as any).to ?? "").trim();
    if (!PROPOSABLE_PREDICATES.has(predicate)) continue; // invalid / non-proposable predicate
    if (!candidateSet.has(to)) continue; // not a supplied candidate (no hallucinated refs)
    if (to === opts.fromRef) continue; // no self-edge
    const key = `${predicate}->${to}`.toLowerCase();
    if (existingSet.has(key)) continue; // already exists
    if (seen.has(key)) continue; // de-dup within the proposal set
    seen.add(key);
    proposals.push({ predicate, to, high_stakes: HIGH_STAKES_PREDICATES.has(predicate), rationale: String((e as any).rationale ?? "").trim() });
  }

  const summary =
    String(raw.summary ?? "").trim() ||
    (proposals.length ? `${proposals.length} edge${proposals.length === 1 ? "" : "s"} proposed from ${opts.fromRef}.` : `No defensible new edges from ${opts.fromRef}.`);

  return { advisory: true, from: opts.fromRef, proposals, summary, note: EDGE_NOTE };
}
