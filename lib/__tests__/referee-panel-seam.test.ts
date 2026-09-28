// Titration MCP — local referee-panel seam test (real HTTP on 127.0.0.1, no DB, no
// network egress, no model call — $0). Proves the FULL local mint -> confirm ->
// status -> establish loop end to end, with the ticket table replaced by an
// in-memory store built on the SAME pure lifecycle functions
// (referee-panel-ticket-core.ts's planMint/planConfirm/planClaim) the real
// Postgres-backed lib/referee-panel-ticket.ts wraps — so this is a faithful
// proof of the wiring, not a reimplementation of the rules under test.
//
// mint (injected ticket store + injected no-op browser opener + a REAL
// http.Server on 127.0.0.1) -> a real POST /confirm with the token -> a
// (locally simulated) referee_panel_status read reports confirmed -> establish
// claims the receipt once via the SAME store (a second claim refuses "used").
// A stub judge panel runner stands in for the judges — no model is ever called.
//
// Run: npx tsx lib/__tests__/referee-panel-seam.test.ts

import { validateRoster, type Roster } from "../judges-roster-core";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  planClaim,
  planConfirm,
  planMint,
  statusAt,
  type ConfirmedPanelSnapshot,
  type RefereePanelTicketRecord,
} from "../referee-panel-ticket-core";
import type { EstablishDependencies } from "../verify";
import type { NewBaseline } from "../baseline";

// lib/referee-panel-ticket.ts / server/picker/server.ts / lib/verify.ts / lib/judge.ts
// all transitively reach lib/store.ts (postgres pool), which throws at import time
// without TITRATION_DATABASE_URL set — set it BEFORE any of their VALUE imports run
// (module-level `import` is hoisted ahead of ordinary statements, so this must be a
// dynamic `await import()` after the assignment, exactly like verify.test.ts /
// oss-surface.test.ts). Nothing here ever opens a real socket to this URL.
process.env.TITRATION_DATABASE_URL ??= "postgres://127.0.0.1:1/titration-offline-import-only";
const { RefereePanelTicketError } = await import("../referee-panel-ticket");
const { mintPicker, closeActivePicker } = await import("../../server/picker/server");
const { establishWithDependencies } = await import("../verify");
const { DEFAULT_PANEL } = await import("../judge");

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail = ""): void {
  total++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}

const here = dirname(fileURLToPath(import.meta.url));
const rosterPath = join(here, "..", "..", "judges-roster.json");
const roster: Roster = validateRoster(JSON.parse(readFileSync(rosterPath, "utf8")));

// ── in-memory ticket store, built on the real pure lifecycle functions ───────
interface FakeRow extends RefereePanelTicketRecord {
  id: string;
  tenant_id: string;
}

class FakeTicketStore {
  private rows = new Map<string, FakeRow>();
  private nextId = 1;

  async mintPending(input: { tenantSlug: string; secret: string; now: string }): Promise<FakeRow> {
    const record = planMint({ secret: input.secret, created_at: input.now });
    const row: FakeRow = { ...record, id: `ticket-${this.nextId++}`, tenant_id: input.tenantSlug };
    this.rows.set(row.id, row);
    return row;
  }

  async confirm(input: { tenantSlug: string; id: string; snapshot: ConfirmedPanelSnapshot; now: string }): Promise<FakeRow> {
    const existing = this.rows.get(input.id);
    if (!existing || existing.tenant_id !== input.tenantSlug) {
      throw new RefereePanelTicketError("not_found");
    }
    const plan = planConfirm(existing, input.snapshot, input.now);
    if (!plan.ok) throw new RefereePanelTicketError(plan.code);
    const updated: FakeRow = { ...plan.ticket, id: existing.id, tenant_id: existing.tenant_id };
    this.rows.set(input.id, updated);
    return updated;
  }

  async loadById(input: { tenantSlug: string; id: string }): Promise<FakeRow | null> {
    const row = this.rows.get(input.id);
    if (!row || row.tenant_id !== input.tenantSlug) return null;
    return row;
  }

  async claimForEstablish(input: { tenantSlug: string; id: string; now: string }): Promise<FakeRow> {
    const existing = this.rows.get(input.id);
    if (!existing || existing.tenant_id !== input.tenantSlug) {
      throw new RefereePanelTicketError("not_found");
    }
    const plan = planClaim(existing, input.now);
    if (!plan.ok) throw new RefereePanelTicketError(plan.code);
    const updated: FakeRow = { ...plan.ticket, id: existing.id, tenant_id: existing.tenant_id };
    this.rows.set(input.id, updated);
    return updated;
  }
}

async function main(): Promise<void> {
  const store = new FakeTicketStore();
  const tenantSlug = "demo";
  const secret = "seam-test-secret-0123456789abcdef";
  const now = "2026-09-26T00:00:00.000Z";

  const ticket = await store.mintPending({ tenantSlug, secret, now });
  check("mint produced a pending ticket", ticket.status === "pending");

  let openedUrl: string | null = null;
  const { url, port } = await mintPicker(
    {
      tenantSlug,
      ticketId: ticket.id,
      token: secret,
      expiresAt: ticket.expires_at,
      playerModel: "claude-opus-5-5",
      playerFamily: "anthropic",
      roster,
      available: { claude: false, codex: false, grok: false },
      hasOpenRouterKey: true,
    },
    {
      confirmTicket: (input) => store.confirm(input),
      openBrowser: (u) => { openedUrl = u; },
      now: () => Date.parse(now),
    },
  );

  try {
    check("mintPicker never opens the browser itself (only via the injected port)", openedUrl === url, String(openedUrl));
    check("picker_url is a 127.0.0.1 loopback URL carrying the token", url === `http://127.0.0.1:${port}/?token=${secret}`);

    // ── real GET: the standalone picker page ──
    const getRes = await fetch(url);
    const getBody = await getRes.text();
    check("GET the picker page returns 200", getRes.status === 200, String(getRes.status));
    check("the page embeds the roster page model", getBody.includes("window.__PICKER__="), getBody.slice(0, 200));
    check("the page lists a real roster judge by name", getBody.includes("Grok"), getBody.slice(0, 200));

    // ── real POST /confirm: 3 verified judges from 3 distinct families, none anthropic ──
    const origin = new URL(url).origin;
    const pick = {
      token: secret,
      judges: [
        { id: "x-ai/grok-4.7", effort: "high" },
        { id: "openai/gpt-6-sol", effort: "medium" },
        { id: "google/gemini-3.8-flash", effort: "low" },
      ],
    };

    // Refusals BEFORE the ticket is ever accepted — proven against the SAME
    // running server (would 200 if a gate were missing/broken). Order matters:
    // once one POST is accepted, "409 for any later POST" fires unconditionally
    // even for a request that would otherwise fail a different check, so
    // these must run first.
    const wrongTokenRes = await fetch(`${origin}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ ...pick, token: "not-the-real-token" }),
    });
    check("a POST with the wrong token is refused 403 (ticket still unspent)", wrongTokenRes.status === 403, String(wrongTokenRes.status));
    const noOriginRes = await fetch(`${origin}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(pick),
    });
    check("a POST with no Origin header is refused 403 (ticket still unspent)", noOriginRes.status === 403, String(noOriginRes.status));
    const nonJsonRes = await fetch(`${origin}/confirm`, {
      method: "POST",
      headers: { "content-type": "text/plain", origin },
      body: JSON.stringify(pick),
    });
    check("a non-JSON content-type POST is refused 415", nonJsonRes.status === 415, String(nonJsonRes.status));

    const confirmRes = await fetch(`${origin}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(pick),
    });
    const confirmBody = await confirmRes.text();
    check("POST /confirm with the token and a legal pick returns 200", confirmRes.status === 200, confirmBody);

    // A second POST — even a well-formed one, from the right origin with the
    // right token — must now be refused: the ticket is already accepted
    // (one-shot; "409 for any later POST" fires unconditionally once one
    // POST has landed).
    const secondRes = await fetch(`${origin}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(pick),
    });
    check("a second POST /confirm is refused 409 (one-shot)", secondRes.status === 409, String(secondRes.status));

    // ── referee_panel_status semantics: read the row back and derive status ──
    const afterConfirm = await store.loadById({ tenantSlug, id: ticket.id });
    check("the ticket row reads back confirmed after the real HTTP confirm", afterConfirm?.status === "confirmed");
    const derivedStatus = afterConfirm ? statusAt(afterConfirm, "2026-09-26T00:01:00.000Z") : null;
    check("referee_panel_status's statusAt reports confirmed", derivedStatus === "confirmed");
    check(
      "the confirmed snapshot carries the 3 picked judges with their chosen efforts",
      afterConfirm?.confirmation_snapshot?.resolved.map((j) => `${j.id}:${j.effort}`).join(",")
        === "x-ai/grok-4.7:high,openai/gpt-6-sol:medium,google/gemini-3.8-flash:low",
      JSON.stringify(afterConfirm?.confirmation_snapshot),
    );
    check(
      "the confirmed snapshot's selection names this ticket as receipt_id and the resolved Player family",
      afterConfirm?.confirmation_snapshot?.selection.receipt_id === ticket.id
        && afterConfirm?.confirmation_snapshot?.selection.player_family === "anthropic",
    );

    // ── establish_baseline claims the receipt ONCE — a stub judge panel, no model call ──
    const inserted: NewBaseline[] = [];
    const stamps: { id: string; baselineId: string }[] = [];
    let panelCalls = 0;
    const dependencies: EstablishDependencies = {
      activePanel: () => DEFAULT_PANEL,
      runPanel: async (_system, _user, panel) => {
        panelCalls++;
        return {
          ok: (panel ?? []).map((judge) => ({
            id: judge.id,
            family: judge.family,
            model: judge.model,
            json: { reasoning: "bug present", verdict: "fail", confidence: "high" },
          })),
          failed: [],
        };
      },
      insertBaseline: async (_tenant, row) => {
        inserted.push(row);
        return { baseline_id: "seam-baseline-1" };
      },
      hasPerRowColumn: async () => true,
      maybeDraftRefusalCandidate: async () => {},
      loadConfirmedReceipt: async (input) => {
        const row = await store.claimForEstablish({ tenantSlug: input.tenantSlug, id: input.id, now: "2026-09-26T00:02:00.000Z" });
        if (row.confirmation_snapshot == null) throw new RefereePanelTicketError("not_confirmed");
        return { id: row.id, confirmation_snapshot: row.confirmation_snapshot };
      },
      stampUsedForBaseline: async (input) => {
        stamps.push({ id: input.id, baselineId: input.baselineId });
      },
      resolveEnvJudgePanel: async () => {
        throw new Error("resolveEnvJudgePanel should not run when panel_receipt_id is supplied");
      },
    };

    const firstResult = await establishWithDependencies(dependencies, {
      tenant: tenantSlug,
      goal: "remove the synthetic failure",
      rubric: "Fail only when the output contains BUG.",
      baseline_outputs: [
        { id: "row-1", mode: "all", output: "BUG ONE" },
        { id: "row-2", mode: "all", output: "BUG TWO" },
        { id: "row-3", mode: "all", output: "BUG THREE" },
      ],
      player_model: "claude-opus-5-5",
      panel_receipt_id: ticket.id,
      thresholds: { min_n: 2, min_abs: 1, min_rate: 0.1 },
    });
    check(
      "establish_baseline claims the confirmed receipt and freezes against the picked panel",
      firstResult.reproduced === true && firstResult.baseline_id === "seam-baseline-1" && panelCalls === 3,
      JSON.stringify({ firstResult, panelCalls }),
    );
    check(
      "the frozen baseline's judge_panel is a selected-panel-lock naming this ticket's id",
      inserted[0]?.judge_panel?.source === "selected-panel-lock"
        && (inserted[0]?.judge_panel as any)?.selection?.receipt_id === ticket.id,
      JSON.stringify(inserted[0]?.judge_panel),
    );
    check(
      "the sync path stamps used_for_baseline_id after the freeze",
      stamps.length === 1 && stamps[0]?.id === ticket.id && stamps[0]?.baselineId === "seam-baseline-1",
      JSON.stringify(stamps),
    );

    const secondErr = await establishWithDependencies(dependencies, {
      tenant: tenantSlug,
      goal: "remove the synthetic failure",
      rubric: "Fail only when the output contains BUG.",
      baseline_outputs: [
        { id: "row-1", mode: "all", output: "BUG ONE" },
        { id: "row-2", mode: "all", output: "BUG TWO" },
        { id: "row-3", mode: "all", output: "BUG THREE" },
      ],
      player_model: "claude-opus-5-5",
      panel_receipt_id: ticket.id,
      thresholds: { min_n: 2, min_abs: 1, min_rate: 0.1 },
    }).then(
      () => null,
      (e: unknown) => (e instanceof RefereePanelTicketError ? e.code : String(e)),
    );
    check(
      "a second establish_baseline against the SAME receipt is refused 'used' (one-use claim)",
      secondErr === "used",
      String(secondErr),
    );
    check(
      "the refused second claim never re-graded or re-inserted a baseline",
      inserted.length === 1 && panelCalls === 3,
      `inserted=${inserted.length} panelCalls=${panelCalls}`,
    );
  } finally {
    await closeActivePicker();
  }

  console.log(`${failures === 0 ? "PASS" : "FAIL"} ${total - failures}/${total}`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
