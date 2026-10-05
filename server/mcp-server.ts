// Titration MCP — transport-neutral semantic registry.
//
// This module is the one authority for tool and prompt registration, semantic
// dispatch, and MCP result/error shaping. Transport adapters explicitly supply
// public schemas plus trusted job/evolution I/O capabilities.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { cardCreate, cardRelate, runCapture, cardDistill } from "../lib/store";
import { effectiveCardSearch, effectiveCardGet } from "../lib/effective-retrieval";
import { resolveProject, selectMcpProject } from "../lib/project-core";
import { bindRepositoryProject } from "../lib/repository-project-core";
import { EXTRACTION_RITUAL, attachExtractionHint, EXTRACT_LEARNINGS_PROMPT_NAME, EXTRACT_LEARNINGS_PROMPT_DESCRIPTION, buildExtractLearningsPrompt } from "../lib/extraction-ritual";
import { proposeCards } from "../lib/card-propose";
import { proposeEdges } from "../lib/edge-propose";
import { classifyFailure } from "../lib/classify";
import { establishBaseline, verify } from "../lib/verify";
import {
  getJob,
  shouldRunAsync,
  SYNC_CORPUS_MAX,
  type JobExecutionContext,
} from "../lib/jobs";
import { startLocalJob } from "../lib/local-jobs";
import { startGoalTitrate, stepGoalTitrate } from "../lib/goal-titrate";
import { loadBaseline } from "../lib/baseline";
import { readLedger, captureVerdict, type LedgerContext } from "../lib/flywheel";
import { harnessDesign } from "../lib/harness-design";
import { CHANGE_TYPES } from "../lib/harness-design-core";
import { harnessValidate } from "../lib/harness-validate";
import { CARD_STATUSES, CARD_TYPES } from "../lib/card-contract-core";
import { BASELINE_GOAL_LIMITS } from "../lib/experiment-brief-core";
import { GOAL_TITRATE_TERMINAL_ORIGINS } from "../lib/goal-titrate-core";
import {
  createInteractiveWorkflowError,
  evolutionNoteRefusal,
  MAX_EVOLUTION_NOTE_CHARS,
  type InteractiveWorkflowErrorCode,
} from "../lib/evolution-note-core";
import { redactToolErrorText } from "../lib/tool-error-redaction-core";
import { randomBytes } from "node:crypto";
import { mintPending, loadById } from "../lib/referee-panel-ticket";
import {
  statusAt,
  refereeStatusWaitMs,
  REFEREE_STATUS_WAIT_MAX_SECONDS,
} from "../lib/referee-panel-ticket-core";
import { loadRoster, detectCliAvailability, hasOpenRouterKey } from "../lib/judges-roster";
import { resolvePlayerFamily, resolvePlayerFamilyOrThrow } from "../lib/judges-roster-core";
import { mintPicker } from "./picker/server";
type ToolArguments = Record<string, unknown>;
// Low-level MCP arguments arrive as a generic Record<string, unknown>, not as
// types derived from each tool's inputSchema. Keep the dynamic cast private to
// this module.
type InternalDynamicToolArguments = any;
type EvolutionArtifactKind = "prompt" | "code" | "configuration" | "mixed" | "other";
type McpMode = JobExecutionContext["mode"];
type JobExecutionContextFor<TMode extends McpMode> =
  Extract<JobExecutionContext, { mode: TMode }>;
type TrustedLocalPrepareArguments = (
  toolName: string,
  args: ToolArguments,
) => ToolArguments | Promise<ToolArguments>;

export interface PreparedEvolutionInput<TMode extends McpMode> {
  mode: TMode;
  tenant: string;
  jobId: string;
  artifactKind: EvolutionArtifactKind;
  note: string;
  evolution: ToolArguments;
}

export interface CaptureEvolutionInput<TPrepared, TMode extends McpMode>
  extends PreparedEvolutionInput<TMode> {
  turn: number;
  prepared: TPrepared;
}

export interface EvolutionCapture {
  complete: boolean;
  [key: string]: unknown;
}

export interface McpEvolutionAdapter<TPrepared, TMode extends McpMode> {
  mode: TMode;
  prepare(input: PreparedEvolutionInput<TMode>): Promise<TPrepared>;
  capture(input: CaptureEvolutionInput<TPrepared, TMode>): Promise<EvolutionCapture>;
}

export interface EvolutionCaptureFailureInput {
  error: unknown;
  jobId: string;
  turn: number;
}

export interface McpToolErrorContext {
  toolName: string;
}

export interface McpPresentationPolicy<TMode extends McpMode> {
  mode: TMode;
  pollHint: string;
  toolError(error: unknown, context?: McpToolErrorContext): string;
  evolutionCaptureFailure(input: EvolutionCaptureFailureInput): {
    error: string;
    recovery: string;
  };
}

const TOOL_ERROR_DESCRIPTION_MAX_LENGTH = 320;

function truncateToolErrorDescription(value: string): string {
  const codePoints = [...value];
  if (codePoints.length <= TOOL_ERROR_DESCRIPTION_MAX_LENGTH) return value;
  return `${codePoints.slice(0, TOOL_ERROR_DESCRIPTION_MAX_LENGTH - 3).join("")}...`;
}

function safeToolErrorIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const identifier = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(identifier)
    ? identifier
    : null;
}

function toolErrorRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function describeToolErrorIdentity(
  error: unknown,
  seen = new Set<object>(),
): string {
  const record = toolErrorRecord(error);
  if (!record) return "NonErrorThrown";
  if (seen.has(record)) return "Error";
  seen.add(record);

  const name = safeToolErrorIdentifier(record.name)
    ?? (error instanceof AggregateError
      ? "AggregateError"
      : error instanceof Error
        ? "Error"
        : "NonErrorThrown");
  const code = safeToolErrorIdentifier(record.code);
  const identity = code ? `${name} (${code})` : name;
  if (code) return identity;

  if (record.cause !== undefined) {
    return `${identity} caused by ${describeToolErrorIdentity(record.cause, seen)}`;
  }
  if (Array.isArray(record.errors) && record.errors.length > 0) {
    return `${identity} contains ${describeToolErrorIdentity(record.errors[0], seen)}`;
  }
  return identity;
}

function describeToolError(error: unknown): string {
  const record = toolErrorRecord(error);
  const rawMessage = typeof record?.message === "string"
    ? record.message.trim()
    : "";
  if (rawMessage) {
    const boundedMessage = truncateToolErrorDescription(rawMessage);
    return truncateToolErrorDescription(
      redactToolErrorText(boundedMessage) || "Error",
    );
  }
  return truncateToolErrorDescription(describeToolErrorIdentity(error));
}

export const TRUSTED_LOCAL_MCP_PRESENTATION: McpPresentationPolicy<"trusted-local"> = {
  mode: "trusted-local",
  pollHint: "poll job_status with { job_id } in the same repository context (legacy factory: also pass the selected project) until status is 'succeeded' (read result) or 'failed' (read error)",
  toolError(error) {
    return `error: ${describeToolError(error)}`;
  },
  evolutionCaptureFailure({ error, jobId, turn }) {
    const message = describeToolError(error);
    return {
      error: message,
      recovery:
        `turn ${turn} of job ${jobId} graded successfully, but its evolution note failed to save to the ` +
        `local database; the verdict stands, but there is no repair tool in this build, so goal_titrate_step ` +
        `refuses to grade another turn on this job until turn ${turn} has a recorded note — resolve the local ` +
        `database failure, then record that note directly (insert or update the goal_titrate_change_note row ` +
        `for job_id '${jobId}', turn_no ${turn}) before calling goal_titrate_step again`,
    };
  },
};

interface McpRegistryBase<TPrepared, TMode extends McpMode> {
  mode: TMode;
  // Public schemas retain project for automatic assertions and legacy selection;
  // connection context is supplied separately by the repository resolver.
  tools: readonly Tool[];
  evolution: McpEvolutionAdapter<TPrepared, TMode>;
  presentation: McpPresentationPolicy<TMode>;
}

export interface TrustedLocalMcpRegistryOptions<TPrepared>
  extends McpRegistryBase<TPrepared, "trusted-local"> {
  mode: "trusted-local";
  configuredProject?: string;
  resolveRepositoryProject?: () => Promise<string>;
  prepareArguments?: TrustedLocalPrepareArguments;
  createJobContext: (
    tenant: string,
  ) => JobExecutionContextFor<"trusted-local">
    | Promise<JobExecutionContextFor<"trusted-local">>;
}

export type McpRegistryOptions<TPrepared> = TrustedLocalMcpRegistryOptions<TPrepared>;

export class McpProductError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: InteractiveWorkflowErrorCode,
    message: string,
    // Only for a positively identified permanent server fault — see createInteractiveWorkflowError.
    // Left undefined, retryability is derived from `code` exactly as before.
    readonly retryableOverride?: boolean,
  ) {
    super(message);
    this.name = "McpProductError";
    this.retryable = createInteractiveWorkflowError(
      code,
      message,
      retryableOverride,
    ).retryable;
  }
}

// Sync-vs-async routing: an explicit `async` flag wins; otherwise auto by
// corpus size (a corpus larger than the sync ceiling runs as a background job, IN
// this same process — see lib/local-jobs.ts's startLocalJob).
function runSync(explicitAsync: unknown, corpusLen: number, maxCorpus: number | undefined): boolean {
  if (explicitAsync === true) return false; // force async
  if (explicitAsync === false) return true; // force sync
  return !shouldRunAsync(corpusLen, maxCorpus ?? SYNC_CORPUS_MAX);
}

// Keepalive: a sync verify/establish/goal_titrate_step grades for minutes, and a
// slow tool call risks an idle client timing out mid-grade — the caller then pays
// for a verdict it cannot read, with no handle to recover it. When the CLIENT
// supplied a progressToken (params._meta.progressToken),
// emit throttled MCP progress notifications from inside the call so the response
// stream carries traffic while the panel runs. Spec-correct: progress notifications
// are sent only for requests that carried a token. Best-effort by contract — a failed
// notification must never fail a grade. Exported for the offline suite.
export function buildProgressKeepalive(
  progressToken: string | number | undefined,
  sendNotification:
    | ((notification: {
        method: "notifications/progress";
        params: { progressToken: string | number; progress: number };
      }) => Promise<void>)
    | undefined,
  intervalMs = 10_000,
  now: () => number = Date.now,
): (() => Promise<void>) | undefined {
  if (progressToken === undefined || progressToken === null || typeof sendNotification !== "function") {
    return undefined;
  }
  let progress = 0;
  let lastSent = -Infinity;
  return async () => {
    progress++;
    const t = now();
    if (t - lastSent < intervalMs) return;
    lastSent = t;
    try {
      await sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress },
      });
    } catch {
      // Keepalive is best-effort: losing a notification must never fail a grade.
    }
  };
}

// beforeProviderCall fires once per ROW START (judge.ts invokes it as each row's panel
// begins), so a small corpus emits one burst at t≈0 and then nothing for the entire
// grade — the idle window the keepalive exists to cover. Drive the SAME keepalive from
// a timer for the duration of the sync call as well; the throttle above dedupes the two
// sources, and progress stays monotonic. Always cleared, even when the grade throws.
export async function withGradingKeepalive<T>(
  keepalive: (() => Promise<void>) | undefined,
  fn: () => Promise<T>,
  intervalMs = 15_000,
): Promise<T> {
  if (!keepalive) return fn();
  const timer = setInterval(() => {
    void keepalive();
  }, intervalMs);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}
// Shared metadata distinguishes automatic stdio from legacy factory selection.
// Advisory-optional tools override this description and receive no scope injection.
// Internal code and the DB retain the "tenant" name.
const PROJECT_PROP = {
  type: "string",
  description: 'Automatic stdio: omit project and leave TITRATION_PROJECT unset/blank; memory is derived from client-supplied local roots and current Git anchors; only a client that advertises no roots capability falls back to the directory it launched the server in (never inside the Titration clone itself). Supplied project and nonblank TITRATION_PROJECT are independent matching assertions, not overrides; invalid or conflicting values (including "default"/"__base__") refuse before tool work. Keep the same repository context for jobs/baselines; IDs do not route scope. Legacy factory without a repository resolver: valid nonblank explicit project wins (trimmed), otherwise nonblank TITRATION_PROJECT, otherwise PROJECT_REQUIRED; invalid explicit input never falls back, invalid configuration is checked only when needed. In legacy mode "default" can access old data and "__base__" is read-only, never a configured fallback. No data migration; the read-only base overlay is unchanged.',
};
const PREDICATES = ["cures", "extends", "complements", "supports", "supersedes", "superseded_by", "contradicts", "instance_of", "observed_in", "documented_in"];

// Shared schemas (establish_baseline + verify).
// Judge ids are free strings validated against judges-roster.json (validatePick /
// resolveAutoPanel), never a fixed enum — a user edits their own roster,
// so the three built-in ids this enum once named are no longer the only legal values.
const JUDGES = { type: "array", items: { type: "string" }, description: "optional subset of the resolved panel's judge ids to use (validated against judges-roster.json)" };
// Required on establish_baseline / verify / goal_titrate / goal_titrate_step
// — the Player's own vendor family may never sit on the judge panel that grades it.
const PLAYER_MODEL_PROP = {
  type: "string",
  description:
    "the Player's model id (e.g. 'claude-opus-5-5'). Resolved to a vendor family and checked against the judge panel — the Player's own family may never grade its own work. An unresolvable id refuses (typed error) unless player_family names the family explicitly.",
};
const PLAYER_FAMILY_PROP = {
  type: "string",
  description: "override when player_model does not resolve to a known vendor family (one of the curated families in judges-roster.json's families list).",
};
// The confirmed picker ticket id (referee_panel_mint
// -> referee_panel_status 'confirmed' -> this). One-use: claimed atomically on this
// call, before any judge spend — a second establish_baseline against the same
// ticket refuses. Beats TITRATION_JUDGES when both are present. Omit to resolve
// the panel from TITRATION_JUDGES instead (unset -> refuses naming referee_panel_mint).
const PANEL_RECEIPT_ID_PROP = {
  type: "string",
  description:
    "the ticket_id of a CONFIRMED referee_panel_mint ticket (poll referee_panel_status until status is 'confirmed'). Claimed one-use by this call, before any judge spend. Takes precedence over TITRATION_JUDGES. Omit to resolve the panel from TITRATION_JUDGES instead.",
};
const OUTPUT_ROW = {
  type: "object",
  description:
    "one captured output to grade (shipped inline — the engine grades it, it never runs your code). " +
    "WHAT REACHES A JUDGE: mode (rendered as the authoritative BUCKET line), record (rendered as the authoritative RECORD block), " +
    "input (rendered as INPUT context), and output. `id` is traceability only and is never shown to a judge.",
  properties: {
    id: { type: "string", description: "optional row id (traceability; NEVER rendered to judges)" },
    mode: { type: "string", description: "optional bucket (e.g. Foundation state, archetype group) → per-mode rates + regression alerts. RENDERED to judges as the harness-supplied, authoritative BUCKET line, so a stratified rubric ('the bucket is given to you') is decidable" },
    input: { type: "string", description: "optional probe/input that produced the output (context only; not graded)" },
    record: { type: "string", description: "optional harness-supplied evidence of what actually happened when this row was captured (e.g. which tools ran, what the ledger shows). RENDERED to judges as the authoritative RECORD block, so provenance/scope rubric clauses are falsifiable instead of graded against the output's own self-report" },
    capture: { type: "string", description: "optional replicate-capture label (repeat-capture support): rows captured in the SAME run of one configuration share a label (e.g. 'pass-1'). Label EVERY row or NONE — a partially labeled corpus is refused before grading (the band would cover a different population than the rate). With ≥2 distinct labels the verdict reports capture_variance (per-replicate rates + the between-capture band) and the improvement claim must clear significance_floor = max(noise_floor, band) — the judge noise floor measures judge disagreement only and CANNOT see capture-to-capture variance, which field measurement put at ~3× the printed floor. NOT rendered to judges" },
    output: { type: "string", description: "the captured output to grade" },
  },
  required: ["output"],
};
const THRESHOLDS = {
  type: "object",
  description: "optional gate overrides (spec defaults used otherwise): min_rate/min_abs (baseline-must-reproduce), min_n (effective-N), regression_pp (per-mode), max_corpus (the synchronous size ceiling, default 40 — a corpus larger than this runs as a background job in the server process instead of inline; raise it to force sync on a bigger corpus, or shrink the corpus), judge_variance_floor, panel_floor_votes/panel_floor_share (a scorable row is corroborated at ≥ panel_floor_votes canonical votes, default 2; more than panel_floor_share of scorable rows under that → INCONCLUSIVE / establish refuses to freeze, default 0.25)",
  properties: {
    min_rate: { type: "number" }, min_abs: { type: "number" }, min_n: { type: "number" },
    regression_pp: { type: "number" }, max_corpus: { type: "number" }, judge_variance_floor: { type: "number" },
    panel_floor_votes: { type: "number" }, panel_floor_share: { type: "number" },
  },
};
const ASYNC_PROP = {
  type: "boolean",
  description: "force async (true → returns { job_id }; poll job_status) or sync (false → inline result). Default: auto — a corpus larger than the sync ceiling (thresholds.max_corpus, default 40) runs async; smaller runs inline. A background job runs inside this same server process and survives only while it keeps running — if the server restarts before it finishes, job_status reports it failed with a typed reason; re-run it.",
};
// The flywheel: the ledger ANNOTATES a verdict, never influences it.
const LEDGER_PROP = {
  type: "boolean",
  description: "consult the tenant ledger for ADVISORY context before the verdict (failed-edit memory / domain-calibrated origins), attached as `ledger_context` — it NEVER changes the verdict. Default true; set false to skip (kill-switch). Fail-open: a read miss never blocks the verdict.",
};
const CAPTURE_PROP = {
  type: "boolean",
  description: "promote a durable learning from this run back to the tenant ledger (cardCreate → runCapture): a FINDING on a verified win, a REGRESSION on a failed edit (the failed-edit memory the read side later surfaces). Opt-in; default false. Never writes __base__ or on an inconclusive verdict. Fail-open: a write failure never alters the verdict.",
};
const emptyLedger = (tenant: unknown): LedgerContext => ({ consulted: false, tenant: String(tenant ?? ""), query: "", cards: [], error: null });

function diagnosticIdentifier(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  return /^[A-Za-z0-9._:@/-]{1,160}$/.test(text) ? text : "[invalid]";
}

function normalizedErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : "NonErrorThrown";
  return /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(name) ? name : "Error";
}

// player_model is required on establish_baseline / verify / goal_titrate /
// goal_titrate_step (schema `required`, enforced here too — the MCP door does no
// JSON-schema validation, so an omitted or wrong-typed value would otherwise reach
// the lib layer silently as "no player_model" and skip the exclusion check the
// caller believed was running). Returns the trimmed player_model plus the
// (optionally present) player_family override, both forwarded unchanged.
function requirePlayerModel(
  toolName: string,
  a: InternalDynamicToolArguments,
): { player_model: string; player_family?: string } {
  if (typeof a.player_model !== "string" || !a.player_model.trim()) {
    throw new McpProductError("bad_request", `${toolName}.player_model is required (the Player's model id — its vendor family may never sit on the judge panel)`);
  }
  if (a.player_family !== undefined && (typeof a.player_family !== "string" || !a.player_family.trim())) {
    throw new McpProductError("bad_request", `${toolName}.player_family must be a non-empty string when present`);
  }
  return {
    player_model: a.player_model.trim(),
    ...(typeof a.player_family === "string" && a.player_family.trim() ? { player_family: a.player_family.trim() } : {}),
  };
}

export const TRUSTED_LOCAL_MCP_TOOLS = [
  {
    name: "card_search",
    description:
      "Semantic GraphRAG search over the Titration knowledge graph. Only active (approved) cards are returned, never pending or superseded ones. Embeds the query, returns the most relevant cards with their typed relationship edges (cures / extends / complements / documented_in ...). Use for 'how do I ...' / 'what's the discipline for ...' questions about prompt-iteration, judges, measurement, and corpus design. Also run it BEFORE card_create to check whether an active card already covers a learning (search-before-create avoids near-duplicates). Optionally restrict to specific card types (`type`) and/or expand one bounded extra hop along high-value edges (`hops: 2` adds an additive `related[]` of linked cards).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "natural-language question" },
        project: PROJECT_PROP,
        k: { type: "number", description: "max results, 1-25 (default 5)" },
        type: {
          type: "array",
          items: { type: "string", enum: CARD_TYPES },
          description: "restrict to these card types",
        },
        hops: { type: "number", enum: [1, 2], description: "1 = direct hits (default); 2 = add a bounded related[] of linked cards" },
      },
      required: ["query"],
    },
  },
  {
    name: "card_get",
    description: "Fetch a single Titration card by its ref (e.g. T-MET-001), a bare ref (project first, then base) or a layered id from card_search ('project:T-MET-001' / 'base:T-MET-001') — full body, metadata, and typed edges.",
    inputSchema: {
      type: "object",
      properties: {
        card_ref: { type: "string", description: "card ref, e.g. T-MET-001 (or a layered id, e.g. 'base:T-MET-001')" },
        project: PROJECT_PROP,
      },
      required: ["card_ref"],
    },
  },
  {
    name: "card_create",
    description:
      "Create (or upsert) a card in a project ledger. '__base__' is rejected (curated). Auto-assigns the next ref for the type if card_ref is omitted (an auto-ref that collides is REFUSED, never a silent overwrite — pass an explicit card_ref to update a specific card). The card is embedded on write, so it is immediately retrievable by card_search.\n\n" +
      EXTRACTION_RITUAL,
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        type: { type: "string", enum: CARD_TYPES },
        title: { type: "string" },
        body: { type: "string", description: "markdown card content; normalized into the type-specific canonical sections" },
        tags: { type: "array", items: { type: "string" } },
        confidence: { type: "string", enum: ["low", "medium", "high", "critical"] },
        sample_size: { type: "string", description: "evidence sample size, or an explicit note such as 'not recorded'" },
        reproducibility: { type: "string", description: "how reproducible the learning is, or 'not assessed'" },
        origin_ref: { type: "string", description: "run/origin that produced the learning, e.g. RUN-..." },
        status: { type: "string", enum: CARD_STATUSES },
        card_ref: { type: "string", description: "optional explicit ref; auto-assigned if omitted" },
      },
      required: ["type", "title", "body"],
    },
  },
  {
    name: "card_relate",
    description: "Add a typed edge from a card to another card (or an external ref like a RUN-/docs id) within a project. Idempotent. When extracting from a run, add an observed_in edge from each new card to the run ref (provenance is required).",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        from_ref: { type: "string", description: "source card ref, e.g. T-MET-001" },
        predicate: { type: "string", enum: PREDICATES },
        to: { type: "string", description: "target card ref, or external ref (RUN-..., docs/...#x)" },
      },
      required: ["from_ref", "predicate", "to"],
    },
  },
  {
    name: "run_capture",
    description: "Record a run/harness capsule in a project and link existing cards to it via observed_in edges (the learnings flywheel). Call this FIRST when extracting learnings from a run — it anchors provenance and returns the run ref every new card links back to via an observed_in edge.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        ref: { type: "string", description: "run id, e.g. RUN-2026-06-15_my-validation" },
        summary: { type: "string" },
        cards: { type: "array", items: { type: "string" }, description: "card refs observed in this run" },
      },
      required: ["ref"],
    },
  },
  {
    name: "card_distill",
    description: "On-demand distilled surface: active cards in a project (optionally filtered by type or tag), grouped by type — the titration_core equivalent. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        type: { type: "string", enum: CARD_TYPES },
        tag: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "classify_failure",
    description:
      "Verdict engine. Classify ONE observed failure into exactly one of nine origins (system-under-test, corpus-gap, rubric-ambiguity, judge-variance, formatter, instrument-failure, pre-existing-pattern, state-artifact, cost-exhausted) via cross-vendor judge consensus, and answer the question to ask BEFORE editing anything: is this a `system-under-test` problem worth a prompt edit, or one of the other eight origins (don't touch the prompt — route elsewhere)? Returns the consensus origin, whether it is a valid edit target, confidence, reasoning, and per-judge breakdown with dissent. A 1-1-1 / no-majority split returns inconclusive (never a guess). A diagnosis is not a grade, so the Player's own vendor family MAY sit on this panel; the Player-family exclusion applies to the grading tools (establish_baseline, verify, goal_titrate, goal_titrate_step).",
    inputSchema: {
      type: "object",
      properties: {
        observation: { type: "string", description: "natural-language description of the observed failure (what went wrong, with any evidence about where it originated)" },
        baseline_context: { type: "string", description: "optional grounding context (e.g. the baseline/system being tested); not itself classified" },
        judges: JUDGES,
        reconsider: { type: "boolean", description: "run the dissent-reconsideration round on a 2-of-3 split — re-prompt the majority judges with the dissenter's reasoning, then re-tally (counters agreeableness bias; default true)" },
        mode: { type: "string", enum: ["panel", "single", "adaptive"], description: "judging mode (margin lever; default 'panel'): 'panel' = full 3-vendor consensus + reconsideration; 'single' = one calibrated judge (cheapest); 'adaptive' = probe one judge, escalate to the panel only on ambiguity or a system-under-test verdict (the only origin that greenlights a prompt edit — never single-judge)" },
        project: { ...PROJECT_PROP, description: "optional project whose private memory is consulted for ADVISORY domain-calibrated origins. The consensus origin is NOT influenced. Automatic stdio: omit it; the repository's own memory is used when its context is discoverable, otherwise the call runs without private context. A supplied project must match the repository or the call refuses. Legacy factory: omit to skip the read; configured defaults do not activate it. ledger:false always skips it (no discovery)." },
        ledger: LEDGER_PROP,
      },
      required: ["observation"],
    },
  },
  {
    name: "establish_baseline",
    description:
      "Verdict engine. Establish a FROZEN baseline (measuring stick) for a 'did this change help?' experiment: grade the captured baseline outputs against your rubric via cross-vendor judge consensus, CONFIRM the corpus actually reproduces the failure (else REFUSE with reproduced=false — a baseline that can't exhibit the bug measures nothing; a refusal also carries refused_because: 'not_reproduced' for that case, or 'panel_degraded' when too few judge families answered and nothing was measured), freeze the rubric (rubric_hash), and return a baseline_id to pass to `verify`. Binary per-output grade (does this output exhibit the failure?). Ship the corpus outputs INLINE — the engine grades them, it never runs your code. A corpus above the sync ceiling (thresholds.max_corpus, default 40) runs as a background job in this server process instead of inline (see `async`) — poll job_status for { job_id }. A baseline is ONE frozen artifact with one seal: it cannot be split into half-baselines and summed the way candidate grades can, so ship the whole corpus in one call. rubric_hash covers the RUBRIC TEXT ONLY (whitespace-normalized) — no other input (goal_brief, corpus, thresholds) contributes to it; if the hash moved, the rubric text changed.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        goal: { type: "string", description: "legacy free-form baseline goal. Prefer goal_brief so failure, desired behavior, and scope render consistently" },
        goal_brief: {
          type: "object",
          description: "structured baseline definition; the engine serializes this deterministically into the immutable goal stored with the baseline",
          properties: {
            failure: { type: "string", maxLength: BASELINE_GOAL_LIMITS.failure, description: "1 to 3 short sentences stating the undesirable behavior and its consequence. Use plain punctuation and do not use em dashes." },
            desired_behavior: { type: "string", maxLength: BASELINE_GOAL_LIMITS.desired_behavior, description: "1 to 3 short sentences stating the correct behavior or decision rule. Use plain punctuation and do not use em dashes." },
            scope: { type: "string", maxLength: BASELINE_GOAL_LIMITS.scope, description: "optional short test boundary. State the corpus or included claim first, then exclusions as separate sentences. Use plain punctuation and do not use em dashes." },
          },
          required: ["failure", "desired_behavior"],
        },
        rubric: { type: "string", description: "the fixed pass/fail criterion the judges apply (fail = the output exhibits the failure). This gets frozen — its hash is the seal." },
        baseline_outputs: { type: "array", items: OUTPUT_ROW, description: "the captured CURRENT (pre-change) outputs — must reproduce the bug" },
        system_ref: { type: "string", description: "optional concise capability identifier inside the project workspace, such as 'Clinical Safety' or 'Memory Deduplication'; do not use the workspace/project name or goal prose" },
        corpus_ref: { type: "string", description: "optional corpus identifier (free-form)" },
        judges: JUDGES,
        player_model: PLAYER_MODEL_PROP,
        player_family: PLAYER_FAMILY_PROP,
        panel_receipt_id: PANEL_RECEIPT_ID_PROP,
        thresholds: THRESHOLDS,
        retain_rows: {
          type: "boolean",
          description:
            "optional, default false: persist the PER-ROW grades with the frozen baseline ({id, mode, verdict, inconclusive, agreement, byJudge, panelFailed}) so per-stratum and per-arm rates can be recovered later from the baseline detail read WITHOUT paying to re-grade the corpus. Off by default because retention adds tens of KB of jsonb per baseline. Ignored when the corpus does not reproduce (a refused baseline stores no row at all).",
        },
        async: ASYNC_PROP,
      },
      required: ["rubric", "baseline_outputs", "player_model"],
    },
  },
  {
    name: "verify",
    description:
      "Verdict engine. Verify a candidate against a frozen baseline (from establish_baseline): grade the candidate's outputs under the SAME frozen rubric via cross-vendor consensus and return the verdict you are ENTITLED to believe — not just `passed`, but `floor_intact`, `per_mode_regression`, `failure_origin`, `votes` (panel coverage), and `inconclusive`. A metric_delta INSIDE the significance floor returns `inconclusive`, NOT `passed` (it never claims a win it can't distinguish from noise); an aggregate gain that hides a per-mode collapse does not ship. KNOW WHAT noise_floor COVERS: it is 1 − inter-judge agreement on the rows you shipped — it measures JUDGE disagreement only and cannot see how much a re-CAPTURE of the same configuration moves the rate (field-measured at roughly 3× the judge floor). To measure that, ship candidate_outputs as labelled replicates (row.capture) — the verdict then reports capture_variance and gates on significance_floor = max(noise_floor, band). Ship candidate outputs INLINE. A corpus above the sync ceiling (thresholds.max_corpus, default 40) runs as a background job in this server process instead of inline (see `async`) — poll job_status for { job_id }.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        baseline_id: { type: "string", description: "the baseline_id returned by establish_baseline" },
        candidate_outputs: { type: "array", items: OUTPUT_ROW, description: "the captured POST-change outputs to grade against the frozen baseline" },
        judges: JUDGES,
        player_model: PLAYER_MODEL_PROP,
        player_family: PLAYER_FAMILY_PROP,
        thresholds: THRESHOLDS,
        async: ASYNC_PROP,
        ledger: LEDGER_PROP,
        capture: CAPTURE_PROP,
      },
      required: ["baseline_id", "candidate_outputs", "player_model"],
    },
  },
  {
    name: "job_status",
    description:
      "Poll a job's status, scoped to the project — the poll handle for an async `verify` / `establish_baseline` call or a `goal_titrate` run. Returns { status: 'queued'|'running'|'succeeded'|'failed', result?, error?, kind, created_at, updated_at, terminal_at }. Poll until status is 'succeeded' (read `result` — the full VerifyResult/EstablishResult) or 'failed' (read `error`). A verify/establish_baseline job runs in the background inside the SAME server process that queued it and survives only while that process keeps running: if the server restarts before it finishes, this reports status 'failed' with a typed reason naming the restart — re-run it. For a goal_titrate run it ALSO returns { turn_count, last_turn_at } and updated_at moves every time a turn lands — so after a client timeout on goal_titrate_step, check turn_count BEFORE resending: if it advanced, the turn landed and a resend would burn a budgeted turn on a duplicate.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        job_id: { type: "string", description: "the job_id returned by verify / establish_baseline / goal_titrate" },
      },
      required: ["job_id"],
    },
  },
  {
    name: "goal_titrate",
    description:
      `Verdict engine. START a long-running, CLIENT-SHIPS-OUTPUTS iteration loop anchored to a FROZEN baseline (from establish_baseline). Pass baseline_id plus structured candidate provenance; the engine loads the authoritative frozen goal instead of asking the Player to restate it. It NEVER runs your code. YOUR agent does each turn's work and ships that turn's candidate outputs via \`goal_titrate_step\`; the engine grades them (cross-vendor consensus via \`verify\` against the frozen baseline — ≥2 judges, noise-floor + per-mode + direction-split gates all apply) and decides continue / converge / stop. Sub-objectives are the baseline's frozen modes, LOCKED at turn 1 (the loop's freeze); convergence = a real, non-inconclusive improvement with every sub-objective at/under target_rate. Returns { job_id }; advance with goal_titrate_step, poll with job_status. The terminal verdict is converged OR stopped-with-a-failure-origin (${GOAL_TITRATE_TERMINAL_ORIGINS.join(" / ")}) + a per-turn audit trail.`,
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        goal: { type: "string", description: "deprecated compatibility input. The run inherits the authoritative goal from baseline_id; differing supplied prose is retained only as submitted_goal audit metadata" },
        baseline_id: { type: "string", description: "a FROZEN baseline_id from establish_baseline — the loop grades every turn's candidate against it" },
        candidate: {
          type: "object",
          description: "structured identity of the candidate being tested; kept separate from the frozen baseline goal",
          properties: {
            name: { type: "string", description: "short human-readable candidate name, such as 'CV91 Dedup'" },
            version: { type: "string", description: "commit, prompt hash, build id, model configuration, or other immutable candidate reference" },
            summary: { type: "string", description: "concise description of the change under test" },
            deferred_scope: { type: "string", description: "known behavior deliberately outside this run's claim" },
          },
          required: ["name"],
        },
        budget: { type: "number", description: "max turns before the loop stops as budget-exhausted (default 20)" },
        stall_threshold: { type: "number", description: "consecutive no-progress turns before the loop stops as critical-stall (default 3)" },
        target_rate: { type: "number", description: "a sub-objective (baseline mode) is 'met' when its candidate failure rate ≤ this; convergence needs every sub-objective met (default 0 = bug eliminated)" },
        player_model: PLAYER_MODEL_PROP,
        player_family: PLAYER_FAMILY_PROP,
        thresholds: { ...THRESHOLDS, description: "the grading gates for this run, LOCKED at turn 1 (the loop's freeze) and applied identically to every turn. This is the ONLY door: `goal_titrate_step` does not accept thresholds, because a per-turn override would let the party being graded lower its own gate on the very turn being graded — and a verdict does not record the thresholds it was graded at, so the weakened turn would be indistinguishable from a default one. Omit for the engine defaults." },
        ledger: LEDGER_PROP,
        capture: { ...CAPTURE_PROP, description: "promote a durable card on the TERMINAL run (FINDING on convergence / REGRESSION on a stalled-or-exhausted run). LOCKED at turn 1 (the loop's freeze). Opt-in; default false. Fail-open." },
      },
      required: ["baseline_id", "player_model"],
    },
  },
  {
    name: "goal_titrate_step",
    description:
      "Verdict engine. ADVANCE one turn of a goal_titrate run: grades this turn's candidate_outputs against the frozen baseline and returns the full per-turn verdict. Ship candidate_outputs plus evolution { artifact_kind, note, prompt_file? } as this turn's audit-trail identity (what changed and why). Evolution capture is ACTIVE and LOCAL in this build: after grading, the declared note (evolution.note + artifact_kind) is recorded in this server's own database as this turn's audit-trail entry, returned as evolution_capture { complete }. Exact prompt text is NEVER stored — only the declared note (evolution.prompt_file is accepted but not read; there is no separate UI and no prompt store here). Before grading any turn on a job, the immediately preceding turn on that job must already have a recorded note — a missing predecessor note refuses THIS call before any judges run, so no budget is spent on a refused turn. If the note fails to save after a successful grade, the verdict still stands but evolution_capture.complete is false, and every later turn on this job is refused until that note is recorded — there is no repair tool in this build; see evolution_capture.recovery. Grading a normal-sized corpus commonly exceeds a 5-minute client idle timeout — configure the client for long calls up front, and after any timeout poll job_status and check turn_count BEFORE resending (a landed duplicate burns a budgeted turn). MEASUREMENT HONESTY: turns that each ship ONE capture per candidate are single-draw comparisons — the noise floor covers judge disagreement only, not capture-to-capture variance; ship a turn's candidate_outputs as labelled replicates (row.capture) to measure and gate on the real spread.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        job_id: { type: "string", description: "the job_id returned by goal_titrate" },
        candidate_outputs: { type: "array", items: OUTPUT_ROW, description: "this turn's captured candidate outputs (bucket by `mode` to match the baseline's sub-objectives)" },
        fingerprint: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            "optional OPEN environment-fingerprint map {name: hash-or-id} — engine commit, prompt diff hash, client-script sha256, model ids, anything that could change the capture. The engine never interprets entries; it WARNS (environment_warnings) when the declared map differs from the previous turn's, because two turns captured on different rigs are different measurements wearing identical verdict records. Declare it EVERY turn for the comparison to run. Independently, a per-mode row-count swing above 40% between consecutive turns warns even without a fingerprint (the quota-died-mid-capture signature).",
        },
        evolution: {
          type: "object",
          description: "required display provenance for this exact turn; kept structurally separate from graded outputs",
          properties: {
            artifact_kind: { type: "string", enum: ["prompt", "code", "configuration", "mixed", "other"], description: "what changed this turn" },
            note: { type: "string", maxLength: MAX_EVOLUTION_NOTE_CHARS, description: `concise account of the exact change, version/commit lineage, and no unreturned result claims. HARD LIMIT ${MAX_EVOLUTION_NOTE_CHARS} characters, counted on the string exactly as sent (whitespace included) so this bound matches maxLength — a longer note is refused before grading, so summarise rather than pasting a changelog` },
            prompt_file: { type: "string", description: "optional path to the candidate prompt/system text; accepted for compatibility but not read or stored — only the declared note is recorded" },
          },
          required: ["artifact_kind", "note"],
        },
        judges: JUDGES,
        player_model: PLAYER_MODEL_PROP,
        player_family: PLAYER_FAMILY_PROP,
        // NO `thresholds` here, deliberately. `goal_titrate` (start) never accepted
        // them, so this was the only door — and it let the caller lower the grading
        // gate on the very turn being graded, with nothing in the stored verdict
        // recording that it had happened. A run must be measured with one ruler.
        // `verify` and `establish_baseline` still take thresholds: those are
        // single-shot calls the caller owns end to end.
      },
      required: ["job_id", "candidate_outputs", "evolution", "player_model"],
    },
  },
  {
    // The design half of the scaffolding split. This grows the tool count
    // past the long-tracked 12 BY DESIGN: a genuinely new capability, not a new arg.
    name: "harness_design",
    description:
      "Scaffolding design brain. Given a system-under-test and the kind of change, DESIGN a paired-corpus validation harness — the measurement instrument that answers 'did this change move the metric without regressing the floor?' Returns a PROPOSED design package: a human-review README, a label schema WITH authority classes (structural / compliance-literal / semantic — semantic labels are judge-decided, never regex-alone), quantified ship-gate thresholds + rationale, the 5-file manifest (capture-corpus / generate-labels / ai-label / analyze-corpus / compare — what each must contain), predicted outcomes, and the precedent it applied. status is always 'PROPOSED': YOUR (local) agent surfaces it and waits for explicit 'scaffold it' before writing any file — the most-expensive-failure checkpoint (discovering after $8-16 of capture that the metrics measure the wrong thing) survives the wire. This is a SINGLE strong-model design call grounded in the knowledge ledger (advisory + human-reviewed), NOT a 3-judge verdict. It does not write files, run capture, or touch your repo.",
    inputSchema: {
      type: "object",
      properties: {
        system_description: { type: "string", description: "what the system-under-test is + the change being validated (e.g. 'Stage 1 narration-leak prompt edit')" },
        change_type: { type: "string", enum: CHANGE_TYPES, description: "the kind of change (drives corpus naming / passes / isolation)" },
        baseline_facts: { type: "string", description: "optional cited baseline numbers + source (never invented — e.g. 'leak 60% at V5, commit abc'). Omit if none documented (the design routes baseline capture to Phase A)." },
        codebase_facts: {
          type: ["string", "object"],
          description: "strongly recommended: the concrete facts you read from the repo, verbatim — the exact allowed output values (e.g. the category and priority sets), the output schema, a few real sample inputs with their current outputs, the pipeline entry point and the relevant file names. The design uses ONLY these for concrete values and marks anything missing as UNKNOWN instead of guessing. Pass the same facts to harness_validate.",
        },
        project: { ...PROJECT_PROP, description: "optional project whose private memory and internal platform methodology ground precedent. Automatic stdio: omit it; the repository's own memory is used when its context is discoverable, otherwise the call runs without private context. A supplied project must match the repository or the call refuses. Legacy factory: omit for base-only precedent; configured defaults do not activate private context. Raw platform cards are never returned; the precedent NEVER enters a verdict." },
        design_model: { type: "string", description: "optional OpenRouter model override for the single design call. Omit to resolve via TITRATION_HELPER_MODEL (a judges-roster.json id), else the first available verified door (subscription CLIs first)." },
      },
      required: ["system_description", "change_type"],
    },
  },
  {
    // The validation half of the scaffolding split. Tool #14: a
    // genuinely new capability, not a new arg — the "12 tools" invariant is broken
    // BY DESIGN across the scaffolding split (design -> 13, validate -> 14). gotcha #16.
    name: "harness_validate",
    description:
      "Scaffolding validation brain. Given a harness design (or a scaffolded file manifest) and the codebase facts YOUR (local) agent gathered, run the 9-check validation that gates a harness BEFORE the $8-30 capture spend: File-Contract Integrity, Label Schema Quality, Codebase Grounding, Pre-flight Verification, Isolation Discipline, README Completeness & Anti-patterns, Statistical Soundness, Judge Safety, Cross-Harness Consistency. Returns a scored report: per-check severities, a weighted score /100, and a recommendation (Proceed 90+ / Revise 70-89 / Reject <70) — any Critical caps the verdict at Revise (or Reject if score<70). The server CANNOT see your repo, so codebase_facts is REQUIRED — supply resolved IDs, cited baseline numbers WITH source, the pipeline entry point, the isolation state (engine flags across both arms), and the false-clean traps (a prompt-override or platform-settings flag that would make the candidate corpus identical to baseline); missing or contradictory grounding returns a Critical. This is a SINGLE strong-model call (advisory + human/agent-actioned), NOT a 3-judge verdict — the score is ONE sample: scores and Critical counts are NOT comparable across runs of an unchanged harness (run-to-run differences are validator variance, not new defects; the report's `reproducibility` field says so). A deviation the submission itself declares and justifies is engaged on its stated reason, never re-raised as an undisclosed defect. ADVISORY-NOT-BLOCKING: the report RETURNS the recommendation — it never hard-stops; YOU decide whether to run capture. It does not write files, run capture, or touch your repo.",
    inputSchema: {
      type: "object",
      properties: {
        design_or_manifest: {
          type: ["string", "object"],
          description: "the harness under validation: the PROPOSED design package from harness_design (pass it through), or a scaffolded file manifest / description of the 5 TS files + README",
        },
        codebase_facts: {
          type: ["string", "object"],
          description: "the grounding the server can't see: resolved IDs, cited baseline numbers + source, the pipeline entry point (harness calls the pipeline function directly, not HTTP/UI), the isolation state (engine flags identical across baseline/candidate arms), and the false-clean traps (active_prompts overrides / platform-settings flags making candidate ≡ baseline). Missing/contradictory → a Critical.",
        },
        mode: { type: "string", enum: ["thorough", "quick"], description: "'thorough' (all 9 checks, default) or 'quick' (checks 1,2,3,8 — file-contract, label schema, grounding, judge safety; for re-validation after minor edits)" },
        validate_model: { type: "string", description: "optional OpenRouter model override for the single validation call. Omit to resolve via TITRATION_HELPER_MODEL (a judges-roster.json id), else the first available verified door (subscription CLIs first)." },
      },
      required: ["design_or_manifest", "codebase_facts"],
    },
  },
  {
    name: "propose_cards",
    description:
      "Extraction ritual (ADVISORY — creates nothing): given a completed run summary, a SINGLE model call DRAFTS candidate non-verdict cards (METHOD / MODEL_PROFILE / PROMPT_BEHAVIOR / DATASET_NOTE) + suggested edges for you to review and create yourself. FINDING/REGRESSION are excluded (the verdict flywheel auto-captures those). METHOD drafts and contradicts/supersedes edges are flagged requires_confirmation / high_stakes — never create those without confirming. Pass a project to dedup against existing cards (a near-duplicate is returned as duplicate_of so you UPDATE instead of creating anew). This is the model-assisted version of the extraction ritual — you still own the create.",
    inputSchema: {
      type: "object",
      properties: {
        run_summary: { type: "string", description: "what the completed run/analysis produced — the server cannot see your work, so supply the evidence the proposals must be grounded in" },
        project: { ...PROJECT_PROP, description: "optional project for neighbor dedup context. Automatic stdio: omit it; the repository's own memory is used when its context is discoverable, otherwise the call runs without private context. A supplied project must match the repository or the call refuses. Legacy factory: omit to skip neighbor reads; configured defaults do not activate context. Supplied existing_cards are always retained." },
        run_ref: { type: "string", description: "optional run ref (RUN-...) for suggested observed_in edges" },
        existing_cards: { type: "string", description: "optional extra existing-card context to dedup against (merged with the project pull)" },
        k: { type: "number", description: "how many existing cards to pull for dedup context when a project is given (1-25, default 8)" },
        propose_model: { type: "string", description: "optional OpenRouter model override for the single advisory call. Omit to resolve via TITRATION_HELPER_MODEL (a judges-roster.json id), else the first available verified door (subscription CLIs first)." },
      },
      required: ["run_summary"],
    },
  },
  {
    name: "edge_propose",
    description:
      "Advisory graph edge proposal (creates nothing): given a SOURCE card_ref + project, a SINGLE model call proposes typed conceptual edges (supports / complements / extends / cures / instance_of, or high-stakes contradicts / supersedes) FROM the source TO its nearest existing neighbor cards, for you to confirm and card_relate. Read-only; targets are restricted to real neighbor refs from this project's own cards (the read-only base starter pack is never proposed as a target) and de-duplicated against the source's existing edges. contradicts/supersedes are flagged high_stakes — never create those without confirming.",
    inputSchema: {
      type: "object",
      properties: {
        card_ref: { type: "string", description: "the source card to propose edges from, e.g. T-MET-001" },
        project: PROJECT_PROP,
        k: { type: "number", description: "how many neighbor cards to consider as candidate targets (1-25, default 8)" },
        propose_model: { type: "string", description: "optional OpenRouter model override. Omit to resolve via TITRATION_HELPER_MODEL (a judges-roster.json id), else the first available verified door (subscription CLIs first)." },
      },
      required: ["card_ref"],
    },
  },
  {
    // The local judge picker. Mints a one-use,
    // 12-minute ticket, starts (or reuses) a one-shot http://127.0.0.1 server,
    // and opens it in the default browser — a loopback-only browser-consent
    // boundary, with no session or account needed.
    name: "referee_panel_mint",
    description:
      "Mint a one-use, 12-minute LOCAL referee-panel picker ticket for a NEW selected-panel baseline, and open it in the default browser. Returns { ticket_id, picker_url, expires_at }. Show picker_url to the human ALONE on its own line, never inside a sentence (terminals wrap long lines, and a click on a wrapped link opens a truncated URL) and NEVER write it to a log — it is a loopback URL (http://127.0.0.1:<port>/...) that only this machine can reach, and the URL itself is both the page's address and the confirm authorization. The page lists every judges-roster.json door with its cost class, disables whatever is unavailable on this machine (CLI not installed, OPENROUTER_API_KEY unset), is your own vendor family, shares a vendor with sut_model (the model being tested, when you pass it), or is unverified — each with the reason — and pre-fills the recommended panel when one resolves. The human picks 3 judges from 3 distinct vendor families and confirms; poll referee_panel_status next, then call establish_baseline with panel_receipt_id set to that ticket_id.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        player_model: PLAYER_MODEL_PROP,
        player_family: PLAYER_FAMILY_PROP,
        sut_model: {
          type: "string",
          description:
            "optional but recommended: the model the system under test calls (e.g. 'deepseek/deepseek-v4-flash'). Its vendor family is greyed out in the picker and refused on confirm, because a judge may favour its own vendor's outputs. An unresolvable id refuses unless sut_family names the family.",
        },
        sut_family: {
          type: "string",
          description: "override when sut_model does not resolve to a known vendor family (one of the curated families in judges-roster.json).",
        },
      },
      required: ["player_model"],
    },
  },
  {
    name: "referee_panel_status",
    description:
      "Poll a referee-panel ticket minted by referee_panel_mint. Returns { status: 'pending'|'confirmed'|'expired'|'used', panel?, panel_receipt_id? } — never a secret. Pass wait_seconds: 50 and the call holds open (long-poll, ~1s laps) until the ticket leaves 'pending', so the answer lands the moment the human clicks Confirm; repeat until 'confirmed' or 'expired', and never ask the human to report back. On 'confirmed' (and on 'used' — a receipt already spent by establish_baseline), panel lists the 3 chosen judges ({id, family, door, model, effort}) and panel_receipt_id is the ticket_id to pass to establish_baseline. On 'expired': mint a fresh ticket; a pending ticket never revives.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT_PROP,
        ticket_id: { type: "string", description: "the ticket_id returned by referee_panel_mint" },
        wait_seconds: {
          type: "number",
          minimum: 0,
          maximum: REFEREE_STATUS_WAIT_MAX_SECONDS,
          description: `hold the call open up to this many seconds until the ticket leaves pending. Omit for an instant answer. Ceiling ${REFEREE_STATUS_WAIT_MAX_SECONDS}.`,
        },
      },
      required: ["ticket_id"],
    },
  },
] as const satisfies readonly Tool[];

export const TRUSTED_LOCAL_TOOL_NAMES = [
  "card_search",
  "card_get",
  "card_create",
  "card_relate",
  "run_capture",
  "card_distill",
  "classify_failure",
  "establish_baseline",
  "verify",
  "job_status",
  "goal_titrate",
  "goal_titrate_step",
  "harness_design",
  "harness_validate",
  "propose_cards",
  "edge_propose",
  "referee_panel_mint",
  "referee_panel_status",
] as const;

type EqualUnions<Left, Right> =
  [Left] extends [Right]
    ? [Right] extends [Left]
      ? true
      : false
    : false;
type AssertTrue<Value extends true> = Value;
type TrustedLocalRegistryName =
  typeof TRUSTED_LOCAL_MCP_TOOLS[number]["name"];
type _TrustedLocalRegistryMatchesNames = AssertTrue<EqualUnions<
  TrustedLocalRegistryName,
  typeof TRUSTED_LOCAL_TOOL_NAMES[number]
>>;

// v1 extraction ritual: run-completion tools whose result carries the advisory extraction nudge.
const NUDGE_TOOLS = new Set(["run_capture", "verify", "goal_titrate_step"]);

// Exactly the stateful routes; the three advisory tools and harness_validate
// are classified separately. The registry test pins all 18.
const MANDATORY_PROJECT_TOOLS = new Set([
  "card_search", "card_get", "card_create", "card_relate", "run_capture", "card_distill",
  "establish_baseline", "verify", "job_status", "goal_titrate", "goal_titrate_step",
  "edge_propose", "referee_panel_mint", "referee_panel_status",
]);
// Optional private context: automatic factories bind it to the repository when
// discoverable; legacy factories keep caller-selected context.
const ADVISORY_PROJECT_TOOLS = new Set(["classify_failure", "propose_cards", "harness_design"]);

export function createMcpServer<TPrepared>(
  options: McpRegistryOptions<TPrepared>,
): McpServer {
  return createMcpServerForMode({
    mode: "trusted-local",
    tools: options.tools,
    evolution: options.evolution,
    presentation: options.presentation,
    async prepareCall(toolName, suppliedArguments) {
      const arguments_ = options.prepareArguments
        ? await options.prepareArguments(toolName, suppliedArguments)
        : suppliedArguments;
      // Enforce after trusted preparation, inside the request error boundary.
      // A fresh object avoids contaminating a hook's reused/shared arguments.
      if (ADVISORY_PROJECT_TOOLS.has(toolName) && options.resolveRepositoryProject) {
        // Automatic advisory context: the repository's memory when discoverable,
        // otherwise none (fail open). A supplied project never selects another tenant.
        if (toolName === "classify_failure" && arguments_.ledger === false) return { arguments: arguments_ };
        let derived: string;
        try {
          derived = await options.resolveRepositoryProject();
        } catch (error) {
          console.error(`[advisory] ${toolName} runs without repository memory: ${error instanceof Error ? error.message : String(error)}`);
          const { project: _unverified, ...rest } = arguments_;
          return { arguments: rest };
        }
        return { arguments: { ...arguments_, project: bindRepositoryProject(derived, arguments_.project, options.configuredProject) } };
      }
      if (!MANDATORY_PROJECT_TOOLS.has(toolName)) return { arguments: arguments_ };
      const project = options.resolveRepositoryProject
        ? bindRepositoryProject(await options.resolveRepositoryProject(), arguments_.project, options.configuredProject)
        : selectMcpProject(arguments_.project, options.configuredProject);
      return { arguments: { ...arguments_, project } };
    },
    createJobContext(tenant) {
      return options.createJobContext(tenant);
    },
  });
}

interface InternalPreparedToolCall {
  arguments: ToolArguments;
}

function createMcpServerForMode<TPrepared, TMode extends McpMode>(
  options: McpRegistryBase<TPrepared, TMode> & {
    prepareCall(
      toolName: string,
      suppliedArguments: ToolArguments,
    ): Promise<InternalPreparedToolCall>;
    createJobContext(
      tenant: string,
    ): JobExecutionContextFor<TMode> | Promise<JobExecutionContextFor<TMode>>;
  },
): McpServer {
const server = new McpServer({ name: "titration", version: "0.1.0" }, { capabilities: { tools: {}, prompts: {} } });
const protocol = server.server;

protocol.setRequestHandler(
  ListToolsRequestSchema,
  async () => ({ tools: [...options.tools] }),
);

// MCP prompts (a distinct primitive from tools — does NOT change the tool count). extract_learnings
// is the on-command /t-run analog for clients that support the prompts capability (e.g. Claude Code
// surfaces it as a slash command); clients without prompt support still get the same discipline from
// the tool descriptions, so nothing depends on this (the vendor-agnostic guarantee).
protocol.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: EXTRACT_LEARNINGS_PROMPT_NAME,
      description: EXTRACT_LEARNINGS_PROMPT_DESCRIPTION,
      arguments: [
        { name: "run_id", description: "optional run ref (RUN-...) to anchor provenance", required: false },
        { name: "run_summary", description: "optional summary of what the run produced", required: false },
      ],
    },
  ],
}));
protocol.setRequestHandler(GetPromptRequestSchema, async (req) => {
  if (req.params.name !== EXTRACT_LEARNINGS_PROMPT_NAME) throw new Error(`unknown prompt '${req.params.name}'`);
  const a = (req.params.arguments ?? {}) as any;
  return {
    description: EXTRACT_LEARNINGS_PROMPT_DESCRIPTION,
    messages: [
      { role: "user" as const, content: { type: "text" as const, text: buildExtractLearningsPrompt({ run_id: a.run_id, run_summary: a.run_summary }) } },
    ],
  };
});

protocol.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  try {
    const supplied = (req.params.arguments ?? {}) as ToolArguments;
    const preparedCall = await options.prepareCall(req.params.name, supplied);
    const a = preparedCall.arguments as InternalDynamicToolArguments;
    // A5: throttled progress keepalive for the long sync grading calls, armed only
    // when the client asked for progress (see buildProgressKeepalive above).
    const keepalive = buildProgressKeepalive(
      (req.params as { _meta?: { progressToken?: string | number } })._meta?.progressToken,
      extra?.sendNotification
        ? (n) => extra.sendNotification(n as Parameters<typeof extra.sendNotification>[0])
        : undefined,
    );
    let result: unknown;
    // `project` (public) -> internal tenant slug, through the one normalizer
    // (lib/project-core.ts). A read of a project resolveProject has never seen
    // behaves as empty (lib/store.ts's non-throwing lookup); the first write
    // creates it (lib/store.ts's tenantIdForWrite). card_search/card_get ALSO
    // merge in the read-only __base__ layer via effectiveCardSearch/Get.
    if (req.params.name === "card_search") result = await effectiveCardSearch(a.query, resolveProject(a.project), a.k ?? 5, { type: a.type, hops: a.hops });
    else if (req.params.name === "card_get") result = await effectiveCardGet(a.card_ref, resolveProject(a.project));
    else if (req.params.name === "card_create") result = await cardCreate(resolveProject(a.project), a);
    else if (req.params.name === "card_relate") result = await cardRelate(resolveProject(a.project), a.from_ref, a.predicate, a.to);
    else if (req.params.name === "run_capture") result = await runCapture(resolveProject(a.project), a.ref, a.summary ?? null, a.cards ?? []);
    else if (req.params.name === "card_distill") result = await cardDistill(resolveProject(a.project), { type: a.type, tag: a.tag });
    else if (req.params.name === "classify_failure") {
      // Flywheel READ (advisory, fail-open): domain-calibrated origins when a
      // project is named. classify is READ-ONLY in the flywheel (the write fires
      // only on a completed verify / goal_titrate run). The consensus origin is
      // computed independently of the ledger — the cards never enter the judge prompt.
      // `project` is genuinely optional here (unlike the card-surface tools above):
      // omitting it SKIPS the advisory read entirely rather than defaulting to
      // "default" — preserved from the pre-project-rename behavior.
      const wantRead = a.ledger !== false && typeof a.project === "string" && a.project.trim().length > 0;
      const ledger_context = wantRead ? await readLedger(resolveProject(a.project), { kind: "classify", observation: a.observation }) : emptyLedger(a.project);
      const r = await classifyFailure({ observation: a.observation, baseline_context: a.baseline_context, judges: a.judges, reconsider: a.reconsider, mode: a.mode });
      result = { ...r, ledger_context };
    }
    else if (req.params.name === "establish_baseline") {
      const project = resolveProject(a.project);
      // panel_receipt_id is a ticket
      // confirmed via the local picker (referee_panel_mint / referee_panel_status).
      // Without a receipt, the panel comes from TITRATION_JUDGES: unset
      // refuses naming referee_panel_mint, a comma list of judges-roster.json ids
      // resolves that panel, "auto" resolves the deterministic subscription-first
      // panel — see lib/judges-roster.ts. A receipt beats TITRATION_JUDGES when
      // both are present (lib/verify.ts checks the receipt first).
      if (a.panel_receipt_id !== undefined && (typeof a.panel_receipt_id !== "string" || !a.panel_receipt_id.trim())) {
        throw new Error("establish_baseline.panel_receipt_id must be a non-empty string when present");
      }
      // Reject rather than coerce, matching boolFlag on the durable replay path. The MCP door does
      // no JSON-schema validation, so `retain_rows: "true"` would otherwise be silently dropped
      // AFTER the caller paid for a full grade.
      if (a.retain_rows !== undefined && typeof a.retain_rows !== "boolean") {
        throw new Error("retain_rows must be a boolean");
      }
      const player = requirePlayerModel("establish_baseline", a);
      const panelReceiptId = typeof a.panel_receipt_id === "string" && a.panel_receipt_id.trim()
        ? { panel_receipt_id: a.panel_receipt_id.trim() }
        : {};
      const replayInput = { goal: a.goal, goal_brief: a.goal_brief, rubric: a.rubric, baseline_outputs: a.baseline_outputs, system_ref: a.system_ref, corpus_ref: a.corpus_ref, judges: a.judges, ...player, ...panelReceiptId, thresholds: a.thresholds, ...(a.retain_rows === true ? { retain_rows: true } : {}) };
      const callArgs = { tenant: project, ...replayInput };
      const corpusLen = Array.isArray(a.baseline_outputs) ? a.baseline_outputs.length : 0;
      if (runSync(a.async, corpusLen, a.thresholds?.max_corpus)) result = await withGradingKeepalive(keepalive, () => establishBaseline(callArgs, keepalive ? { beforeProviderCall: keepalive } : {}));
      else {
        // No durable worker in this build — the SAME establishBaseline call the
        // sync branch above runs is dispatched to startLocalJob (lib/local-jobs.ts),
        // which runs it IN this process and tracks it through the jobs row. The tool
        // call itself returns { job_id } immediately; job_status carries the result.
        const { job_id } = await startLocalJob(project, "establish_baseline", replayInput, () =>
          establishBaseline(callArgs, {}),
        );
        result = { job_id, status: "queued", kind: "establish_baseline", poll: options.presentation.pollHint };
      }
    }
    else if (req.params.name === "verify") {
      const project = resolveProject(a.project);
      const player = requirePlayerModel("verify", a);
      const replayInput = { baseline_id: a.baseline_id, candidate_outputs: a.candidate_outputs, judges: a.judges, ...player, thresholds: a.thresholds };
      const callArgs = { tenant: project, ...replayInput };
      const corpusLen = Array.isArray(a.candidate_outputs) ? a.candidate_outputs.length : 0;
      // Flywheel: load the frozen baseline ONCE (fail-open) — its goal drives the
      // advisory read query, its system_ref + goal the durable-learning card. A bad
      // baseline_id leaves bl=null → read is skipped + verify() surfaces the error;
      // the flywheel never blocks the verdict. The internal per-turn verify() inside
      // goal_titrate does NOT route through here, so it never reads/writes the ledger.
      let bl: Awaited<ReturnType<typeof loadBaseline>> | null = null;
      try {
        bl = await loadBaseline(project, a.baseline_id);
      } catch (error) {
        console.error("[titration-mcp] advisory baseline lookup failed (fail-open)", {
          tenant: diagnosticIdentifier(project),
          baseline_id: diagnosticIdentifier(a.baseline_id),
          error_name: normalizedErrorName(error),
        });
      }
      const wantRead = a.ledger !== false && !!bl;
      const ledger_context = wantRead ? await readLedger(project, { kind: "verify", goal: bl!.goal }) : emptyLedger(project);
      const wantCapture = a.capture === true && !!bl;
      const capture = (r: Awaited<ReturnType<typeof verify>>) =>
        wantCapture && !r.inconclusive
          ? captureVerdict(project, { kind: "verify", goal: bl!.goal, baseline_id: a.baseline_id, system_ref: bl!.system_ref, result: r })
          : Promise.resolve({ captured: false, card_ref: null, run_ref: null, type: null, embedded: false, error: null });
      if (runSync(a.async, corpusLen, a.thresholds?.max_corpus)) {
        // Terminal MCP verify call — draftOnRefusal:true.
        const r = await withGradingKeepalive(keepalive, () => verify(callArgs, { draftOnRefusal: true, ...(keepalive ? { beforeProviderCall: keepalive } : {}) }));
        const ledger_capture = await capture(r);
        result = { ...r, ledger_context, ledger_capture };
      } else {
        // No durable worker in this build — the SAME verify call (draftOnRefusal:true)
        // plus the same fail-open ledger capture the sync branch above runs is dispatched
        // to startLocalJob (lib/local-jobs.ts), which runs it IN this process. job_status
        // reports the enriched { ...r, ledger_context, ledger_capture } shape on success,
        // matching the sync branch's result byte-for-byte.
        const { job_id } = await startLocalJob(project, "verify", replayInput, async () => {
          const r = await verify(callArgs, { draftOnRefusal: true });
          const ledger_capture = await capture(r);
          return { ...r, ledger_context, ledger_capture };
        });
        result = { job_id, status: "queued", kind: "verify", poll: options.presentation.pollHint, ledger_context };
      }
    }
    else if (req.params.name === "job_status") result = await getJob(resolveProject(a.project), a.job_id);
    else if (req.params.name === "goal_titrate")
      result = await startGoalTitrate({ tenant: resolveProject(a.project), goal: a.goal, baseline_id: a.baseline_id, candidate: a.candidate, ...requirePlayerModel("goal_titrate", a), budget: a.budget, stall_threshold: a.stall_threshold, target_rate: a.target_rate, thresholds: a.thresholds, ledger: a.ledger, capture: a.capture });
    else if (req.params.name === "goal_titrate_step") {
      const project = resolveProject(a.project);
      const player = requirePlayerModel("goal_titrate_step", a);
      // These three pre-grade checks throw McpProductError (2026-08-25, Issue 1 family):
      // as plain Errors they would render as the untyped "request could
      // not be completed", which a caller cannot tell from an outage — and a step that
      // fails HERE has written no state, so "resend or not?" was unanswerable.
      const evolution = a.evolution;
      if (!evolution || typeof evolution !== "object") {
        throw new McpProductError("bad_request", "goal_titrate_step.evolution is required for every graded turn");
      }
      const artifactKind = typeof evolution.artifact_kind === "string" ? evolution.artifact_kind : "";
      if (!["prompt", "code", "configuration", "mixed", "other"].includes(artifactKind)) {
        throw new McpProductError("bad_request", "goal_titrate_step.evolution.artifact_kind must be prompt, code, configuration, mixed, or other");
      }
      // Same shared validator every call site that accepts a note uses. This dispatch previously
      // trimmed and checked only for emptiness — no cap — so publishing maxLength on the schema
      // above without this would leave a strict client refusing notes the runtime accepts, and
      // accepting notes far past the published bound. The schema and this check now measure the
      // same thing.
      const noteRefusal = evolutionNoteRefusal(evolution.note);
      if (noteRefusal) {
        throw new McpProductError(
          "bad_request",
          `goal_titrate_step.${noteRefusal} (what changed this turn)`,
        );
      }
      // B2 fingerprint: an open {name: string} map, bounded so it stays a fingerprint
      // rather than a payload channel. Typed refusals name the rule (Issue 2 discipline).
      let fingerprint: Record<string, string> | undefined;
      if (a.fingerprint !== undefined) {
        if (!a.fingerprint || typeof a.fingerprint !== "object" || Array.isArray(a.fingerprint)) {
          throw new McpProductError("bad_request", "goal_titrate_step.fingerprint must be an object map of {name: string}");
        }
        const entries = Object.entries(a.fingerprint as Record<string, unknown>);
        if (entries.length > 32) {
          throw new McpProductError("bad_request", `goal_titrate_step.fingerprint has ${entries.length} entries; maximum is 32`);
        }
        for (const [key, value] of entries) {
          if (key.length > 64) throw new McpProductError("bad_request", `goal_titrate_step.fingerprint key '${key.slice(0, 64)}…' exceeds 64 characters`);
          if (typeof value !== "string" || value.length > 256) {
            throw new McpProductError("bad_request", `goal_titrate_step.fingerprint['${key}'] must be a string of at most 256 characters`);
          }
        }
        fingerprint = a.fingerprint as Record<string, string>;
      }
      const note = (evolution.note as string).trim();
      // The registry invokes preparation before any judge call; each deployment
      // adapter prepares its evidence and enforces predecessor completeness.
      const prepared = await options.evolution.prepare({
        mode: options.mode,
        tenant: project,
        jobId: a.job_id,
        artifactKind: artifactKind as EvolutionArtifactKind,
        note,
        evolution,
      });
      const stepResult = await withGradingKeepalive(keepalive, () => stepGoalTitrate(
        { tenant: project, job_id: a.job_id, candidate_outputs: a.candidate_outputs, judges: a.judges, ...player, ...(fingerprint ? { fingerprint } : {}) },
        keepalive ? { beforeProviderCall: keepalive } : {},
      ));
      try {
        const evolution_capture = await options.evolution.capture({
          mode: options.mode,
          tenant: project,
          jobId: a.job_id,
          turn: stepResult.turn,
          artifactKind: artifactKind as EvolutionArtifactKind,
          note,
          evolution,
          prepared,
        });
        result = { ...stepResult, evolution_capture };
      } catch (e) {
        const failure = options.presentation.evolutionCaptureFailure({
          error: e,
          jobId: a.job_id,
          turn: stepResult.turn,
        });
        result = {
          ...stepResult,
          evolution_capture: {
            complete: false,
            ...failure,
          },
        };
      }
    }
    else if (req.params.name === "harness_design")
      // A single strong-model design call grounded in the ledger; the
      // pure invariant-checked assembly lives in harness-design-core (throws on a
      // malformed design). PROPOSED-first survives the wire — the local agent waits.
      // `project` is advisory-optional here (like classify_failure): an explicit
      // value is normalized through resolveProject; an absent one is passed through
      // unchanged so harnessDesign's own fallback (base-only precedent) applies.
      result = await harnessDesign({ system_description: a.system_description, change_type: a.change_type, baseline_facts: a.baseline_facts, codebase_facts: a.codebase_facts, tenant: typeof a.project === "string" && a.project.trim() ? resolveProject(a.project) : a.project, design_model: a.design_model });
    else if (req.params.name === "harness_validate")
      // A single strong-model 9-check validation over local-supplied
      // codebase facts; the pure weighted-/100 scoring + Critical→Revise/Reject
      // promotion live in harness-validate-core (throws on a malformed/incomplete
      // report). ADVISORY-NOT-BLOCKING — the report never hard-stops; the local
      // agent owns the block. No `project`/tenant input (unchanged).
      result = await harnessValidate({ design_or_manifest: a.design_or_manifest, codebase_facts: a.codebase_facts, mode: a.mode, validate_model: a.validate_model });
    else if (req.params.name === "propose_cards")
      // Extraction ritual v2: a single advisory model call DRAFTS candidate non-verdict cards
      // (creates nothing). The pure allowed-type + per-type-stakes invariants live in propose-core.
      // `project` is advisory-optional (an absent one skips the dedup-context pull, unchanged).
      result = await proposeCards({ run_summary: a.run_summary, tenant: typeof a.project === "string" && a.project.trim() ? resolveProject(a.project) : a.project, run_ref: a.run_ref, existing_cards: a.existing_cards, k: a.k, propose_model: a.propose_model });
    else if (req.params.name === "edge_propose")
      // Advisory graph edge proposal: a single advisory call proposes typed edges from a card to its neighbors
      // (creates nothing). Pure validate / restrict-to-candidates / dedup in edge-propose-core.
      result = await proposeEdges({ card_ref: a.card_ref, tenant: resolveProject(a.project), k: a.k, propose_model: a.propose_model });
    else if (req.params.name === "referee_panel_mint") {
      // Mint the DB ticket FIRST (need its id + expires_at before the
      // picker page/URL can exist), THEN bind the local http server — mintPicker
      // itself binds the port before returning the URL (no probe race). The
      // Player's family is resolved ONCE here (typed refusal on an unresolvable
      // player_model without player_family) so the picker page can grey it
      // out and validatePick can refuse it server-side on confirm.
      const project = resolveProject(a.project);
      const player = requirePlayerModel("referee_panel_mint", a);
      const playerFamily = resolvePlayerFamilyOrThrow(player.player_model, player.player_family);
      // Optional: the model the system under test calls. Its vendor is kept off the
      // panel too (a judge may favour its own vendor's outputs). Resolved like the
      // Player: an unresolvable sut_model without sut_family is a typed refusal,
      // never a silent "no exclusion".
      let sutModel: string | null = null;
      let sutFamily: ReturnType<typeof resolvePlayerFamily> = null;
      if (a.sut_model !== undefined || a.sut_family !== undefined) {
        if (a.sut_model !== undefined && (typeof a.sut_model !== "string" || !a.sut_model.trim())) {
          throw new McpProductError("bad_request", "referee_panel_mint.sut_model must be a non-empty string when present");
        }
        if (a.sut_family !== undefined && (typeof a.sut_family !== "string" || !a.sut_family.trim())) {
          throw new McpProductError("bad_request", "referee_panel_mint.sut_family must be a non-empty string when present");
        }
        sutModel = typeof a.sut_model === "string" ? a.sut_model.trim() : null;
        sutFamily = resolvePlayerFamily(sutModel ?? "", typeof a.sut_family === "string" ? a.sut_family : null);
        if (!sutFamily) {
          throw new McpProductError(
            "bad_request",
            `sut_model '${sutModel ?? ""}'${a.sut_family ? ` (sut_family '${a.sut_family}')` : ""} does not resolve to a known vendor family. ` +
            `Pass sut_family naming one of the curated families, or omit both if its vendor has no judge in the roster.`,
          );
        }
      }
      const secret = randomBytes(16).toString("hex");
      const ticket = await mintPending({ tenantSlug: project, secret, now: new Date().toISOString() });
      const [roster, available, keyed] = await Promise.all([
        loadRoster(),
        detectCliAvailability(),
        Promise.resolve(hasOpenRouterKey()),
      ]);
      const { url } = await mintPicker({
        tenantSlug: project,
        ticketId: ticket.id,
        token: secret,
        expiresAt: ticket.expires_at,
        playerModel: player.player_model,
        playerFamily,
        sutModel,
        sutFamily,
        roster,
        available,
        hasOpenRouterKey: keyed,
      });
      result = { ticket_id: ticket.id, picker_url: url, expires_at: ticket.expires_at };
    }
    else if (req.params.name === "referee_panel_status") {
      const project = resolveProject(a.project);
      if (typeof a.ticket_id !== "string" || !a.ticket_id.trim()) {
        throw new McpProductError("bad_request", "referee_panel_status.ticket_id is required");
      }
      const waitMs = refereeStatusWaitMs(a.wait_seconds);
      if (waitMs === null) {
        throw new McpProductError(
          "bad_request",
          `referee_panel_status.wait_seconds must be a number of seconds, 0 to ${REFEREE_STATUS_WAIT_MAX_SECONDS}`,
        );
      }
      const ticketId = a.ticket_id.trim();
      // Long-poll: hold the call open until the ticket leaves pending or the
      // budget runs out, so a single call returns the moment the human clicks
      // Confirm. The row is re-read each ~1s lap; statusAt turns expiry into a
      // stop on its own (no extra bookkeeping needed here).
      const deadline = Date.now() + waitMs;
      for (;;) {
        const ticket = await loadById({ tenantSlug: project, id: ticketId });
        if (!ticket) {
          throw new McpProductError("not_found", "referee panel ticket was not found");
        }
        const rawStatus = statusAt(ticket, new Date().toISOString());
        const remainingMs = deadline - Date.now();
        if (rawStatus !== "pending" || remainingMs <= 0) {
          // "used" is derived, not stored: a claimed ticket is still
          // status='confirmed' at the row level — surface that
          // establish_baseline already claimed (or claimed AND froze) this
          // receipt rather than reporting a plain 'confirmed' a caller might
          // try to spend again. establish_claimed_at alone already means the
          // one-use gate (claimForEstablish) will refuse a second claim, even
          // mid-grade before a baseline is frozen — so this checks that, not
          // only used_for_baseline_id (set later, on freeze).
          const status = rawStatus === "confirmed" && ticket.establish_claimed_at != null ? "used" : rawStatus;
          result = {
            status,
            ...(rawStatus === "confirmed" && ticket.confirmation_snapshot
              ? {
                  panel: ticket.confirmation_snapshot.resolved.map((judge) => ({
                    id: judge.id,
                    family: judge.family,
                    door: judge.door,
                    model: judge.model,
                    effort: judge.effort,
                  })),
                  panel_receipt_id: ticket.id,
                }
              : {}),
          };
          break;
        }
        await new Promise<void>((resolve) => { setTimeout(resolve, Math.min(1000, remainingMs)); });
      }
    }
    else throw new Error(`unknown tool '${req.params.name}'`);
    // Attach the advisory extraction nudge at run-completion moments (additive field, fail-open).
    if (NUDGE_TOOLS.has(req.params.name)) result = attachExtractionHint(result);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (e: any) {
    return {
      content: [{
        type: "text",
        text: options.presentation.toolError(e, {
          toolName: req.params.name,
        }),
      }],
      isError: true,
    };
  }
});

return server;
}
