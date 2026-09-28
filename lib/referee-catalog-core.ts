// Titration MCP — referee-panel picker catalog (PURE, import-free, offline-tested).
//
// Source-controlled membership is the commissioned OpenRouter slugs. Selectable
// cards are the admitted subset only (proven by the U1/U2 fixtures). An empty
// admitted catalog is a valid ship. Family is a curated field keyed by
// id — never the slug prefix (openai/deepseek/minimax each ship multiple slugs).
//
// NO imports ON PURPOSE. NO clock or RNG. NO fs — admission rows are an
// argument. The legacy engine panel is not this catalog.

export const REFEREE_PANEL_SIZE = 3 as const;
export const REFEREE_TICKET_TTL_SECONDS = 720 as const;

export const REFEREE_CATALOG_FAMILIES = [
  "anthropic",
  "openai",
  "moonshotai",
  "qwen",
  "meta",
  "google",
  "deepseek",
  "z-ai",
  "x-ai",
  "minimax",
] as const;
export type RefereeCatalogFamily = (typeof REFEREE_CATALOG_FAMILIES)[number];

export const REFEREE_REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type RefereeReasoningEffort = (typeof REFEREE_REASONING_EFFORTS)[number];

// Commission order matches admission.json / openrouter-fixture-admission.test.ts.
//
// APPEND-ONLY: never remove an id from this list and never change an id's family
// in REFEREE_CATALOG_FAMILY_BY_ID. parseSelectedPanelLock validates every stored
// lock against these tables, so a removed or re-familied id makes each baseline
// locked to it permanently unloadable (loadBaseline throws → verify and
// goal_titrate on that baseline are dead). Retire a model by setting its
// admission status (admission.json) — membership here is history, not offer.
export const REFEREE_CATALOG_CANDIDATE_IDS = [
  "anthropic/claude-opus-5",
  "openai/gpt-5.6-sol",
  "moonshotai/kimi-k3",
  "qwen/qwen3.8-max",
  "meta/muse-spark-1.2",
  "google/gemini-3.7-flash",
  "deepseek/deepseek-v4-pro-0813",
  "z-ai/glm-5.3",
  "deepseek/deepseek-v4-flash-0731",
  "x-ai/grok-4.6",
  "minimax/minimax-m3",
  "minimax/minimax-m2.7-20260318:nitro",
  "openai/gpt-oss-120b:nitro",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-luna",
  "google/gemini-3.8-flash",
  "z-ai/glm-5.3-flash",
  "meta/muse-spark-1.3",
  "qwen/qwen3.8-max-0902",
  "openai/gpt-6-sol",
  "openai/gpt-6-luna",
  "deepseek/deepseek-v4.1-flash",
  "x-ai/grok-4.7",
] as const;
export type RefereeCatalogCandidateId = (typeof REFEREE_CATALOG_CANDIDATE_IDS)[number];

// APPEND-ONLY (see REFEREE_CATALOG_CANDIDATE_IDS): changing a family here
// invalidates every stored lock that froze the old family.
export const REFEREE_CATALOG_FAMILY_BY_ID: {
  readonly [K in RefereeCatalogCandidateId]: RefereeCatalogFamily;
} = {
  "anthropic/claude-opus-5": "anthropic",
  "openai/gpt-5.6-sol": "openai",
  "moonshotai/kimi-k3": "moonshotai",
  "qwen/qwen3.8-max": "qwen",
  "meta/muse-spark-1.2": "meta",
  "google/gemini-3.7-flash": "google",
  "deepseek/deepseek-v4-pro-0813": "deepseek",
  "z-ai/glm-5.3": "z-ai",
  "deepseek/deepseek-v4-flash-0731": "deepseek",
  "x-ai/grok-4.6": "x-ai",
  "minimax/minimax-m3": "minimax",
  "minimax/minimax-m2.7-20260318:nitro": "minimax",
  "openai/gpt-oss-120b:nitro": "openai",
  "openai/gpt-5.6-terra": "openai",
  "openai/gpt-5.6-luna": "openai",
  "google/gemini-3.8-flash": "google",
  "z-ai/glm-5.3-flash": "z-ai",
  "meta/muse-spark-1.3": "meta",
  "qwen/qwen3.8-max-0902": "qwen",
  "openai/gpt-6-sol": "openai",
  "openai/gpt-6-luna": "openai",
  "deepseek/deepseek-v4.1-flash": "deepseek",
  "x-ai/grok-4.7": "x-ai",
};

const CANDIDATE_ID_SET: ReadonlySet<string> = new Set(REFEREE_CATALOG_CANDIDATE_IDS);
const FAMILY_SET: ReadonlySet<string> = new Set(REFEREE_CATALOG_FAMILIES);
const EFFORT_SET: ReadonlySet<string> = new Set(REFEREE_REASONING_EFFORTS);

export interface RefereeCatalogEntry {
  id: RefereeCatalogCandidateId;
  family: RefereeCatalogFamily;
  allowed_efforts: readonly RefereeReasoningEffort[];
}

// Domain selectable card. agentic_index is a published number, or null when
// OpenRouter has not published Agentic Index (unpublished is allowed).
export interface RefereeSelectableCard {
  id: RefereeCatalogCandidateId;
  family: RefereeCatalogFamily;
  allowed_efforts: readonly RefereeReasoningEffort[];
  agentic_index: number | null;
}

export interface RefereePanelPick {
  id: RefereeCatalogCandidateId;
  effort: RefereeReasoningEffort;
}

export interface ValidatedRefereePick {
  id: RefereeCatalogCandidateId;
  family: RefereeCatalogFamily;
  effort: RefereeReasoningEffort;
}

export type RefereePanelTriple = readonly [
  ValidatedRefereePick,
  ValidatedRefereePick,
  ValidatedRefereePick,
];

export type RefereePanelRefusalCode =
  | "count"
  | "duplicate_family"
  | "unknown_id"
  | "not_admitted"
  | "illegal_effort"
  | "pasted_slug";

export type RefereePanelValidation =
  | { ok: true; picks: RefereePanelTriple }
  | { ok: false; code: RefereePanelRefusalCode };

// Membership of the 15. allowed_efforts stays empty until a U1 proof fills it.
export const REFEREE_CATALOG_ENTRIES: readonly RefereeCatalogEntry[] =
  REFEREE_CATALOG_CANDIDATE_IDS.map((id) => ({
    id,
    family: REFEREE_CATALOG_FAMILY_BY_ID[id],
    allowed_efforts: [],
  }));

export function isRefereeCatalogCandidateId(id: unknown): id is RefereeCatalogCandidateId {
  return typeof id === "string" && CANDIDATE_ID_SET.has(id);
}

export function isRefereeCatalogFamily(family: unknown): family is RefereeCatalogFamily {
  return typeof family === "string" && FAMILY_SET.has(family);
}

export function isRefereeReasoningEffort(effort: unknown): effort is RefereeReasoningEffort {
  return typeof effort === "string" && EFFORT_SET.has(effort);
}

export function isNumericAgenticIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// Confirm-snapshot parse seam: corrupt jsonb must not become null on the domain card.
export function requireNumericAgenticIndex(value: unknown): number {
  if (!isNumericAgenticIndex(value)) {
    throw new Error("selectable card requires numeric agentic_index");
  }
  return value;
}

export function catalogFamilyForId(id: RefereeCatalogCandidateId): RefereeCatalogFamily {
  return REFEREE_CATALOG_FAMILY_BY_ID[id];
}

// A bare-slug family derivation for the SINGLE-model helper callers (propose_cards,
// edge_propose, harness_validate, harness_design) — these are advisory single-judge
// calls, not the referee panel, and their model override is a free OpenRouter slug,
// not necessarily a REFEREE_CATALOG_CANDIDATE_IDS member. Returns the curated family
// when the slug's vendor prefix is itself one of REFEREE_CATALOG_FAMILIES (true for
// every family today — a family name IS its own slug prefix), else the raw prefix
// verbatim. Never invents a family and never falls back to "unknown".
export function familyForOpenRouterSlug(slug: string): string {
  const prefix = String(slug ?? "").split("/")[0] ?? "";
  return isRefereeCatalogFamily(prefix) ? prefix : prefix;
}

export function catalogEntryForId(id: RefereeCatalogCandidateId): RefereeCatalogEntry {
  return {
    id,
    family: REFEREE_CATALOG_FAMILY_BY_ID[id],
    allowed_efforts: [],
  };
}

export function admittedCatalogEntries(
  rows: readonly { id?: unknown; status?: unknown }[],
): RefereeCatalogEntry[] {
  const admittedIds = new Set<string>();
  for (const row of rows) {
    if (row.status === "admitted" && typeof row.id === "string") {
      admittedIds.add(row.id);
    }
  }
  return REFEREE_CATALOG_ENTRIES.filter((entry) => admittedIds.has(entry.id)).map((entry) => ({
    id: entry.id,
    family: entry.family,
    allowed_efforts: [...entry.allowed_efforts],
  }));
}

export type SelectableCardResult =
  | { ok: true; card: RefereeSelectableCard }
  | { ok: false };

export function toSelectableCard(
  entry: RefereeCatalogEntry,
  agenticIndex: unknown,
): SelectableCardResult {
  if (!isRefereeCatalogCandidateId(entry.id)) return { ok: false };
  const index = agenticIndex === null || agenticIndex === undefined
    ? null
    : isNumericAgenticIndex(agenticIndex)
      ? agenticIndex
      : false;
  if (index === false) return { ok: false };
  return {
    ok: true,
    card: {
      id: entry.id,
      family: REFEREE_CATALOG_FAMILY_BY_ID[entry.id],
      allowed_efforts: entry.allowed_efforts,
      agentic_index: index,
    },
  };
}

export function filterSelectableCards(
  cards: readonly {
    id: unknown;
    family?: unknown;
    allowed_efforts?: unknown;
    agentic_index: unknown;
  }[],
): RefereeSelectableCard[] {
  const out: RefereeSelectableCard[] = [];
  for (const card of cards) {
    if (!isRefereeCatalogCandidateId(card.id)) continue;
    const index = card.agentic_index === null || card.agentic_index === undefined
      ? null
      : isNumericAgenticIndex(card.agentic_index)
        ? card.agentic_index
        : false;
    if (index === false) continue;
    const efforts = Array.isArray(card.allowed_efforts)
      ? card.allowed_efforts.filter(isRefereeReasoningEffort)
      : [];
    out.push({
      id: card.id,
      family: REFEREE_CATALOG_FAMILY_BY_ID[card.id],
      allowed_efforts: efforts,
      agentic_index: index,
    });
  }
  return out;
}

function pickField(pick: unknown, key: "id" | "effort"): unknown {
  if (pick === null || typeof pick !== "object" || Array.isArray(pick)) return undefined;
  return (pick as { [k: string]: unknown })[key];
}

export function validatePanelPicks(
  picks: unknown,
  admitted: readonly RefereeCatalogEntry[],
): RefereePanelValidation {
  if (!Array.isArray(picks) || picks.length !== REFEREE_PANEL_SIZE) {
    return { ok: false, code: "count" };
  }

  const admittedById = new Map<string, RefereeCatalogEntry>();
  for (const entry of admitted) {
    if (!isRefereeCatalogCandidateId(entry.id)) continue;
    admittedById.set(entry.id, entry);
  }

  const resolved: ValidatedRefereePick[] = [];
  for (const pick of picks) {
    const id = pickField(pick, "id");
    const effort = pickField(pick, "effort");
    if (typeof id !== "string" || id.length === 0) {
      return { ok: false, code: "unknown_id" };
    }
    if (!isRefereeCatalogCandidateId(id)) {
      return { ok: false, code: "pasted_slug" };
    }
    const entry = admittedById.get(id);
    if (!entry) {
      return { ok: false, code: "not_admitted" };
    }
    const family = REFEREE_CATALOG_FAMILY_BY_ID[id];
    // Family uniqueness reads the curated field, never the slug prefix. A
    // mismatched field is not a valid admitted entry.
    if (entry.family !== family) {
      return { ok: false, code: "not_admitted" };
    }
    if (!isRefereeReasoningEffort(effort) || !entry.allowed_efforts.includes(effort)) {
      return { ok: false, code: "illegal_effort" };
    }
    resolved.push({
      id,
      family,
      effort,
    });
  }

  const families = new Set(resolved.map((pick) => pick.family));
  if (families.size !== REFEREE_PANEL_SIZE) {
    return { ok: false, code: "duplicate_family" };
  }

  return {
    ok: true,
    picks: [resolved[0]!, resolved[1]!, resolved[2]!],
  };
}
