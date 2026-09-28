// Titration MCP — judges roster I/O: load + validate judges-roster.json, CLI
// availability via cli-resolve, and the TITRATION_JUDGES / TITRATION_HELPER_MODEL
// resolvers that need that I/O. Pure decision logic lives in
// judges-roster-core.ts; this module is the thin, injectable I/O layer around it
// (mirrors lib/X.ts <-> lib/X-core.ts everywhere else in this codebase).
//
// Every I/O call here is injectable (a `ports` argument, defaulting to the real
// filesystem / cli-resolve / env read) so the offline suites can exercise the full
// dispatch (unset / comma-list / "auto") deterministically, without touching disk,
// PATH, or OPENROUTER_API_KEY.

import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCliDoor } from "./cli-resolve";
import {
  validateRoster,
  validatePick,
  resolveAutoPanel,
  resolveHelperRow,
  rowToJudgeSpec,
  type CliAvailability,
  type JudgeSpecLike,
  type Roster,
} from "./judges-roster-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROSTER_PATH = join(HERE, "..", "judges-roster.json");

function rosterPath(): string {
  const override = process.env.TITRATION_JUDGES_ROSTER;
  if (!override || !override.trim()) return DEFAULT_ROSTER_PATH;
  return isAbsolute(override) ? override : join(process.cwd(), override);
}

export async function loadRoster(): Promise<Roster> {
  const path = rosterPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    throw new Error(
      `judges roster file unreadable at '${path}' (set TITRATION_JUDGES_ROSTER to override): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`judges roster file at '${path}' is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  return validateRoster(parsed); // throws a descriptive Error on a malformed roster
}

export async function detectCliAvailability(
  resolveDoor: typeof resolveCliDoor = resolveCliDoor,
): Promise<CliAvailability> {
  const [claude, codex, grok] = await Promise.all([
    resolveDoor("claude"),
    resolveDoor("codex"),
    resolveDoor("grok"),
  ]);
  return { claude: claude !== null, codex: codex !== null, grok: grok !== null };
}

export function hasOpenRouterKey(): boolean {
  return typeof process.env.OPENROUTER_API_KEY === "string" && process.env.OPENROUTER_API_KEY.trim().length > 0;
}

export interface ResolveEnvJudgePanelInput {
  readonly judgesEnv: string | undefined;
  readonly playerFamily?: string | null;
}

export interface ResolveEnvJudgePanelPorts {
  readonly loadRoster?: () => Promise<Roster>;
  readonly detectCliAvailability?: () => Promise<CliAvailability>;
  readonly hasOpenRouterKey?: () => boolean;
}

// The TITRATION_JUDGES contract: unset -> a panel must come from a picker
// receipt (mint one with referee_panel_mint); an unset env here with no receipt is
// ALWAYS a typed refusal naming it.
// A comma-separated list of roster ids -> validatePick (same rules the picker
// confirm uses). "auto" -> resolveAutoPanel (installed subscription CLIs first,
// OpenRouter only with a key, the Player family excluded, verified rows only).
export async function resolveEnvJudgePanel(
  input: ResolveEnvJudgePanelInput,
  ports: ResolveEnvJudgePanelPorts = {},
): Promise<JudgeSpecLike[]> {
  const value = (input.judgesEnv ?? "").trim();
  if (!value) {
    throw new Error(
      "no judge panel is available: TITRATION_JUDGES is unset and no panel_receipt_id was supplied. " +
      "Mint a panel with referee_panel_mint and confirm it in the picker, or set TITRATION_JUDGES to a " +
      "comma-separated list of judges-roster.json ids, or to 'auto'.",
    );
  }
  const load = ports.loadRoster ?? loadRoster;
  const roster = await load();

  if (value === "auto") {
    const detect = ports.detectCliAvailability ?? (() => detectCliAvailability());
    const available = await detect();
    const keyed = ports.hasOpenRouterKey ?? hasOpenRouterKey;
    const resolved = resolveAutoPanel(roster, {
      available,
      hasOpenRouterKey: keyed(),
      playerFamily: input.playerFamily ?? null,
    });
    if (!resolved.ok) {
      throw new Error(`TITRATION_JUDGES=auto could not resolve a panel: ${resolved.reason}`);
    }
    return resolved.panel;
  }

  const ids = value.split(",").map((s) => s.trim()).filter(Boolean);
  const picked = validatePick(roster, ids, { playerFamily: input.playerFamily ?? null });
  if (!picked.ok) {
    throw new Error(`TITRATION_JUDGES='${value}' is not a valid panel: ${picked.message}`);
  }
  return picked.panel;
}

export interface ResolveHelperSpecInput {
  readonly helperModelId?: string | null;
}

export interface ResolveHelperSpecPorts {
  readonly loadRoster?: () => Promise<Roster>;
  readonly detectCliAvailability?: () => Promise<CliAvailability>;
  readonly hasOpenRouterKey?: () => boolean;
}

// Helper contract: TITRATION_HELPER_MODEL (a roster id, explicit arg wins over
// the env var) else the first available verified door (subscription CLIs first);
// none available -> a typed refusal. Never the ≥2-family verdict rule — this
// is a single advisory model call.
export async function resolveHelperJudgeSpec(
  input: ResolveHelperSpecInput = {},
  ports: ResolveHelperSpecPorts = {},
): Promise<JudgeSpecLike> {
  const load = ports.loadRoster ?? loadRoster;
  const roster = await load();
  const explicit = (input.helperModelId ?? process.env.TITRATION_HELPER_MODEL ?? "").trim();
  if (explicit) {
    const row = roster.judges.find((j) => j.id === explicit);
    if (!row) {
      throw new Error(`TITRATION_HELPER_MODEL '${explicit}' is not a known judges-roster.json id`);
    }
    if (!row.verified) {
      throw new Error(`TITRATION_HELPER_MODEL '${explicit}' (${row.name}) is not verified — an unverified door is never selectable`);
    }
    return rowToJudgeSpec(row);
  }
  const detect = ports.detectCliAvailability ?? (() => detectCliAvailability());
  const available = await detect();
  const keyed = ports.hasOpenRouterKey ?? hasOpenRouterKey;
  const resolved = resolveHelperRow(roster, { available, hasOpenRouterKey: keyed() });
  if (!resolved.ok) {
    throw new Error(
      `no helper model is available: ${resolved.reason}. Set TITRATION_HELPER_MODEL to a judges-roster.json id, ` +
      "install a verified subscription CLI (claude/codex/grok), or set OPENROUTER_API_KEY.",
    );
  }
  return rowToJudgeSpec(resolved.row);
}
