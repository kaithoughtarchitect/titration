// Titration MCP — judges roster: curated family table + roster/pick validation +
// Player-family resolution (PURE, import-clean, offline-tested).
//
// Owns the curated vendor-family table for every caller
// (parseSelectedPanelLock in judge.ts, the TITRATION_JUDGES / TITRATION_HELPER_MODEL
// resolvers below) — replacing catalogFamilyForId / isRefereeCatalogCandidateId,
// which stay exactly as they are in referee-catalog-core.ts because the referee-panel-
// ticket(-core) picker plumbing (a DIFFERENT task) still depends on them unchanged.
// The 10-family table itself is NOT re-authored here — REFEREE_CATALOG_FAMILIES is the
// single source of truth; this module re-exports it under roster-facing names so every
// NEW caller reads "the roster's family table" without a second, drift-prone list.
//
// NO imports beyond other PURE cores (referee-catalog-core.ts, itself import-free).
// NO clock or RNG, NO fs, NO network — the roster JSON and CLI-availability probing
// are the caller's job (lib/judges-roster.ts).

import {
  REFEREE_CATALOG_FAMILIES,
  isRefereeCatalogFamily,
  REFEREE_REASONING_EFFORTS,
  isRefereeReasoningEffort,
  type RefereeCatalogFamily,
  type RefereeReasoningEffort,
} from "./referee-catalog-core";

export const CURATED_FAMILIES = REFEREE_CATALOG_FAMILIES;
export type CuratedFamily = RefereeCatalogFamily;
export const isCuratedFamily = isRefereeCatalogFamily;

export const JUDGE_REASONING_EFFORTS = REFEREE_REASONING_EFFORTS;
export type JudgeReasoningEffort = RefereeReasoningEffort;
export const isJudgeReasoningEffort = isRefereeReasoningEffort;

// The four legal judge doors (widened from OpenRouter-only). Defined locally
// (not imported from judge.ts / judge-doors-core.ts) so this module has no path
// back into the I/O-carrying judge layer — judge.ts imports FROM this module, never
// the reverse.
export const ROSTER_DOORS = ["openrouter", "claude", "codex", "grok"] as const;
export type RosterDoor = (typeof ROSTER_DOORS)[number];
const ROSTER_DOOR_SET: ReadonlySet<string> = new Set(ROSTER_DOORS);
export function isRosterDoor(value: unknown): value is RosterDoor {
  return typeof value === "string" && ROSTER_DOOR_SET.has(value);
}
export function isCliRosterDoor(door: RosterDoor): door is "claude" | "codex" | "grok" {
  return door === "claude" || door === "codex" || door === "grok";
}

export const ROSTER_COST_CLASSES = ["subscription", "metered"] as const;
export type RosterCostClass = (typeof ROSTER_COST_CLASSES)[number];
const ROSTER_COST_CLASS_SET: ReadonlySet<string> = new Set(ROSTER_COST_CLASSES);
export function isRosterCostClass(value: unknown): value is RosterCostClass {
  return typeof value === "string" && ROSTER_COST_CLASS_SET.has(value);
}

export interface RosterJudgeRow {
  readonly id: string;
  readonly name: string;
  readonly family: CuratedFamily;
  readonly door: RosterDoor;
  readonly model: string;
  readonly efforts: readonly JudgeReasoningEffort[];
  readonly cost_class: RosterCostClass;
  readonly recommended: boolean;
  readonly verified: boolean;
  readonly note?: string;
}

export interface Roster {
  readonly version: number;
  readonly families: readonly CuratedFamily[];
  readonly judges: readonly RosterJudgeRow[];
}

// Shape-compatible with judge.ts's JudgeSpec ({ id, family, door, model, effort? })
// without importing judge.ts (judge.ts imports FROM here, not the reverse — judge.ts
// spawns CLI processes / calls fetch, this module never does).
export interface JudgeSpecLike {
  readonly id: string;
  readonly family: string;
  readonly door: RosterDoor;
  readonly model: string;
  readonly effort?: JudgeReasoningEffort;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// ── validateRoster ────────────────────────────────────────────────────────────

export function validateRoster(raw: unknown): Roster {
  if (!isPlainObject(raw)) {
    throw new Error("judges roster must be an object");
  }
  if (typeof raw.version !== "number" || !Number.isFinite(raw.version)) {
    throw new Error("judges roster.version must be a number");
  }
  if (!Array.isArray(raw.families) || raw.families.length === 0) {
    throw new Error("judges roster.families must be a non-empty array");
  }
  for (const family of raw.families) {
    if (!isCuratedFamily(family)) {
      throw new Error(`judges roster.families contains a non-curated family '${String(family)}'`);
    }
  }
  if (!Array.isArray(raw.judges) || raw.judges.length === 0) {
    throw new Error("judges roster.judges must be a non-empty array");
  }

  const seenIds = new Set<string>();
  const judges: RosterJudgeRow[] = raw.judges.map((row, index) => {
    if (!isPlainObject(row)) {
      throw new Error(`judges roster.judges[${index}] must be an object`);
    }
    const { id, name, family, door, model, efforts, cost_class, recommended, verified, note } = row;
    if (!isNonEmptyString(id)) {
      throw new Error(`judges roster.judges[${index}].id must be a non-empty string`);
    }
    if (seenIds.has(id)) {
      throw new Error(`judges roster.judges contains a duplicate id '${id}'`);
    }
    seenIds.add(id);
    if (!isNonEmptyString(name)) {
      throw new Error(`judges roster row '${id}'.name must be a non-empty string`);
    }
    if (!isCuratedFamily(family)) {
      throw new Error(`judges roster row '${id}'.family must be a curated vendor family`);
    }
    if (!isRosterDoor(door)) {
      throw new Error(`judges roster row '${id}'.door must be one of ${ROSTER_DOORS.join("/")}`);
    }
    if (!isNonEmptyString(model)) {
      throw new Error(`judges roster row '${id}'.model must be a non-empty string`);
    }
    if (!Array.isArray(efforts) || efforts.length === 0 || !efforts.every(isJudgeReasoningEffort)) {
      throw new Error(`judges roster row '${id}'.efforts must be a non-empty array of low/medium/high`);
    }
    if (!isRosterCostClass(cost_class)) {
      throw new Error(`judges roster row '${id}'.cost_class must be subscription or metered`);
    }
    if (typeof recommended !== "boolean") {
      throw new Error(`judges roster row '${id}'.recommended must be a boolean`);
    }
    if (typeof verified !== "boolean") {
      throw new Error(`judges roster row '${id}'.verified must be a boolean`);
    }
    if (note !== undefined && typeof note !== "string") {
      throw new Error(`judges roster row '${id}'.note must be a string when present`);
    }
    return {
      id,
      name,
      family,
      door,
      model,
      efforts: [...(efforts as JudgeReasoningEffort[])],
      cost_class,
      recommended,
      verified,
      ...(typeof note === "string" ? { note } : {}),
    };
  });

  return {
    version: raw.version,
    families: [...(raw.families as CuratedFamily[])],
    judges,
  };
}

// ── rowToJudgeSpec ────────────────────────────────────────────────────────────

// A stored selected-panel-lock (judge.ts's widened parseSelectedPanelLock) requires
// a concrete low/medium/high effort per judge, never null — so a roster-resolved
// pick (which names no PER-CALL effort of its own; TITRATION_JUDGES is an id list,
// not an id+effort list) always gets ONE assigned here: "high" when the row allows
// it (every seeded row does), else its first declared effort. Deterministic, never
// invents an effort the row does not declare.
export function defaultEffortForRow(row: RosterJudgeRow): JudgeReasoningEffort {
  return row.efforts.includes("high") ? "high" : row.efforts[0]!;
}

export function rowToJudgeSpec(row: RosterJudgeRow): JudgeSpecLike {
  return { id: row.id, family: row.family, door: row.door, model: row.model, effort: defaultEffortForRow(row) };
}

// ── validatePick (TITRATION_JUDGES comma-list, and any future picker confirm) ──

export type PickRefusalCode =
  | "count"
  | "duplicate_id"
  | "unknown_id"
  | "not_verified"
  | "player_family"
  | "duplicate_family"
  | "illegal_effort";

export type PickValidation =
  | { ok: true; panel: JudgeSpecLike[] }
  | { ok: false; code: PickRefusalCode; message: string };

export interface ValidatePickOptions {
  playerFamily?: string | null;
}

const REQUIRED_PANEL_SIZE = 3;

export function validatePick(
  roster: Roster,
  pickIds: readonly string[],
  opts: ValidatePickOptions = {},
): PickValidation {
  if (!Array.isArray(pickIds) || pickIds.length !== REQUIRED_PANEL_SIZE) {
    return {
      ok: false,
      code: "count",
      message: `select exactly ${REQUIRED_PANEL_SIZE} judges (got ${Array.isArray(pickIds) ? pickIds.length : "a non-array"})`,
    };
  }
  if (new Set(pickIds).size !== pickIds.length) {
    return { ok: false, code: "duplicate_id", message: `duplicate judge id in the pick [${pickIds.join(", ")}]` };
  }

  const byId = new Map(roster.judges.map((row) => [row.id, row] as const));
  const rows: RosterJudgeRow[] = [];
  for (const id of pickIds) {
    const row = byId.get(id);
    if (!row) {
      return { ok: false, code: "unknown_id", message: `'${id}' is not a judges-roster.json id` };
    }
    if (!row.verified) {
      return {
        ok: false,
        code: "not_verified",
        message: `'${id}' (${row.name}) is not verified — an unverified door is never selectable`,
      };
    }
    if (opts.playerFamily && row.family === opts.playerFamily) {
      return {
        ok: false,
        code: "player_family",
        message: `'${id}' is family '${row.family}', the Player's own vendor family — it may not sit on the panel`,
      };
    }
    if (row.efforts.length === 0) {
      return { ok: false, code: "illegal_effort", message: `'${id}' declares no legal reasoning effort` };
    }
    rows.push(row);
  }

  const families = new Set(rows.map((row) => row.family));
  if (families.size !== REQUIRED_PANEL_SIZE) {
    return {
      ok: false,
      code: "duplicate_family",
      message: `panel must span ${REQUIRED_PANEL_SIZE} distinct families (got [${rows.map((row) => row.family).join(", ")}])`,
    };
  }

  return { ok: true, panel: rows.map(rowToJudgeSpec) };
}

// ── resolvePlayerFamily ──
//
// Resolves a --player id against a roster: exact id/cliModel/slug/vendor match
// first, then a per-vendor keyword substring scan. There is no roster-membership
// lookup (a Player is not a referee-roster row — it is an arbitrary external
// agent id such as "claude-opus-5-5"); the keyword scan is remapped onto the
// curated family ids this file owns.
const FAMILY_KEYWORDS: Readonly<Record<CuratedFamily, readonly string[]>> = {
  anthropic: ["claude", "anthropic"],
  openai: ["gpt", "openai", "o1", "o3", "o4", "chatgpt", "codex"],
  moonshotai: ["kimi", "moonshot"],
  qwen: ["qwen", "alibaba"],
  meta: ["llama", "meta", "muse-spark", "muse spark"],
  google: ["gemini", "google", "palm", "bard"],
  deepseek: ["deepseek"],
  "z-ai": ["glm", "z-ai", "zhipu"],
  "x-ai": ["grok", "xai", "x-ai"],
  minimax: ["minimax"],
};

export function resolvePlayerFamily(playerModel: string, playerFamily?: string | null): CuratedFamily | null {
  if (typeof playerFamily === "string" && playerFamily.trim()) {
    const normalized = playerFamily.trim().toLowerCase();
    return isCuratedFamily(normalized) ? normalized : null;
  }
  const lower = String(playerModel ?? "").trim().toLowerCase();
  if (!lower) return null;
  for (const family of CURATED_FAMILIES) {
    for (const keyword of FAMILY_KEYWORDS[family]) {
      if (lower.includes(keyword)) return family;
    }
  }
  return null;
}

// An unresolvable player_model without an explicit player_family is a TYPED
// REFUSAL — never "no exclusion". Throws with a message naming both inputs so
// the caller can fix either.
export function resolvePlayerFamilyOrThrow(playerModel: string, playerFamily?: string | null): CuratedFamily {
  const resolved = resolvePlayerFamily(playerModel, playerFamily);
  if (!resolved) {
    throw new Error(
      `player_model '${playerModel}'${playerFamily ? ` (player_family '${playerFamily}')` : ""} does not resolve to a ` +
      `known vendor family. Pass an explicit player_family naming one of the curated families ` +
      `[${CURATED_FAMILIES.join(", ")}].`,
    );
  }
  return resolved;
}

// The Player's own vendor family may never sit on the judge panel, checked
// at establish_baseline and again on every verify / goal_titrate / goal_titrate_step
// against the baseline's locked panel. Takes the ALREADY-RESOLVED family (callers
// resolve once via resolvePlayerFamilyOrThrow) so this stays a single, simple check.
export function assertFamilyNotOnPanel(
  resolvedPlayerFamily: string,
  panelFamilies: readonly string[],
  context: { playerModel: string; playerFamily?: string | null },
): void {
  if (panelFamilies.includes(resolvedPlayerFamily)) {
    throw new Error(
      `Player family '${resolvedPlayerFamily}' (resolved from player_model '${context.playerModel}'` +
      `${context.playerFamily ? ` / player_family '${context.playerFamily}'` : ""}) sits on the judge panel ` +
      `(panel families: [${panelFamilies.join(", ")}]) — the Player's own vendor family may never grade its own work. ` +
      `Establish a new baseline with a panel that excludes '${resolvedPlayerFamily}', or run with a different Player.`,
    );
  }
}

// ── resolveAutoPanel (TITRATION_JUDGES=auto) ───────────────────────────────────

export interface CliAvailability {
  readonly claude: boolean;
  readonly codex: boolean;
  readonly grok: boolean;
}

export interface AutoPanelOptions {
  readonly available: CliAvailability;
  readonly hasOpenRouterKey: boolean;
  readonly playerFamily?: string | null;
  /** Further families to keep off the panel, e.g. the vendor of the model being tested. */
  readonly excludeFamilies?: readonly string[] | null;
}

export type AutoPanelResolution =
  | { ok: true; panel: JudgeSpecLike[] }
  | { ok: false; reason: string };

// Deterministic resolver: installed subscription CLI doors first, OpenRouter
// only when OPENROUTER_API_KEY is set, the Player's family excluded, only
// verified:true rows, fill to 3 distinct families or refuse (never seat the Player's
// family, never seat fewer than 3 distinct families).
export function resolveAutoPanel(roster: Roster, opts: AutoPanelOptions): AutoPanelResolution {
  const playerFamily = opts.playerFamily ?? null;
  const excluded = new Set(opts.excludeFamilies ?? []);
  const eligible = roster.judges.filter((row) => row.verified && row.family !== playerFamily && !excluded.has(row.family));

  const subscriptionEligible = eligible.filter(
    (row) => row.cost_class === "subscription" && isCliRosterDoor(row.door) && opts.available[row.door],
  );
  const meteredEligible = opts.hasOpenRouterKey ? eligible.filter((row) => row.cost_class === "metered") : [];

  const picked: RosterJudgeRow[] = [];
  const usedFamilies = new Set<string>();
  for (const row of subscriptionEligible) {
    if (picked.length === REQUIRED_PANEL_SIZE) break;
    if (usedFamilies.has(row.family)) continue;
    picked.push(row);
    usedFamilies.add(row.family);
  }
  for (const row of meteredEligible) {
    if (picked.length === REQUIRED_PANEL_SIZE) break;
    if (usedFamilies.has(row.family)) continue;
    picked.push(row);
    usedFamilies.add(row.family);
  }

  if (picked.length < REQUIRED_PANEL_SIZE) {
    const installedDoors = (["claude", "codex", "grok"] as const).filter((door) => opts.available[door]);
    return {
      ok: false,
      reason:
        `only resolved ${picked.length} of ${REQUIRED_PANEL_SIZE} distinct verified vendor families ` +
        `(families so far: [${[...usedFamilies].join(", ") || "none"}]; installed subscription doors: ` +
        `[${installedDoors.join(", ") || "none"}]; OPENROUTER_API_KEY ${opts.hasOpenRouterKey ? "set" : "unset"}` +
        `${playerFamily ? `; Player family '${playerFamily}' excluded` : ""}). ` +
        `Install another verified subscription CLI, set OPENROUTER_API_KEY, or mint a panel with referee_panel_mint.`,
    };
  }

  return { ok: true, panel: picked.map(rowToJudgeSpec) };
}

// ── resolveHelperRow (helper single-model calls) ────────────────────────────

export interface HelperResolveOptions {
  readonly available: CliAvailability;
  readonly hasOpenRouterKey: boolean;
}

export type HelperResolution =
  | { ok: true; row: RosterJudgeRow }
  | { ok: false; reason: string };

// propose_cards / edge_propose / harness_design / harness_validate: a single
// advisory model call, not the referee panel — no ≥2-family rule, no Player
// exclusion. TITRATION_HELPER_MODEL (an explicit roster id) is resolved by the
// caller before falling back to this; this picks the first available verified
// door, subscription first, in roster file order.
export function resolveHelperRow(roster: Roster, opts: HelperResolveOptions): HelperResolution {
  const verified = roster.judges.filter((row) => row.verified);
  const subscription = verified.find((row) => isCliRosterDoor(row.door) && opts.available[row.door]);
  if (subscription) return { ok: true, row: subscription };
  if (opts.hasOpenRouterKey) {
    const metered = verified.find((row) => row.cost_class === "metered");
    if (metered) return { ok: true, row: metered };
  }
  return {
    ok: false,
    reason: "no verified subscription CLI is installed and OPENROUTER_API_KEY is unset (or no verified metered row exists)",
  };
}
