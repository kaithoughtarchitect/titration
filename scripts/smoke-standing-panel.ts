// Titration MCP (OSS) — live DB smoke test for the standing referee panel.
// NOT part of the offline unit suite; needs a real Postgres with
// db/002_referee_standing_panel.sql applied (npm run migrate), and is invoked
// directly WITHOUT an OpenRouter key and WITHOUT opening a real browser (an
// injected no-op opener stands in). No model is ever called.
//
// Proves: mint -> a real POST /confirm WITH "keep this panel" ticked creates
// exactly one standing panel in the confirm transaction -> a confirm WITHOUT
// the box creates none -> claimStandingPanelUse spends uses under a row lock
// until exhausted -> the Player's family and a SUT family on the panel are
// refused without spending a use -> a newer standing panel revokes the older
// one -> referee_panel_revoke's revokeStandingPanels closes it -> cleanup.
//
// Run: TITRATION_DATABASE_URL=postgres://... OPENROUTER_API_KEY= \
//      npx tsx scripts/smoke-standing-panel.ts

import "../server/bootstrap-env";

import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { postgresOptions } from "../lib/db-connect-core";
import { close as closeStorePool } from "../lib/store";
import { mintPending } from "../lib/referee-panel-ticket";
import {
  claimStandingPanelUse,
  loadLatestStandingPanel,
  revokeStandingPanels,
} from "../lib/referee-standing-panel";
import { standingStateAt } from "../lib/referee-standing-panel-core";
import { loadRoster } from "../lib/judges-roster";
import { resolvePlayerFamilyOrThrow } from "../lib/judges-roster-core";
import { mintPicker, closeActivePicker } from "../server/picker/server";

const SMOKE_PROJECT = "smoke-standing-panel";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : `  — ${detail}`}`);
  if (!condition) failures++;
}

async function refusedWith(code: string, run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (error) {
    return error instanceof Error && error.message.startsWith(`${code}:`);
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.TITRATION_DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("Set TITRATION_DATABASE_URL before running scripts/smoke-standing-panel.ts.");
    process.exit(1);
  }
  const verify = postgres(databaseUrl, postgresOptions(databaseUrl, process.env));

  async function deleteSmokeProject(): Promise<void> {
    const [t] = await verify`select id from tenants where slug = ${SMOKE_PROJECT}`;
    if (!t) return;
    await verify`delete from referee_standing_panel where tenant_id = ${t.id}`;
    await verify`delete from referee_panel_ticket where tenant_id = ${t.id}`;
    await verify`delete from tenants where id = ${t.id}`;
  }

  const playerModel = "claude-opus-5-5";
  const playerFamily = resolvePlayerFamilyOrThrow(playerModel);
  const roster = await loadRoster();
  const verified = roster.judges.filter((row) => row.verified && row.family !== playerFamily);
  const byFamily = new Map<string, typeof verified[number]>();
  for (const row of verified) if (!byFamily.has(row.family)) byFamily.set(row.family, row);
  const chosen = [...byFamily.values()].slice(0, 3);

  async function confirmOnce(standing: { uses: number; hours: number } | null, sutFamily: string | null): Promise<string> {
    const secret = randomBytes(16).toString("hex");
    const ticket = await mintPending({ tenantSlug: SMOKE_PROJECT, secret, now: new Date().toISOString() });
    const { url } = await mintPicker(
      {
        tenantSlug: SMOKE_PROJECT,
        ticketId: ticket.id,
        token: secret,
        expiresAt: ticket.expires_at,
        playerModel,
        playerFamily,
        sutFamily: sutFamily as never,
        roster,
        available: { claude: false, codex: false, grok: false },
        hasOpenRouterKey: false,
        standingSuggestedUses: standing?.uses ?? null,
      },
      { openBrowser: () => {} },
    );
    const origin = new URL(url).origin;
    const res = await fetch(`${origin}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ token: secret, judges: chosen.map((row) => ({ id: row.id })), standing }),
    });
    check(`POST /confirm (standing ${JSON.stringify(standing)}) is accepted`, res.status === 200, `${res.status} ${await res.text()}`);
    await closeActivePicker();
    return ticket.id;
  }

  try {
    await deleteSmokeProject();
    check("roster offers 3 verified non-Player families", chosen.length === 3, chosen.map((r) => r.family).join(","));
    const sutFamily = verified.find((row) => !chosen.some((c) => c.family === row.family))?.family ?? null;

    // ── confirm WITHOUT the box: no standing panel ──
    await confirmOnce(null, null);
    check("a confirm without the box creates no standing panel", (await loadLatestStandingPanel({ tenantSlug: SMOKE_PROJECT })) === null);
    check(
      "claiming with no standing panel refuses no_standing_panel",
      await refusedWith("no_standing_panel", () => claimStandingPanelUse({ tenantSlug: SMOKE_PROJECT, now: new Date().toISOString(), playerFamily, sutFamily: null })),
    );

    // ── confirm WITH the box: one standing panel, 2 uses ──
    const ticketA = await confirmOnce({ uses: 2, hours: 8 }, sutFamily);
    const standingA = await loadLatestStandingPanel({ tenantSlug: SMOKE_PROJECT });
    check(
      "a ticked confirm creates one active standing panel tied to its ticket",
      standingA !== null && standingA.source_ticket_id === ticketA && standingA.max_uses === 2 && standingA.uses === 0
        && standingA.sut_family === sutFamily && standingStateAt(standingA, new Date().toISOString()) === "active",
      JSON.stringify(standingA),
    );
    const hours = standingA ? (Date.parse(standingA.expires_at) - Date.parse(standingA.created_at)) / 3_600_000 : 0;
    check("its expiry is the human's 8 hours", hours === 8, String(hours));

    // ── family refusals do not spend a use ──
    const onPanel = chosen[0]!.family;
    check(
      "a Player whose family sits on the panel is refused",
      await refusedWith("standing_family_conflict", () => claimStandingPanelUse({ tenantSlug: SMOKE_PROJECT, now: new Date().toISOString(), playerFamily: onPanel, sutFamily: null })),
    );
    check(
      "a SUT family on the panel is refused",
      await refusedWith("standing_family_conflict", () => claimStandingPanelUse({ tenantSlug: SMOKE_PROJECT, now: new Date().toISOString(), playerFamily, sutFamily: onPanel })),
    );
    check("refusals spent no use", (await loadLatestStandingPanel({ tenantSlug: SMOKE_PROJECT }))?.uses === 0);

    // ── spend until exhausted ──
    const first = await claimStandingPanelUse({ tenantSlug: SMOKE_PROJECT, now: new Date().toISOString(), playerFamily, sutFamily: null });
    const second = await claimStandingPanelUse({ tenantSlug: SMOKE_PROJECT, now: new Date().toISOString(), playerFamily, sutFamily: null });
    check("two claims spend two uses", first.uses === 1 && second.uses === 2 && second.last_used_at !== null);
    check(
      "a third claim refuses standing_exhausted",
      await refusedWith("standing_exhausted", () => claimStandingPanelUse({ tenantSlug: SMOKE_PROJECT, now: new Date().toISOString(), playerFamily, sutFamily: null })),
    );

    // ── a newer standing panel supersedes; revoke closes it ──
    await confirmOnce({ uses: 3, hours: 1 }, null);
    const rows = await verify`
      select id, revoked_at from referee_standing_panel
      where tenant_id = (select id from tenants where slug = ${SMOKE_PROJECT})
      order by created_at`;
    check("a newer standing panel revokes the older one (one open per project)", rows.length === 2 && rows[0]!.revoked_at !== null && rows[1]!.revoked_at === null);
    const revoked = await revokeStandingPanels({ tenantSlug: SMOKE_PROJECT, now: new Date().toISOString() });
    check("revokeStandingPanels closes the open one", revoked.revoked === 1);
    check(
      "a claim after revoke refuses standing_revoked",
      await refusedWith("standing_revoked", () => claimStandingPanelUse({ tenantSlug: SMOKE_PROJECT, now: new Date().toISOString(), playerFamily, sutFamily: null })),
    );
    check("an unknown project reads as no standing panel", (await loadLatestStandingPanel({ tenantSlug: "smoke-standing-panel-none" })) === null);
  } finally {
    await closeActivePicker();
    await deleteSmokeProject();
    await verify.end();
    await closeStorePool();
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  smoke-standing-panel (${failures} failing check(s))`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
