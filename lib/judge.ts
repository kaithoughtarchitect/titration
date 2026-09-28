// Titration MCP — judge layer: cross-vendor judge calls + panel.
//
// The verdict engine's judges. Three vendor families, none sharing the Claude
// agent's family: Grok 4.3 (xAI, OpenRouter)
// + GPT-5.5 high-reasoning (OpenAI, OpenRouter) + DeepSeek V4 Pro (DeepSeek,
// OpenRouter) — all three over the OpenRouter API for a uniform, headless-safe
// panel. (A codex-CLI path for GPT — $0 marginal on a ChatGPT subscription —
// still exists below as an opt-in transport, just not the default.) The
// engine is self-contained TS (fetch + child_process), so it has no python3/bash
// dependency and "never leaves the server."

import { callDoor } from "./judge-doors";
import type { JudgeDoor as CliJudgeDoor } from "./judge-doors-core";
import { resolveOpenRouterApiKey } from "./provider-key";
import { ProviderCredentialError } from "./provider-key-core";
import { REFEREE_PANEL_SIZE, isRefereeReasoningEffort } from "./referee-catalog-core";
// The widened selected-panel-lock validates every family against the roster-core
// curated family table (re-exported from referee-catalog-core, itself unchanged —
// the referee-panel-ticket(-core) picker plumbing still depends on
// catalogFamilyForId / isRefereeCatalogCandidateId exactly as they are) instead of
// requiring catalog-id membership. A lock's `id`/`model` are now any non-empty
// string and `door` is any of the four legal doors, never just "openrouter".
import { isCuratedFamily } from "./judges-roster-core";
import { PUBLIC_REPO_URL } from "./public-repo-url";

const OR_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_TOKENS = 4000; // headroom for reasoning + JSON (matches goal-titrate-judge.sh)
const OPENROUTER_TIMEOUT_MS = 180_000;
// Single-model helper calls (harness_design, harness_validate, propose_cards,
// edge_propose) write a whole document, not a one-line verdict. A subscription CLI
// at high effort can take well over the judge timeout to do that, so they get more.
export const HELPER_TIMEOUT_MS = 600_000;

export interface CallJudgeOptions { timeoutMs?: number; }

export type JudgeDoor = "openrouter" | "codex" | "claude" | "grok";
export type ReasoningEffort = "low" | "medium" | "high";
export interface JudgeSpec { id: string; family: string; door: JudgeDoor; model: string; effort?: ReasoningEffort; }

// A frozen, JSON-safe description of the exact referee configuration used for
// a grade. Judge ids alone are not sufficient provenance because their backing
// models can change over time.
export interface JudgeSnapshot {
  id: string;
  family: string;
  door: JudgeDoor;
  model: string;
  effort: ReasoningEffort | null;
}

export const JUDGE_PANEL_TRACE_SOURCES = [
  "recorded-at-grade",
  "reconstructed-from-engine-config",
  "selected-panel-lock",
] as const;
export type JudgePanelTraceSource = (typeof JUDGE_PANEL_TRACE_SOURCES)[number];

// id/family are any non-empty string / curated family — no longer
// restricted to the OpenRouter picker catalog's fixed 19 slugs (a roster row's id
// can be a CLI door id like "claude" or any admitted OpenRouter slug).
export interface SelectedPanelDisplay {
  id: string;
  family: string;
  effort: ReasoningEffort;
}

export interface SelectedPanelSelection {
  // The real ticket receipt id, or the literal "env" for a lock built from
  // TITRATION_JUDGES (comma-list or "auto") rather than a picker confirm.
  receipt_id: string;
  confirmed_at: string;
  // The Player's resolved vendor family at lock time, or null
  // when the establishing call supplied no player_model. Stored so a later reader
  // (a display surface, an audit) never needs to re-resolve player_model itself —
  // the exclusion check re-runs fresh on every verify / goal_titrate call regardless.
  player_family: string | null;
  display: SelectedPanelDisplay[];
}

export interface SelectedPanelLock {
  source: "selected-panel-lock";
  resolved: [JudgeSnapshot, JudgeSnapshot, JudgeSnapshot];
  ran: string[];
  failed: { id: string; error: string; count?: number }[];
  selection: SelectedPanelSelection;
}

export interface JudgePanelTrace {
  source: JudgePanelTraceSource;
  resolved: JudgeSnapshot[];
  ran: string[];
  failed: { id: string; error: string; count?: number }[];
  selection?: SelectedPanelSelection;
}

export function snapshotJudge(judge: JudgeSpec): JudgeSnapshot {
  return {
    id: judge.id,
    family: judge.family,
    door: judge.door,
    model: judge.model,
    effort: judge.effort ?? null,
  };
}

export function snapshotPanel(panel: JudgeSpec[]): JudgeSnapshot[] {
  return panel.map(snapshotJudge);
}

// Default 3-vendor panel (goal-titrate-judge-model-spec §1.3) — all OpenRouter API.
// Overridable via TITRATION_JUDGES="grok,deepseek" (subset by id). The codex
// transport still exists (callCodex) for an opt-in GPT-via-subscription path, but
// the default GPT judge is OpenRouter (headless-safe, no CLI/login dependency).
// `family` values are curated catalog families (REFEREE_CATALOG_FAMILIES) — grok
// is x-ai, gpt is openai, deepseek is deepseek.
export const DEFAULT_PANEL: JudgeSpec[] = [
  { id: "grok", family: "x-ai", door: "openrouter", model: "x-ai/grok-4.3" },
  { id: "gpt", family: "openai", door: "openrouter", model: "openai/gpt-5.5", effort: "high" },
  { id: "deepseek", family: "deepseek", door: "openrouter", model: "deepseek/deepseek-v4-pro" },
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isJudgePanelTraceSource(value: unknown): value is JudgePanelTraceSource {
  return typeof value === "string"
    && (JUDGE_PANEL_TRACE_SOURCES as readonly string[]).includes(value);
}

function parsePanelFailed(value: unknown): JudgePanelTrace["failed"] {
  if (!Array.isArray(value)) {
    throw new Error("judge_panel.failed must be an array");
  }
  const failed: JudgePanelTrace["failed"] = [];
  for (const item of value) {
    if (!isPlainObject(item) || typeof item.id !== "string" || typeof item.error !== "string") {
      throw new Error("judge_panel.failed items must have id and error strings");
    }
    const row: { id: string; error: string; count?: number } = { id: item.id, error: item.error };
    if (item.count !== undefined) {
      if (typeof item.count !== "number") {
        throw new Error("judge_panel.failed count must be a number");
      }
      row.count = item.count;
    }
    failed.push(row);
  }
  return failed;
}

function parsePanelRan(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("judge_panel.ran must be an array");
  }
  return value.map((id, index) => {
    if (typeof id !== "string") {
      throw new Error(`judge_panel.ran[${index}] must be a string`);
    }
    return id;
  });
}

// The four legal judge doors on a stored lock (widened from openrouter-only).
const JUDGE_DOORS: readonly JudgeDoor[] = ["openrouter", "codex", "claude", "grok"];
function isJudgeDoor(value: unknown): value is JudgeDoor {
  return typeof value === "string" && (JUDGE_DOORS as readonly string[]).includes(value);
}

function parseLockedDisplay(value: unknown, index: number): SelectedPanelDisplay {
  if (!isPlainObject(value)) {
    throw new Error(`selected-panel-lock selection.display[${index}] must be an object`);
  }
  if (typeof value.id !== "string" || value.id.trim().length === 0) {
    throw new Error(`selected-panel-lock selection.display[${index}].id must be a non-empty string`);
  }
  if (!isCuratedFamily(value.family)) {
    throw new Error(`selected-panel-lock selection.display[${index}].family must be a curated vendor family`);
  }
  if (!isRefereeReasoningEffort(value.effort)) {
    throw new Error(`selected-panel-lock selection.display[${index}].effort must be low, medium, or high`);
  }
  return { id: value.id, family: value.family, effort: value.effort };
}

// null/undefined -> null (no player_model was supplied to the establishing call);
// otherwise must be a curated family — a corrupt/garbage stored value is refused,
// never silently treated as "no exclusion" (the same discipline applies to what gets
// written, not only what gets read).
function parsePlayerFamily(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !isCuratedFamily(value)) {
    throw new Error("selected-panel-lock selection.player_family must be a curated vendor family or null");
  }
  return value;
}

function parseSelectedPanelSelection(value: unknown): SelectedPanelSelection {
  if (!isPlainObject(value)) {
    throw new Error("selected-panel-lock requires selection");
  }
  if (typeof value.receipt_id !== "string" || value.receipt_id.length === 0) {
    throw new Error("selected-panel-lock selection.receipt_id is required");
  }
  if (typeof value.confirmed_at !== "string" || value.confirmed_at.length === 0) {
    throw new Error("selected-panel-lock selection.confirmed_at is required");
  }
  const player_family = parsePlayerFamily(value.player_family);
  if (!Array.isArray(value.display) || value.display.length !== REFEREE_PANEL_SIZE) {
    throw new Error("selected-panel-lock selection.display must have 3 picks");
  }
  const display = value.display.map((item, index) => parseLockedDisplay(item, index));
  const ids = display.map((item) => item.id);
  if (new Set(ids).size !== REFEREE_PANEL_SIZE) {
    throw new Error("selected-panel-lock selection.display ids must be unique");
  }
  const families = new Set(display.map((item) => item.family));
  if (families.size !== REFEREE_PANEL_SIZE) {
    throw new Error("selected-panel-lock requires 3 distinct catalog families");
  }
  return {
    receipt_id: value.receipt_id,
    confirmed_at: value.confirmed_at,
    player_family,
    display,
  };
}

function parseLockedSnapshot(value: unknown, index: number): JudgeSnapshot {
  if (!isPlainObject(value)) {
    throw new Error(`selected-panel-lock resolved[${index}] must be an object`);
  }
  if (typeof value.id !== "string" || value.id.trim().length === 0) {
    throw new Error(`selected-panel-lock resolved[${index}].id must be a non-empty string`);
  }
  if (!isCuratedFamily(value.family)) {
    throw new Error(`selected-panel-lock resolved[${index}].family must be a curated vendor family`);
  }
  if (!isJudgeDoor(value.door)) {
    throw new Error(`selected-panel-lock resolved[${index}].door must be one of ${JUDGE_DOORS.join("/")}`);
  }
  if (typeof value.model !== "string" || value.model.trim().length === 0) {
    throw new Error(`selected-panel-lock resolved[${index}].model must be a non-empty string`);
  }
  if (!isRefereeReasoningEffort(value.effort)) {
    throw new Error(`selected-panel-lock resolved[${index}].effort must be low, medium, or high`);
  }
  return {
    id: value.id,
    family: value.family,
    door: value.door,
    model: value.model,
    effort: value.effort,
  };
}

// Narrow structural guard. Callers that must honor a lock use parseSelectedPanelLock,
// which throws; they must not fall through to DEFAULT_PANEL.
export function isSelectedPanelLock(panel: unknown): panel is SelectedPanelLock {
  if (!isPlainObject(panel)) return false;
  if (panel.source !== "selected-panel-lock") return false;
  if (!isPlainObject(panel.selection)) return false;
  if (!Array.isArray(panel.resolved) || panel.resolved.length !== REFEREE_PANEL_SIZE) return false;
  const families = new Set<string>();
  for (const snap of panel.resolved) {
    if (!isPlainObject(snap) || !isCuratedFamily(snap.family)) return false;
    families.add(snap.family);
  }
  return families.size === REFEREE_PANEL_SIZE;
}

// Throws when source is selected-panel-lock and selection / 3-family / resolved are invalid.
// Never substitutes DEFAULT_PANEL. Family uniqueness is checked against the curated
// family table (judges-roster-core's isCuratedFamily); id/model/door are widened.
export function parseSelectedPanelLock(panel: unknown): SelectedPanelLock {
  if (!isPlainObject(panel)) {
    throw new Error("selected-panel-lock requires an object");
  }
  if (panel.source !== "selected-panel-lock") {
    throw new Error("selected-panel-lock requires source selected-panel-lock");
  }
  const selection = parseSelectedPanelSelection(panel.selection);
  if (!Array.isArray(panel.resolved) || panel.resolved.length !== REFEREE_PANEL_SIZE) {
    throw new Error("selected-panel-lock requires exactly 3 resolved judges");
  }
  const snapshots = panel.resolved.map((item, index) => parseLockedSnapshot(item, index));
  const families = new Set(snapshots.map((snap) => snap.family));
  if (families.size !== REFEREE_PANEL_SIZE) {
    throw new Error("selected-panel-lock requires 3 distinct catalog families");
  }
  const resolvedIds = new Set(snapshots.map((snap) => snap.id));
  if (resolvedIds.size !== REFEREE_PANEL_SIZE) {
    throw new Error("selected-panel-lock resolved ids must be unique");
  }
  const displayById = new Map<string, SelectedPanelDisplay>(
    selection.display.map((item) => [item.id, item]),
  );
  for (const snap of snapshots) {
    const pick = displayById.get(snap.id);
    if (!pick) {
      throw new Error("selected-panel-lock resolved ids must match selection display picks");
    }
    if (snap.family !== pick.family || snap.effort !== pick.effort) {
      throw new Error("selected-panel-lock resolved identity must match the confirmed pick");
    }
  }
  for (const id of displayById.keys()) {
    if (!resolvedIds.has(id)) {
      throw new Error("selected-panel-lock resolved ids must match selection display picks");
    }
  }
  const resolved: [JudgeSnapshot, JudgeSnapshot, JudgeSnapshot] = [
    snapshots[0]!,
    snapshots[1]!,
    snapshots[2]!,
  ];
  return {
    source: "selected-panel-lock",
    resolved,
    ran: parsePanelRan(panel.ran),
    failed: parsePanelFailed(panel.failed),
    selection,
  };
}

// Legacy (non-lock) snapshots earn their type too: every writer (snapshotJudge,
// the db/022 backfill) emits id/family/door/model strings with effort low|medium|
// high|null, so a row that fails this parse is corrupt, not merely old.
function parseTraceSnapshot(value: unknown, index: number): JudgeSnapshot {
  if (!isPlainObject(value)) {
    throw new Error(`judge_panel.resolved[${index}] must be an object`);
  }
  if (typeof value.id !== "string" || typeof value.family !== "string" || typeof value.model !== "string") {
    throw new Error(`judge_panel.resolved[${index}] must have id, family, and model strings`);
  }
  if (value.door !== "openrouter" && value.door !== "codex") {
    throw new Error(`judge_panel.resolved[${index}].door must be openrouter or codex`);
  }
  const effort = value.effort === undefined || value.effort === null ? null : value.effort;
  if (effort !== null && !isRefereeReasoningEffort(effort)) {
    throw new Error(`judge_panel.resolved[${index}].effort must be low, medium, high, or null`);
  }
  return { id: value.id, family: value.family, door: value.door, model: value.model, effort };
}

export function parseJudgePanelTrace(value: unknown): JudgePanelTrace {
  if (!isPlainObject(value)) {
    throw new Error("judge_panel must be an object");
  }
  if (!isJudgePanelTraceSource(value.source)) {
    throw new Error(
      "judge_panel.source must be recorded-at-grade, reconstructed-from-engine-config, or selected-panel-lock",
    );
  }
  if (value.source === "selected-panel-lock") {
    return parseSelectedPanelLock(value);
  }
  if (!Array.isArray(value.resolved)) {
    throw new Error("judge_panel.resolved must be an array");
  }
  return {
    source: value.source,
    resolved: value.resolved.map((item, index) => parseTraceSnapshot(item, index)),
    ran: parsePanelRan(value.ran),
    failed: parsePanelFailed(value.failed),
  };
}

export interface JudgeRaw { id: string; family: string; model: string; json: any; }
export interface JudgeFail { id: string; family: string; model: string; error: string; }
export type BeforeProviderCall = () => Promise<void>;

class OpenRouterHttpError extends Error {
  constructor(readonly status: number) {
    super(`OpenRouter request failed (${status})`);
    this.name = "OpenRouterHttpError";
  }
}

// ── JSON extraction (judges sometimes wrap in fences / add reasoning prose) ───

function stripFences(s: string): string {
  let t = s.trim();
  if (t.startsWith("```json")) t = t.slice(7).replace(/^\n/, "");
  else if (t.startsWith("```")) t = t.slice(3).replace(/^\n/, "");
  if (t.endsWith("```")) t = t.slice(0, -3).replace(/\n$/, "");
  return t.trim();
}

function parseJsonLoose(s: string): any {
  const t = stripFences(s);
  try { return JSON.parse(t); } catch { /* fall through to brace extraction */ }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error("judge output is not valid JSON");
}

// ── OpenRouter chat path (Grok, DeepSeek, any OpenRouter chat model) ──────────

async function callOpenRouter(
  model: string,
  system: string,
  user: string,
  effort?: ReasoningEffort,
  resolvedApiKey?: string,
  timeoutMs: number = OPENROUTER_TIMEOUT_MS,
): Promise<any> {
  const apiKey = resolvedApiKey ?? await resolveOpenRouterApiKey();
  const res = await fetch(OR_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": PUBLIC_REPO_URL,
      "X-Title": "titration-mcp",
    },
    body: JSON.stringify({
      // reasoning models (e.g. gpt-5.5) take OpenRouter's unified `reasoning.effort`;
      // omitted for non-reasoning models so the body stays clean.
      model, temperature: 0, max_tokens: MAX_TOKENS,
      ...(effort ? { reasoning: { effort } } : {}),
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401 || res.status === 403) {
    throw new ProviderCredentialError("credential_invalid");
  }
  if (!res.ok) throw new OpenRouterHttpError(res.status);
  const json: any = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (!content || !String(content).trim()) throw new Error("OpenRouter returned empty content");
  return parseJsonLoose(String(content));
}

// ── CLI doors (claude / codex / grok — the user's own subscription, $0 marginal) ─
//
// lib/judge-doors.ts resolves the CLI through ownership-checked lookup, spawns it
// without a shell, and already retries a transient process failure once; it
// returns the raw answer text, parsed here with the same loose JSON parser as the
// OpenRouter path.

async function callCliDoor(j: JudgeSpec & { door: CliJudgeDoor }, system: string, user: string, timeoutMs?: number): Promise<any> {
  return parseJsonLoose(await callDoor(j.door, { model: j.model, effort: j.effort, timeoutMs }, system, user));
}

function isJsonParseFailure(e: unknown): boolean {
  return e instanceof SyntaxError || /not valid JSON/i.test(String((e as any)?.message ?? e));
}

// ── single judge with one reproducible retry (temp 0 → deterministic) ─────────

const HARD_FAIL = /quota|unauthorized|not authenticated|401|403|OPENROUTER_API_KEY not set/i;

async function callJudgeWithResolvedOpenRouterKey(
  j: JudgeSpec,
  system: string,
  user: string,
  resolvedOpenRouterApiKey?: string,
  options: CallJudgeOptions = {},
): Promise<any> {
  const run = () => (
    j.door === "openrouter"
      ? callOpenRouter(
        j.model,
        system,
        user,
        j.effort,
        resolvedOpenRouterApiKey,
        options.timeoutMs,
      )
      : callCliDoor(j as JudgeSpec & { door: CliJudgeDoor }, system, user, options.timeoutMs)
  );
  try {
    return await run();
  } catch (e: any) {
    if (e instanceof ProviderCredentialError) throw e;
    // CLI doors already retried process failures inside callDoor; only an
    // unparseable answer earns this layer's retry.
    if (j.door !== "openrouter" && !isJsonParseFailure(e)) throw e;
    if (
      e instanceof OpenRouterHttpError
      && e.status >= 400
      && e.status < 500
    ) {
      throw e;
    }
    if (HARD_FAIL.test(String(e?.message ?? e))) throw e; // config/quota — retry won't help
    return await run(); // transient (malformed JSON, 5xx, timeout) — one retry
  }
}

export async function callJudge(
  j: JudgeSpec,
  system: string,
  user: string,
  options: CallJudgeOptions = {},
): Promise<any> {
  return callJudgeWithResolvedOpenRouterKey(j, system, user, undefined, options);
}

// ── panel resolution + parallel invocation ───────────────────────────────────

export function activePanel(): JudgeSpec[] {
  let panel = DEFAULT_PANEL;
  const sel = process.env.TITRATION_JUDGES;
  if (sel) {
    const ids = new Set(sel.split(",").map((s) => s.trim()).filter(Boolean));
    panel = panel.filter((j) => ids.has(j.id));
  }
  if (process.env.TITRATION_DISABLE_CODEX) panel = panel.filter((j) => j.door !== "codex");
  if (!process.env.OPENROUTER_API_KEY) {
    panel = panel.filter((j) => j.door !== "openrouter");
  }
  return panel;
}

// When the panel contains an OpenRouter judge, resolve the OpenRouter key before
// any judge starts, so a missing or malformed key refuses before Codex or
// provider spend. Once preflight holds, ordinary judge failures
// are captured for the caller's quorum decision, while provider-authentication
// failures remain fail-closed and reject the panel.
export async function runPanel(
  system: string,
  user: string,
  panel: JudgeSpec[] = activePanel(),
  beforeProviderCall?: BeforeProviderCall,
): Promise<{ ok: JudgeRaw[]; failed: JudgeFail[] }> {
  const resolvedOpenRouterApiKey = panel.some((judge) => judge.door === "openrouter")
    ? await resolveOpenRouterApiKey()
    : undefined;
  if (beforeProviderCall) await beforeProviderCall();
  const settled = await Promise.all(
    panel.map(async (j) => {
      try {
        return {
          kind: "ok" as const,
          ok: {
            id: j.id,
            family: j.family,
            model: j.model,
            json: await callJudgeWithResolvedOpenRouterKey(
              j,
              system,
              user,
              resolvedOpenRouterApiKey,
            ),
          },
        };
      } catch (e: any) {
        if (e instanceof ProviderCredentialError) {
          return { kind: "credential_error" as const, error: e };
        }
        return { kind: "fail" as const, fail: { id: j.id, family: j.family, model: j.model, error: String(e?.message ?? e) } };
      }
    }),
  );
  const credentialFailure = settled.find(
    (result) => result.kind === "credential_error",
  );
  if (credentialFailure?.kind === "credential_error") {
    throw credentialFailure.error;
  }
  return {
    ok: settled.flatMap((s) => (s.kind === "ok" ? [s.ok] : [])),
    failed: settled.flatMap((s) => (s.kind === "fail" ? [s.fail] : [])),
  };
}
