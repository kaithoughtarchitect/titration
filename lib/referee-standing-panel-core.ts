// Titration MCP — standing referee panel lifecycle (PURE, offline-tested).
//
// A standing panel lets the human confirm a judge panel ONCE in the local picker
// and have later establish_baseline calls in the same project reuse it without a
// fresh pop-up. It is the same confirmed snapshot a one-use picker ticket holds,
// plus a bound: at most `max_uses` baselines (default 10, ceiling 20) and only
// until `expires_at` (default 8 hours, ceiling 24). It is only ever created by
// the picker's confirm handler, from a checkbox the human ticks
// (server/picker/server.ts -> lib/referee-panel-ticket.ts's `confirm`); no tool
// can create one. Revoking, exhausting or outliving it falls back to today's
// one-use ticket flow.
//
// Each use re-checks, inside the claim, that neither the calling Player's vendor
// family nor the system-under-test's family (the one stored at confirm time,
// plus any the call names) sits on the panel — the same rule the picker enforces
// on confirm, applied again on every reuse. lib/verify.ts additionally runs its
// usual assertFamilyNotOnPanel on the Player's family.
//
// No clock or RNG — callers inject ISO timestamps. Imports only the ticket core
// (the snapshot shape) and nothing that does I/O.

import {
  parseConfirmedPanelSnapshot,
  type ConfirmedPanelSnapshot,
} from "./referee-panel-ticket-core";

export const STANDING_PANEL_DEFAULT_USES = 10;
export const STANDING_PANEL_MAX_USES = 20;
export const STANDING_PANEL_DEFAULT_HOURS = 8;
export const STANDING_PANEL_MAX_HOURS = 24;

export type StandingPanelState = "active" | "expired" | "exhausted" | "revoked";

export interface StandingPanelRequest {
  uses: number;
  hours: number;
}

export interface StandingPanelRecord {
  id: string;
  tenant_id: string;
  source_ticket_id: string;
  confirmation_snapshot: ConfirmedPanelSnapshot;
  /** The system-under-test family the human confirmed against, if the mint named one. */
  sut_family: string | null;
  max_uses: number;
  uses: number;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export type StandingUseRefusalCode =
  | "standing_expired"
  | "standing_exhausted"
  | "standing_revoked"
  | "standing_family_conflict";

export type StandingUsePlan =
  | { ok: true; uses: number; used_at: string }
  | { ok: false; code: StandingUseRefusalCode; message: string };

/**
 * Parse the picker's optional `standing` field. Absent / null / false means
 * "no standing panel" (the one-use default). Anything present must be a
 * {uses, hours} object of whole numbers inside the bounds; otherwise the confirm
 * is refused rather than silently clamped — the human's visible choice is what
 * gets stored, or nothing is.
 */
export function parseStandingPanelRequest(
  raw: unknown,
): { ok: true; standing: StandingPanelRequest | null } | { ok: false; message: string } {
  if (raw === undefined || raw === null || raw === false) return { ok: true, standing: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "confirm body.standing must be an object {uses, hours} when present" };
  }
  const { uses, hours } = raw as Record<string, unknown>;
  if (!Number.isInteger(uses) || (uses as number) < 1 || (uses as number) > STANDING_PANEL_MAX_USES) {
    return { ok: false, message: `confirm body.standing.uses must be a whole number from 1 to ${STANDING_PANEL_MAX_USES}` };
  }
  if (!Number.isInteger(hours) || (hours as number) < 1 || (hours as number) > STANDING_PANEL_MAX_HOURS) {
    return { ok: false, message: `confirm body.standing.hours must be a whole number from 1 to ${STANDING_PANEL_MAX_HOURS}` };
  }
  return { ok: true, standing: { uses: uses as number, hours: hours as number } };
}

/**
 * The agent's suggested pre-fill for the picker checkbox (referee_panel_mint's
 * standing_uses). Only a suggestion: the box is pre-ticked with this count and
 * the human can untick it or change it before Confirm. null = leave unticked.
 */
export function parseStandingUsesSuggestion(value: unknown): number | null | "invalid" {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > STANDING_PANEL_MAX_USES) return "invalid";
  return value as number;
}

export function standingExpiresAt(createdAt: string, hours: number): string {
  const createdMs = requireEpoch(createdAt, "created_at");
  if (!Number.isInteger(hours) || hours < 1 || hours > STANDING_PANEL_MAX_HOURS) {
    throw new Error(`standing panel hours must be a whole number from 1 to ${STANDING_PANEL_MAX_HOURS}`);
  }
  return new Date(createdMs + hours * 3_600_000).toISOString();
}

export function standingStateAt(record: StandingPanelRecord, now: string): StandingPanelState {
  const nowMs = requireEpoch(now, "now");
  if (record.revoked_at != null) return "revoked";
  if (record.uses >= record.max_uses) return "exhausted";
  if (nowMs >= requireEpoch(record.expires_at, "expires_at")) return "expired";
  return "active";
}

/**
 * Families that may never sit on the panel for THIS use: the caller's Player
 * family, the SUT family stored at confirm time, and any SUT family the call
 * names. Returns the first judge that clashes, or null.
 */
export function standingFamilyConflict(
  record: Pick<StandingPanelRecord, "confirmation_snapshot" | "sut_family">,
  exclusions: { playerFamily: string | null; sutFamily: string | null },
): { judge_id: string; family: string; reason: "player" | "sut" } | null {
  const sutFamilies = new Set([record.sut_family, exclusions.sutFamily].filter((f): f is string => !!f));
  for (const judge of record.confirmation_snapshot.resolved) {
    if (exclusions.playerFamily && judge.family === exclusions.playerFamily) {
      return { judge_id: judge.id, family: judge.family, reason: "player" };
    }
    if (sutFamilies.has(judge.family)) {
      return { judge_id: judge.id, family: judge.family, reason: "sut" };
    }
  }
  return null;
}

/** Decide one use of a standing panel. Refusals happen before any judge spend. */
export function planStandingUse(
  record: StandingPanelRecord,
  input: { now: string; playerFamily: string | null; sutFamily: string | null },
): StandingUsePlan {
  const nowIso = new Date(requireEpoch(input.now, "now")).toISOString();
  const state = standingStateAt(record, nowIso);
  if (state === "revoked") {
    return { ok: false, code: "standing_revoked", message: "the standing panel was revoked; mint a fresh picker ticket (referee_panel_mint)" };
  }
  if (state === "exhausted") {
    return {
      ok: false,
      code: "standing_exhausted",
      message: `the standing panel has used all ${record.max_uses} of its baselines; mint a fresh picker ticket (referee_panel_mint)`,
    };
  }
  if (state === "expired") {
    return { ok: false, code: "standing_expired", message: `the standing panel expired at ${record.expires_at}; mint a fresh picker ticket (referee_panel_mint)` };
  }
  const clash = standingFamilyConflict(record, { playerFamily: input.playerFamily, sutFamily: input.sutFamily });
  if (clash) {
    return {
      ok: false,
      code: "standing_family_conflict",
      message: clash.reason === "player"
        ? `standing panel judge '${clash.judge_id}' is family '${clash.family}', the same vendor as the calling Player — it can't judge its own work. Mint a fresh picker ticket (referee_panel_mint).`
        : `standing panel judge '${clash.judge_id}' is family '${clash.family}', the same vendor as the model being tested — a judge may favour its own vendor. Mint a fresh picker ticket (referee_panel_mint) with this sut_model.`,
    };
  }
  return { ok: true, uses: record.uses + 1, used_at: nowIso };
}

/** The read-only view referee_panel_status reports. Never carries a secret. */
export interface StandingPanelView {
  standing_panel_id: string;
  state: StandingPanelState;
  uses_left: number;
  max_uses: number;
  expires_at: string;
  confirmed_at: string;
  sut_family: string | null;
  panel: { id: string; family: string; door: string; model: string; effort: string }[];
}

export function standingPanelView(record: StandingPanelRecord, now: string): StandingPanelView {
  return {
    standing_panel_id: record.id,
    state: standingStateAt(record, now),
    uses_left: Math.max(0, record.max_uses - record.uses),
    max_uses: record.max_uses,
    expires_at: record.expires_at,
    confirmed_at: record.confirmation_snapshot.selection.confirmed_at,
    sut_family: record.sut_family,
    panel: record.confirmation_snapshot.resolved.map((judge) => ({
      id: judge.id,
      family: judge.family,
      door: judge.door,
      model: judge.model,
      effort: judge.effort,
    })),
  };
}

/** Validates a stored row's shape; throws on corruption (never guesses). */
export function parseStandingPanelRecord(value: {
  id: unknown;
  tenant_id: unknown;
  source_ticket_id: unknown;
  confirmation_snapshot: unknown;
  sut_family: unknown;
  max_uses: unknown;
  uses: unknown;
  created_at: unknown;
  expires_at: unknown;
  revoked_at: unknown;
  last_used_at: unknown;
}): StandingPanelRecord {
  const text = (v: unknown, field: string): string => {
    if (typeof v !== "string" || v.trim() === "") throw new Error(`standing panel '${field}' must be a non-empty string`);
    return v;
  };
  const maxUses = Number(value.max_uses);
  const uses = Number(value.uses);
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > STANDING_PANEL_MAX_USES) {
    throw new Error("standing panel max_uses is out of range");
  }
  if (!Number.isInteger(uses) || uses < 0 || uses > maxUses) {
    throw new Error("standing panel uses is out of range");
  }
  const created_at = requireIsoish(value.created_at, "created_at");
  const expires_at = requireIsoish(value.expires_at, "expires_at");
  if (Date.parse(expires_at) <= Date.parse(created_at)) {
    throw new Error("standing panel expires_at must be after created_at");
  }
  return {
    id: text(value.id, "id"),
    tenant_id: text(value.tenant_id, "tenant_id"),
    source_ticket_id: text(value.source_ticket_id, "source_ticket_id"),
    confirmation_snapshot: parseConfirmedPanelSnapshot(value.confirmation_snapshot),
    sut_family: value.sut_family == null ? null : text(value.sut_family, "sut_family"),
    max_uses: maxUses,
    uses,
    created_at,
    expires_at,
    revoked_at: value.revoked_at == null ? null : requireIsoish(value.revoked_at, "revoked_at"),
    last_used_at: value.last_used_at == null ? null : requireIsoish(value.last_used_at, "last_used_at"),
  };
}

function requireIsoish(value: unknown, field: string): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error(`standing panel '${field}' must be an ISO timestamp`);
    return value.toISOString();
  }
  return new Date(requireEpoch(value, field)).toISOString();
}

function requireEpoch(value: unknown, field: string): number {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`standing panel '${field}' must be an ISO timestamp`);
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) throw new Error(`standing panel '${field}' must be an ISO timestamp`);
  return epoch;
}
