// Titration MCP — standing referee panel SQL I/O.
//
// Lifecycle decisions live in referee-standing-panel-core.ts (offline-tested).
// There is deliberately NO public "create" here: a standing panel is inserted
// only by lib/referee-panel-ticket.ts's `confirm`, inside the transaction that
// records the human's picker confirmation (insertStandingPanelInTx below).

import type { TransactionSql } from "postgres";

import { sql, assertWritable } from "./store";
import {
  parseStandingPanelRecord,
  planStandingUse,
  standingExpiresAt,
  type StandingPanelRecord,
  type StandingPanelRequest,
  type StandingUseRefusalCode,
} from "./referee-standing-panel-core";
import type { ConfirmedPanelSnapshot } from "./referee-panel-ticket-core";

const STANDING_COLUMNS = sql`
  id,
  tenant_id,
  source_ticket_id,
  confirmation_snapshot,
  sut_family,
  max_uses,
  uses,
  created_at,
  expires_at,
  revoked_at,
  last_used_at`;

export type StandingPanelFailureCode = "no_standing_panel" | StandingUseRefusalCode;

export class StandingPanelError extends Error {
  readonly code: StandingPanelFailureCode;

  // The message leads with the code so an agent reading only the tool error
  // text still sees which refusal it hit (and that the fallback is a new ticket).
  constructor(code: StandingPanelFailureCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "StandingPanelError";
    this.code = code;
  }
}

type StandingDbRow = Parameters<typeof parseStandingPanelRecord>[0];

function mapRow(row: StandingDbRow): StandingPanelRecord {
  let snapshot: unknown = row.confirmation_snapshot;
  // postgres-js returns jsonb parsed; a double-encoded value arrives as a string.
  if (typeof snapshot === "string") {
    try { snapshot = JSON.parse(snapshot); } catch { /* the core parser refuses it loudly */ }
  }
  return parseStandingPanelRecord({ ...row, confirmation_snapshot: snapshot });
}

/**
 * Called ONLY from referee-panel-ticket.ts's confirm transaction, after the
 * source ticket moved pending -> confirmed. Revokes any other still-open
 * standing panel for the tenant first, so a project has at most one.
 */
export async function insertStandingPanelInTx(
  tx: TransactionSql,
  input: {
    tid: string;
    sourceTicketId: string;
    snapshot: ConfirmedPanelSnapshot;
    sutFamily: string | null;
    standing: StandingPanelRequest;
    now: string;
  },
): Promise<StandingPanelRecord> {
  const expiresAt = standingExpiresAt(input.now, input.standing.hours);
  await tx`
    update referee_standing_panel
    set revoked_at = ${input.now}::timestamptz
    where tenant_id = ${input.tid}
      and revoked_at is null`;
  const [row] = await tx<StandingDbRow[]>`
    insert into referee_standing_panel (
      tenant_id, source_ticket_id, confirmation_snapshot, sut_family,
      max_uses, uses, created_at, expires_at
    )
    values (
      ${input.tid}, ${input.sourceTicketId}, ${tx.json(input.snapshot as any)}, ${input.sutFamily},
      ${input.standing.uses}, 0, ${input.now}::timestamptz, ${expiresAt}::timestamptz
    )
    returning ${STANDING_COLUMNS}`;
  if (!row) throw new Error("referee_standing_panel insert returned no row");
  return mapRow(row);
}

/** The newest standing panel for the project, whatever its state (null when none was ever made). */
export async function loadLatestStandingPanel(input: { tenantSlug: string }): Promise<StandingPanelRecord | null> {
  // An unknown project is empty, not an error: the subquery yields no tenant.
  const [row] = await sql<StandingDbRow[]>`
    select ${STANDING_COLUMNS}
    from referee_standing_panel
    where tenant_id = (select id from tenants where slug = ${input.tenantSlug})
    order by created_at desc
    limit 1`;
  return row ? mapRow(row) : null;
}

/**
 * Spend one use of the project's newest standing panel, under a row lock,
 * BEFORE any judge spend. Refuses (typed) when there is none, or it is
 * revoked / exhausted / expired, or a Player/SUT family clash exists.
 */
export async function claimStandingPanelUse(input: {
  tenantSlug: string;
  now: string;
  playerFamily: string | null;
  sutFamily: string | null;
}): Promise<StandingPanelRecord> {
  assertWritable(input.tenantSlug);
  return sql.begin(async (tx) => {
    const [row] = await tx<StandingDbRow[]>`
      select ${STANDING_COLUMNS}
      from referee_standing_panel
      where tenant_id = (select id from tenants where slug = ${input.tenantSlug})
      order by created_at desc
      limit 1
      for update`;
    if (!row) {
      throw new StandingPanelError(
        "no_standing_panel",
        "this project has no standing judge panel; mint a picker ticket (referee_panel_mint) and let the human tick 'keep this panel'",
      );
    }
    const record = mapRow(row);
    const plan = planStandingUse(record, input);
    if (!plan.ok) throw new StandingPanelError(plan.code, plan.message);
    const [updated] = await tx<StandingDbRow[]>`
      update referee_standing_panel
      set uses = ${plan.uses}, last_used_at = ${plan.used_at}::timestamptz
      where id = ${record.id}
        and revoked_at is null
        and uses = ${record.uses}
      returning ${STANDING_COLUMNS}`;
    if (!updated) throw new StandingPanelError("standing_exhausted", "the standing panel changed while claiming; retry");
    return mapRow(updated);
  });
}

/** Revoke the project's open standing panel(s). Safe direction: only ever removes reuse. */
export async function revokeStandingPanels(input: { tenantSlug: string; now: string }): Promise<{ revoked: number }> {
  assertWritable(input.tenantSlug);
  const rows = await sql`
    update referee_standing_panel
    set revoked_at = ${input.now}::timestamptz
    where tenant_id = (select id from tenants where slug = ${input.tenantSlug})
      and revoked_at is null
    returning id`;
  return { revoked: rows.length };
}
