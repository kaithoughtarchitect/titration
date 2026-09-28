// Titration MCP — referee-panel picker ticket SQL I/O (the ONE ticket SQL module).
//
// Lifecycle decisions live in referee-panel-ticket-core.ts (offline-tested). This
// layer is postgres only: digest-as-bytea, sql.json snapshot writes, and
// parseConfirmedPanelSnapshot on read. Never persist the browser secret. Worker
// stamp writes used_for_baseline_id only — a failed freeze does not un-claim.

import type { TransactionSql } from "postgres";

import { sql, tenantId, tenantIdForWrite, assertWritable } from "./store";
import {
  isRefereeTicketStatus,
  parseConfirmedPanelSnapshot,
  planClaim,
  planConfirm,
  planMint,
  type ConfirmedPanelSnapshot,
  type RefereePanelTicketRecord,
} from "./referee-panel-ticket-core";
import { isRefereeRunBudget } from "./referee-run-budget-core";

const DIGEST_HEX = /^[0-9a-f]{64}$/;

const TICKET_COLUMNS = sql`
  id,
  tenant_id,
  secret_digest,
  status,
  created_at,
  expires_at,
  consumed_at,
  confirmation_snapshot,
  establish_claimed_at,
  used_for_baseline_id`;

export type RefereePanelTicketFailureCode =
  | "not_found"
  | "expired"
  | "not_confirmed"
  | "used"
  | "different_panel";

export class RefereePanelTicketError extends Error {
  readonly code: RefereePanelTicketFailureCode;

  constructor(code: RefereePanelTicketFailureCode) {
    super(code);
    this.name = "RefereePanelTicketError";
    this.code = code;
  }
}

export interface RefereePanelTicketRow extends RefereePanelTicketRecord {
  id: string;
  tenant_id: string;
}

interface TicketDbRow {
  id: unknown;
  tenant_id: unknown;
  secret_digest: unknown;
  status: unknown;
  created_at: unknown;
  expires_at: unknown;
  consumed_at: unknown;
  confirmation_snapshot: unknown;
  establish_claimed_at: unknown;
  used_for_baseline_id: unknown;
}

export async function mintPending(input: {
  tenantSlug: string;
  secret: string;
  now: string;
  createdByUserId?: string;
}): Promise<RefereePanelTicketRow> {
  // 048 omitted created_by_user_id; workspace membership is authority — never insert it.
  assertWritable(input.tenantSlug);
  const planned = planMint({ secret: input.secret, created_at: input.now });
  const tid = await tenantIdForWrite(input.tenantSlug);
  const digest = digestBytes(planned.digest_hex);
  const [row] = await sql<TicketDbRow[]>`
    insert into referee_panel_ticket (
      tenant_id,
      secret_digest,
      status,
      created_at,
      expires_at
    )
    values (
      ${tid},
      ${digest},
      'pending',
      ${planned.created_at}::timestamptz,
      ${planned.expires_at}::timestamptz
    )
    returning ${TICKET_COLUMNS}`;
  if (!row) {
    throw new Error("referee_panel_ticket insert returned no row");
  }
  return mapRow(row);
}

export async function loadById(input: {
  tenantSlug: string;
  id: string;
}): Promise<RefereePanelTicketRow | null> {
  const tid = await tenantId(input.tenantSlug);
  const [row] = await sql<TicketDbRow[]>`
    select ${TICKET_COLUMNS}
    from referee_panel_ticket
    where id = ${input.id}
      and tenant_id = ${tid}`;
  return row ? mapRow(row) : null;
}

export async function loadBySecretDigest(input: {
  tenantSlug: string;
  digestHex: string;
}): Promise<RefereePanelTicketRow | null> {
  const tid = await tenantId(input.tenantSlug);
  const digest = digestBytes(input.digestHex);
  const [row] = await sql<TicketDbRow[]>`
    select ${TICKET_COLUMNS}
    from referee_panel_ticket
    where secret_digest = ${digest}
      and tenant_id = ${tid}`;
  return row ? mapRow(row) : null;
}

export async function confirm(input: {
  tenantSlug: string;
  id: string;
  snapshot: ConfirmedPanelSnapshot;
  now: string;
}): Promise<RefereePanelTicketRow> {
  assertWritable(input.tenantSlug);
  const tid = await tenantId(input.tenantSlug);
  return sql.begin(async (tx) => {
    const ticket = await loadTicketForUpdate(tx, tid, input.id);
    const plan = planConfirm(ticket, input.snapshot, input.now);
    if (!plan.ok) {
      throw new RefereePanelTicketError(plan.code);
    }
    if (plan.kind === "idempotent") {
      return ticket;
    }
    const snapshot = plan.ticket.confirmation_snapshot;
    if (snapshot == null || plan.ticket.consumed_at == null) {
      throw new Error("confirm apply is missing receipt fields");
    }
    const [updated] = await tx<TicketDbRow[]>`
      update referee_panel_ticket
      set
        status = 'confirmed',
        consumed_at = ${plan.ticket.consumed_at}::timestamptz,
        confirmation_snapshot = ${tx.json(snapshot as any)}
      where id = ${input.id}
        and tenant_id = ${tid}
        and status = 'pending'
        and consumed_at is null
        and confirmation_snapshot is null
      returning ${TICKET_COLUMNS}`;
    if (!updated) {
      throw new RefereePanelTicketError("not_found");
    }
    return mapRow(updated);
  });
}

export async function claimForEstablish(input: {
  tenantSlug: string;
  id: string;
  now: string;
}): Promise<RefereePanelTicketRow> {
  assertWritable(input.tenantSlug);
  const tid = await tenantId(input.tenantSlug);
  return sql.begin(async (tx) => {
    const ticket = await loadTicketForUpdate(tx, tid, input.id);
    const plan = planClaim(ticket, input.now);
    if (!plan.ok) {
      throw new RefereePanelTicketError(plan.code);
    }
    const claimedAt = plan.ticket.establish_claimed_at;
    if (claimedAt == null) {
      throw new Error("claim apply is missing establish_claimed_at");
    }
    const [updated] = await tx<TicketDbRow[]>`
      update referee_panel_ticket
      set establish_claimed_at = ${claimedAt}::timestamptz
      where id = ${input.id}
        and tenant_id = ${tid}
        and status = 'confirmed'
        and establish_claimed_at is null
        and used_for_baseline_id is null
      returning ${TICKET_COLUMNS}`;
    if (!updated) {
      throw new RefereePanelTicketError("used");
    }
    return mapRow(updated);
  });
}

export async function stampUsedForBaseline(input: {
  tenantSlug: string;
  id: string;
  baselineId: string;
}): Promise<RefereePanelTicketRow> {
  assertWritable(input.tenantSlug);
  if (typeof input.baselineId !== "string" || input.baselineId.trim() === "") {
    throw new Error("used_for_baseline_id must be a non-empty string");
  }
  const tid = await tenantId(input.tenantSlug);
  return sql.begin(async (tx) => {
    const ticket = await loadTicketForUpdate(tx, tid, input.id);
    if (ticket.used_for_baseline_id === input.baselineId) {
      return ticket;
    }
    if (ticket.used_for_baseline_id != null) {
      throw new RefereePanelTicketError("used");
    }
    if (ticket.status !== "confirmed" || ticket.establish_claimed_at == null) {
      throw new RefereePanelTicketError("not_confirmed");
    }
    // Worker GRANT is column-limited: SET used_for_baseline_id only. Do not
    // un-claim here — a failed freeze leaves establish_claimed_at set.
    const [updated] = await tx<TicketDbRow[]>`
      update referee_panel_ticket
      set used_for_baseline_id = ${input.baselineId}
      where id = ${input.id}
        and tenant_id = ${tid}
        and status = 'confirmed'
        and establish_claimed_at is not null
        and used_for_baseline_id is null
      returning ${TICKET_COLUMNS}`;
    if (!updated) {
      throw new RefereePanelTicketError("used");
    }
    return mapRow(updated);
  });
}

function digestBytes(digestHex: string): Buffer {
  if (!DIGEST_HEX.test(digestHex)) {
    throw new Error("ticket digest_hex must be 64 lowercase hex chars");
  }
  return Buffer.from(digestHex, "hex");
}

async function loadTicketForUpdate(
  tx: TransactionSql,
  tid: string,
  id: string,
): Promise<RefereePanelTicketRow> {
  const [existing] = await tx<TicketDbRow[]>`
    select ${TICKET_COLUMNS}
    from referee_panel_ticket
    where id = ${id}
      and tenant_id = ${tid}
    for update`;
  if (!existing) {
    throw new RefereePanelTicketError("not_found");
  }
  return mapRow(existing);
}

function mapRow(row: TicketDbRow): RefereePanelTicketRow {
  const status = row.status;
  if (!isRefereeTicketStatus(status)) {
    throw new Error("ticket status must be pending|confirmed|expired");
  }
  const id = requireText(row.id, "id");
  const snapshot = snapshotFromRow(row.confirmation_snapshot, id);
  return {
    id,
    tenant_id: requireText(row.tenant_id, "tenant_id"),
    digest_hex: digestHexFromBytea(row.secret_digest),
    status,
    created_at: iso(row.created_at, "created_at"),
    expires_at: iso(row.expires_at, "expires_at"),
    consumed_at: optionalIso(row.consumed_at, "consumed_at"),
    confirmation_snapshot: snapshot,
    establish_claimed_at: optionalIso(row.establish_claimed_at, "establish_claimed_at"),
    used_for_baseline_id: optionalText(row.used_for_baseline_id, "used_for_baseline_id"),
  };
}

function snapshotFromRow(value: unknown, ticketId: string): ConfirmedPanelSnapshot | null {
  if (value == null) return null;
  // postgres-js returns jsonb parsed; a double-encoded scalar arrives as a string
  // (gotcha #3a). Recover the object defensively — on unparseable input fail
  // open to the raw value, which the core parser then refuses loudly.
  let candidate: unknown = value;
  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value);
    } catch {
      candidate = value;
    }
  }
  // run_budget alone fails open (core parser drops an illegal stored count so
  // legacy rows keep reading) — a present-but-illegal value means version skew
  // or an out-of-band write, and silently costs the run its picked count.
  const storedBudget = (candidate as Record<string, unknown> | null)?.run_budget;
  if (storedBudget != null && !isRefereeRunBudget(storedBudget)) {
    console.error(
      "[referee-panel] stored run_budget dropped (fail-open; run falls back to engine default):",
      JSON.stringify({ ticket_id: ticketId, run_budget: String(storedBudget) }),
    );
  }
  return parseConfirmedPanelSnapshot(candidate);
}

function digestHexFromBytea(value: unknown): string {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new Error("ticket secret_digest must be 32-byte bytea");
  }
  return Buffer.from(value).toString("hex");
}

function iso(value: unknown, field: string): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw new Error(`ticket '${field}' must be an ISO timestamp`);
    }
    return value.toISOString();
  }
  if (typeof value === "string") {
    const epoch = Date.parse(value);
    if (!Number.isFinite(epoch)) {
      throw new Error(`ticket '${field}' must be an ISO timestamp`);
    }
    return new Date(epoch).toISOString();
  }
  throw new Error(`ticket '${field}' must be an ISO timestamp`);
}

function optionalIso(value: unknown, field: string): string | null {
  if (value == null) return null;
  return iso(value, field);
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`ticket '${field}' must be a non-empty string`);
  }
  return value;
}

function optionalText(value: unknown, field: string): string | null {
  if (value == null) return null;
  return requireText(value, field);
}
