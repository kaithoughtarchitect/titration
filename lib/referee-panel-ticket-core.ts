// Titration MCP — referee-panel picker ticket lifecycle (PURE, offline-tested).
//
// Digest-only browser secret (SHA-256 hex, never the plaintext). Pending TTL is
// REFEREE_TICKET_TTL_SECONDS (720). Confirmed tickets outlive TTL; pending
// never revive. No clock or RNG — callers inject ISO timestamps. Ticket holds
// no prompt, corpus, or provider-key material.
//
// The confirmed snapshot is the SAME shape as judge.ts's SelectedPanelLock —
// 3 resolved judges ({id, family, door, model, effort}, structurally
// mirroring judge.ts's JudgeSnapshot WITHOUT importing judge.ts, the same
// pattern judges-roster-core.ts's JudgeSpecLike already uses) + selection
// {receipt_id, confirmed_at, player_family}. There is no fixed OpenRouter-
// catalog `picks` and no separate `display` triple carrying
// provider_display/model_page_url/agentic_index/pricing/latency: the local
// picker (server/picker/*) renders display metadata from judges-roster.json
// at request time instead of storing it — no catalog, no display cards.
// The local picker's URL is `http://127.0.0.1:<port>/
// ?token=<token>`, built in server/picker/server.ts, not here.
//
// A resolved judge's `id`/`model` are any non-empty string (a
// judges-roster.json id) and `door` is any of the four legal doors — never
// restricted to a fixed OpenRouter catalog. Family/effort are still validated against the SAME
// curated tables (referee-catalog-core.ts) as before, and this file still
// imports NOTHING beyond that (no fs, no network, no clock/RNG, no judge.ts /
// judges-roster-core.ts — the picker plumbing owns its own tiny structural
// checks so it never needs a path back into the I/O-carrying judge layer).

import { createHash } from "node:crypto";

import {
  REFEREE_PANEL_SIZE,
  REFEREE_TICKET_TTL_SECONDS,
  isRefereeCatalogFamily,
  isRefereeReasoningEffort,
  type RefereeCatalogFamily,
  type RefereeReasoningEffort,
} from "./referee-catalog-core";
import { parseOptionalRunBudget, type RefereeRunBudget } from "./referee-run-budget-core";

export const REFEREE_TICKET_STATUSES = ["pending", "confirmed", "expired"] as const;
export type RefereeTicketStatus = (typeof REFEREE_TICKET_STATUSES)[number];

const STATUS_SET: ReadonlySet<string> = new Set(REFEREE_TICKET_STATUSES);
const DIGEST_HEX = /^[0-9a-f]{64}$/;

// The four legal judge doors on a confirmed snapshot. Defined locally —
// not imported from judge.ts or judges-roster-core.ts — so this module keeps
// zero path back into either (mirrors judge.ts's own local JUDGE_DOORS /
// isJudgeDoor and judges-roster-core.ts's ROSTER_DOORS / isRosterDoor: three
// independent copies of the same four-item list rather than one shared
// import, deliberately, to keep this pure core's import graph exactly what
// its own offline suite pins).
export const CONFIRMED_PANEL_DOORS = ["openrouter", "claude", "codex", "grok"] as const;
export type ConfirmedPanelDoor = (typeof CONFIRMED_PANEL_DOORS)[number];
const CONFIRMED_PANEL_DOOR_SET: ReadonlySet<string> = new Set(CONFIRMED_PANEL_DOORS);
export function isConfirmedPanelDoor(value: unknown): value is ConfirmedPanelDoor {
  return typeof value === "string" && CONFIRMED_PANEL_DOOR_SET.has(value);
}

// Structurally identical to judge.ts's JudgeSnapshot, without
// importing it. effort is never null here — the picker always assigns a
// concrete low/medium/high to every confirmed judge (the row's default, or
// the human's per-judge choice), unlike a bare roster resolution which may
// carry no effort of its own.
export interface ConfirmedPanelJudge {
  id: string;
  family: RefereeCatalogFamily;
  door: ConfirmedPanelDoor;
  model: string;
  effort: RefereeReasoningEffort;
}

export type ConfirmedPanelResolved = readonly [
  ConfirmedPanelJudge,
  ConfirmedPanelJudge,
  ConfirmedPanelJudge,
];

export interface ConfirmedPanelSelection {
  // The picker ticket's own id (set by the confirm handler — the ticket
  // knows its own id at confirm time, rather than a separate reader
  // resolving it later). "env" is never stored here — an
  // env-sourced (TITRATION_JUDGES) lock is built directly in lib/verify.ts
  // and never touches a ticket row at all.
  receipt_id: string;
  confirmed_at: string;
  // The Player's resolved vendor family at MINT time (audit/display only —
  // lib/verify.ts re-resolves and re-checks the Player's family fresh on
  // every establish_baseline/verify/goal_titrate call regardless, from that
  // call's OWN player_model, never from this stored hint).
  player_family: RefereeCatalogFamily | null;
}

export interface ConfirmedPanelSnapshot {
  resolved: ConfirmedPanelResolved;
  selection: ConfirmedPanelSelection;
  /** Upcoming-run intent. Absent on legacy/local-default rows. samePanel ignores. */
  run_budget?: RefereeRunBudget;
  /**
   * Read-derived marker: a stored run_budget was present but unreadable
   * (version skew / out-of-band write). Never written by confirm. Survives
   * re-parse so the status boundary can tell corruption from legacy
   * absence. samePanel ignores.
   */
  run_budget_corrupt?: true;
}

export interface RefereePanelTicketRecord {
  digest_hex: string;
  status: RefereeTicketStatus;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  confirmation_snapshot: ConfirmedPanelSnapshot | null;
  establish_claimed_at: string | null;
  used_for_baseline_id: string | null;
}

export type PendingTicketRecord = RefereePanelTicketRecord & {
  status: "pending";
  consumed_at: null;
  confirmation_snapshot: null;
  establish_claimed_at: null;
  used_for_baseline_id: null;
};

export type ConfirmPlan =
  | { ok: true; kind: "apply"; ticket: RefereePanelTicketRecord }
  | { ok: true; kind: "idempotent"; ticket: RefereePanelTicketRecord }
  | { ok: false; kind: "conflict"; code: "different_panel" }
  | { ok: false; kind: "refuse"; code: "expired" };

export type ClaimPlan =
  | { ok: true; ticket: RefereePanelTicketRecord }
  | { ok: false; code: "not_confirmed" | "expired" | "used" };

export function isRefereeTicketStatus(value: unknown): value is RefereeTicketStatus {
  return typeof value === "string" && STATUS_SET.has(value);
}

export function digestSecretHex(secret: string): string {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("ticket secret is required");
  }
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function expiresAtFrom(created_at: string, ttlSeconds?: number): string {
  const createdMs = requireEpoch(created_at, "created_at");
  const ttl = ttlSeconds === undefined ? REFEREE_TICKET_TTL_SECONDS : ttlSeconds;
  if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl <= 0) {
    throw new Error("ticket ttlSeconds must be a positive finite number");
  }
  return new Date(createdMs + ttl * 1000).toISOString();
}

export function statusAt(ticket: RefereePanelTicketRecord, now: string): RefereeTicketStatus {
  assertTicketRecord(ticket);
  const nowMs = requireEpoch(now, "now");
  if (ticket.status === "confirmed") return "confirmed";
  if (ticket.status === "expired") return "expired";
  if (nowMs >= requireEpoch(ticket.expires_at, "expires_at")) {
    return "expired";
  }
  return "pending";
}

/**
 * Longest a status call may be held open waiting for the human's Send. Each
 * status call is a model turn for the agent, so a longer hold means fewer turns
 * spent waiting (J9 usage test: 28 calls over one 12-minute ticket at 25 s).
 * 50 s still leaves margin under a client whose tool-call timeout is 60 s.
 */
export const REFEREE_STATUS_WAIT_MAX_SECONDS = 50;

/**
 * Long-poll budget for referee_panel_status. Omitted means answer now (the
 * pre-1.0.45 contract). A number is clamped to the ceiling so a client whose
 * tool-call timeout is 60 s never trips it. Anything else is null: the caller
 * refuses, it does not guess.
 */
export function refereeStatusWaitMs(value: unknown): number | null {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.min(value, REFEREE_STATUS_WAIT_MAX_SECONDS) * 1000;
}

export function planMint(input: {
  secret: string;
  created_at: string;
  ttlSeconds?: number;
}): PendingTicketRecord {
  const created_at = requireIso(input.created_at, "created_at");
  const digest_hex = digestSecretHex(input.secret);
  return {
    digest_hex,
    status: "pending",
    created_at,
    expires_at: expiresAtFrom(created_at, input.ttlSeconds),
    consumed_at: null,
    confirmation_snapshot: null,
    establish_claimed_at: null,
    used_for_baseline_id: null,
  };
}

export function planConfirm(
  ticket: RefereePanelTicketRecord,
  snapshot: ConfirmedPanelSnapshot,
  now: string,
): ConfirmPlan {
  assertTicketRecord(ticket);
  const parsed = parseConfirmedPanelSnapshot(snapshot);
  const nowIso = new Date(requireEpoch(now, "now")).toISOString();
  const derived = statusAt(ticket, nowIso);

  if (derived === "expired") {
    return { ok: false, kind: "refuse", code: "expired" };
  }

  if (ticket.status === "confirmed") {
    const stored = ticket.confirmation_snapshot;
    if (stored == null) {
      throw new Error("confirmed ticket is missing confirmation_snapshot");
    }
    if (samePanel(stored, parsed)) {
      return { ok: true, kind: "idempotent", ticket };
    }
    return { ok: false, kind: "conflict", code: "different_panel" };
  }

  return {
    ok: true,
    kind: "apply",
    ticket: {
      digest_hex: ticket.digest_hex,
      status: "confirmed",
      created_at: ticket.created_at,
      expires_at: ticket.expires_at,
      consumed_at: nowIso,
      confirmation_snapshot: parsed,
      establish_claimed_at: null,
      used_for_baseline_id: null,
    },
  };
}

export function planClaim(ticket: RefereePanelTicketRecord, now: string): ClaimPlan {
  assertTicketRecord(ticket);
  const nowIso = new Date(requireEpoch(now, "now")).toISOString();
  const derived = statusAt(ticket, nowIso);
  if (derived === "expired") {
    return { ok: false, code: "expired" };
  }
  if (derived !== "confirmed") {
    return { ok: false, code: "not_confirmed" };
  }
  if (ticket.establish_claimed_at != null || ticket.used_for_baseline_id != null) {
    return { ok: false, code: "used" };
  }
  if (ticket.confirmation_snapshot == null || ticket.consumed_at == null) {
    throw new Error("confirmed ticket is missing receipt fields");
  }
  return {
    ok: true,
    ticket: {
      ...ticket,
      status: "confirmed",
      establish_claimed_at: nowIso,
    },
  };
}

function parseConfirmedJudge(value: unknown, index: number): ConfirmedPanelJudge {
  if (!isRecord(value)) {
    throw new Error(`confirmed panel snapshot resolved[${index}] must be an object`);
  }
  const { id, family, door, model, effort } = value;
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error(`confirmed panel snapshot resolved[${index}].id must be a non-empty string`);
  }
  if (!isRefereeCatalogFamily(family)) {
    throw new Error(`confirmed panel snapshot resolved[${index}].family must be a curated vendor family`);
  }
  if (!isConfirmedPanelDoor(door)) {
    throw new Error(`confirmed panel snapshot resolved[${index}].door must be one of ${CONFIRMED_PANEL_DOORS.join("/")}`);
  }
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new Error(`confirmed panel snapshot resolved[${index}].model must be a non-empty string`);
  }
  if (!isRefereeReasoningEffort(effort)) {
    throw new Error(`confirmed panel snapshot resolved[${index}].effort must be low, medium, or high`);
  }
  return { id, family, door, model, effort };
}

function parseConfirmedSelection(value: unknown): ConfirmedPanelSelection {
  if (!isRecord(value)) {
    throw new Error("confirmed panel snapshot requires selection");
  }
  const { receipt_id, confirmed_at, player_family } = value;
  if (typeof receipt_id !== "string" || receipt_id.trim().length === 0) {
    throw new Error("confirmed panel snapshot selection.receipt_id must be a non-empty string");
  }
  const confirmedAtIso = requireIso(confirmed_at, "selection.confirmed_at");
  let resolvedPlayerFamily: RefereeCatalogFamily | null = null;
  if (player_family !== null && player_family !== undefined) {
    if (!isRefereeCatalogFamily(player_family)) {
      throw new Error("confirmed panel snapshot selection.player_family must be a curated vendor family or null");
    }
    resolvedPlayerFamily = player_family;
  }
  return { receipt_id, confirmed_at: confirmedAtIso, player_family: resolvedPlayerFamily };
}

export function parseConfirmedPanelSnapshot(value: unknown): ConfirmedPanelSnapshot {
  if (!isRecord(value)) {
    throw new Error("confirmed panel snapshot must be an object");
  }
  const resolvedRaw = value.resolved;
  if (!Array.isArray(resolvedRaw) || resolvedRaw.length !== REFEREE_PANEL_SIZE) {
    throw new Error("confirmed panel snapshot resolved must be a triple");
  }
  const resolved: ConfirmedPanelJudge[] = [];
  for (let i = 0; i < REFEREE_PANEL_SIZE; i++) {
    resolved.push(parseConfirmedJudge(resolvedRaw[i], i));
  }
  const ids = new Set(resolved.map((judge) => judge.id));
  if (ids.size !== REFEREE_PANEL_SIZE) {
    throw new Error("confirmed panel snapshot resolved ids must be unique");
  }
  const families = new Set(resolved.map((judge) => judge.family));
  if (families.size !== REFEREE_PANEL_SIZE) {
    throw new Error("confirmed panel snapshot resolved must be three distinct families");
  }

  const selection = parseConfirmedSelection(value.selection);
  const run_budget = parseOptionalRunBudget(value.run_budget);
  // Fail-open drops an unreadable stored count, but the drop must stay visible
  // at the status boundary: mark it, and keep the mark across re-parse of an
  // already-parsed snapshot (whose raw illegal value is gone).
  const run_budget_corrupt = run_budget == null
    && (value.run_budget != null || value.run_budget_corrupt === true);

  return {
    resolved: [resolved[0]!, resolved[1]!, resolved[2]!],
    selection,
    ...(run_budget != null ? { run_budget } : {}),
    ...(run_budget_corrupt ? { run_budget_corrupt: true as const } : {}),
  };
}

function samePanel(left: ConfirmedPanelSnapshot, right: ConfirmedPanelSnapshot): boolean {
  for (let i = 0; i < REFEREE_PANEL_SIZE; i++) {
    const a = left.resolved[i]!;
    const b = right.resolved[i]!;
    if (a.id !== b.id || a.family !== b.family || a.door !== b.door || a.model !== b.model || a.effort !== b.effort) {
      return false;
    }
  }
  return true;
}

function assertTicketRecord(ticket: RefereePanelTicketRecord): void {
  if (!isRecord(ticket)) {
    throw new Error("ticket record must be an object");
  }
  if (!DIGEST_HEX.test(ticket.digest_hex)) {
    throw new Error("ticket digest_hex must be 64 lowercase hex chars");
  }
  if (!isRefereeTicketStatus(ticket.status)) {
    throw new Error("ticket status must be pending|confirmed|expired");
  }
  const createdMs = requireEpoch(ticket.created_at, "created_at");
  const expiresMs = requireEpoch(ticket.expires_at, "expires_at");
  if (expiresMs <= createdMs) {
    throw new Error("ticket expires_at must be after created_at");
  }

  if (ticket.status === "pending" || ticket.status === "expired") {
    if (
      ticket.consumed_at != null
      || ticket.confirmation_snapshot != null
      || ticket.establish_claimed_at != null
      || ticket.used_for_baseline_id != null
    ) {
      throw new Error("pending/expired ticket must be clean of receipt, claim, and baseline");
    }
    return;
  }

  if (ticket.consumed_at == null || ticket.confirmation_snapshot == null) {
    throw new Error("confirmed ticket requires consumed_at and confirmation_snapshot");
  }
  requireEpoch(ticket.consumed_at, "consumed_at");
  parseConfirmedPanelSnapshot(ticket.confirmation_snapshot);
  if (ticket.used_for_baseline_id != null && ticket.establish_claimed_at == null) {
    throw new Error("frozen ticket requires establish_claimed_at");
  }
  if (ticket.establish_claimed_at != null) {
    requireEpoch(ticket.establish_claimed_at, "establish_claimed_at");
  }
  if (ticket.used_for_baseline_id != null) {
    requireNonEmptyString(ticket.used_for_baseline_id, "used_for_baseline_id");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function requireEpoch(value: unknown, field: string): number {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`ticket '${field}' must be an ISO timestamp`);
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) {
    throw new Error(`ticket '${field}' must be an ISO timestamp`);
  }
  return epoch;
}

function requireIso(value: unknown, field: string): string {
  return new Date(requireEpoch(value, field)).toISOString();
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`ticket '${field}' must be a non-empty string`);
  }
  return value.trim();
}
