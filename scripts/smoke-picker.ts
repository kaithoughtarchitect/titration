// Titration MCP (OSS) — live DB smoke test for the local referee-panel
// picker. NOT part of the offline unit suite (run-tests.mjs only globs
// lib/__tests__/*.test.ts) — this needs a real Postgres (npm run setup already
// applied) and is invoked directly, WITHOUT an OpenRouter key and WITHOUT ever
// opening a real browser (an injected no-op opener stands in): mint's DB write
// is real, but no model is ever called and no window is ever opened.
//
// Proves (task item 7): mint -> fetch the page (200, contains real roster
// rows) -> POST /confirm with a legal 3-distinct-family pick, built directly
// from judges-roster.json rows (the SAME verified rows exist whether or not
// OPENROUTER_API_KEY is set — availability only gates the picker page's UI
// hints, never validatePick's server-side re-check, so this smoke proves the
// PROTOCOL, not live availability) -> a status read reports confirmed -> a
// second POST is refused 409 -> cleanup (deletes the smoke tenant, which
// cascades its ticket rows) -> the local http server is closed.
//
// Run: TITRATION_DATABASE_URL=postgres://... OPENROUTER_API_KEY= \
//      npx tsx scripts/smoke-picker.ts

import "../server/bootstrap-env";

import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { postgresOptions } from "../lib/db-connect-core";
import { close as closeStorePool } from "../lib/store";
import { mintPending, loadById } from "../lib/referee-panel-ticket";
import { statusAt } from "../lib/referee-panel-ticket-core";
import { loadRoster, detectCliAvailability, hasOpenRouterKey } from "../lib/judges-roster";
import { resolvePlayerFamilyOrThrow } from "../lib/judges-roster-core";
import { mintPicker, closeActivePicker } from "../server/picker/server";

const SMOKE_PROJECT = "smoke-picker";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : `  — ${detail}`}`);
  if (!condition) failures++;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.TITRATION_DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("Set TITRATION_DATABASE_URL before running scripts/smoke-picker.ts.");
    process.exit(1);
  }

  // Verification connection, separate from lib/store.ts's own pool (mirrors
  // scripts/smoke-jobs.ts) — this smoke can inspect/clean up the tenant row
  // directly without going through the functions it is testing.
  const verify = postgres(databaseUrl, postgresOptions(databaseUrl, process.env));

  async function deleteSmokeProject(): Promise<void> {
    const [t] = await verify`select id from tenants where slug = ${SMOKE_PROJECT}`;
    if (!t) return;
    await verify`delete from referee_panel_ticket where tenant_id = ${t.id}`;
    await verify`delete from tenants where id = ${t.id}`;
  }

  let openedUrl: string | null = null;

  try {
    await deleteSmokeProject();
    const [preExisting] = await verify`select id from tenants where slug = ${SMOKE_PROJECT}`;
    check("pre-clean: the smoke project does not exist yet", preExisting === undefined);

    // ── referee_panel_mint (the SAME calls server/mcp-server.ts's handler makes) ──
    const playerModel = "claude-opus-5-5";
    const playerFamily = resolvePlayerFamilyOrThrow(playerModel);
    check("resolvePlayerFamilyOrThrow resolves the smoke Player to 'anthropic'", playerFamily === "anthropic", playerFamily);

    const secret = randomBytes(16).toString("hex");
    const ticket = await mintPending({ tenantSlug: SMOKE_PROJECT, secret, now: new Date().toISOString() });
    check("mintPending wrote a real pending ticket row", ticket.status === "pending");

    const roster = await loadRoster();
    const [available, keyed] = await Promise.all([
      detectCliAvailability(),
      Promise.resolve(hasOpenRouterKey()),
    ]);
    const { url, port } = await mintPicker(
      {
        tenantSlug: SMOKE_PROJECT,
        ticketId: ticket.id,
        token: secret,
        expiresAt: ticket.expires_at,
        playerModel,
        playerFamily,
        roster,
        available,
        hasOpenRouterKey: keyed,
      },
      { openBrowser: (u) => { openedUrl = u; } },
    );
    const browserWasOpenedWithThisUrl: boolean = openedUrl === url;
    check(
      "mintPicker bound a real 127.0.0.1 server and never opened a real browser",
      browserWasOpenedWithThisUrl && url.startsWith(`http://127.0.0.1:${port}/?token=`),
    );

    // ── GET the picker page ──
    const getRes = await fetch(url);
    const getBody = await getRes.text();
    check("GET the picker page returns 200", getRes.status === 200, String(getRes.status));
    check(
      "the page embeds the real judges-roster.json rows (not a fixture)",
      roster.judges.every((row) => getBody.includes(row.id)),
    );
    check(
      "the page inlines the deck's three typefaces (no external font request)",
      (getBody.match(/@font-face/g) ?? []).length === 3 && !getBody.includes("fonts.googleapis.com"),
    );

    // ── POST /confirm: 3 verified, distinct-family rows straight from the roster,
    // excluding the Player's own family (anthropic). This smoke tests the PROTOCOL
    // (token/origin/JSON/one-shot/TTL + the server-side re-validation), not live
    // availability — validatePick never checks "available", only "verified" +
    // distinct-family + effort legality, so this pick is legal whether or not
    // OPENROUTER_API_KEY is set.
    const verifiedNonAnthropic = roster.judges.filter((row) => row.verified && row.family !== playerFamily);
    const byFamily = new Map<string, typeof verifiedNonAnthropic[number]>();
    for (const row of verifiedNonAnthropic) {
      if (!byFamily.has(row.family)) byFamily.set(row.family, row);
    }
    const chosen = [...byFamily.values()].slice(0, 3);
    check("the roster offers >=3 verified non-Player families to build a legal pick from", chosen.length === 3, String(chosen.length));

    const origin = new URL(url).origin;
    const pickBody = {
      token: secret,
      judges: chosen.map((row) => ({ id: row.id, effort: row.efforts.includes("high") ? "high" : row.efforts[0] })),
    };
    const confirmRes = await fetch(`${origin}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(pickBody),
    });
    const confirmBody = await confirmRes.text();
    check("POST /confirm with a legal pick returns 200", confirmRes.status === 200, confirmBody);

    // ── referee_panel_status equivalent (the same read + statusAt derivation the
    // MCP tool handler runs) ──
    const afterConfirm = await loadById({ tenantSlug: SMOKE_PROJECT, id: ticket.id });
    check("loadById reads the ticket back after the real HTTP confirm", afterConfirm !== null);
    const status = afterConfirm ? statusAt(afterConfirm, new Date().toISOString()) : null;
    check("the ticket status is now confirmed", status === "confirmed", String(status));
    check(
      "the confirmed snapshot carries exactly the 3 chosen judges",
      afterConfirm?.confirmation_snapshot?.resolved.map((j) => j.id).sort().join(",")
        === chosen.map((row) => row.id).sort().join(","),
      JSON.stringify(afterConfirm?.confirmation_snapshot?.resolved),
    );

    // ── one-shot: a second POST is refused 409 ──
    const secondRes = await fetch(`${origin}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(pickBody),
    });
    check("a second POST /confirm is refused 409", secondRes.status === 409, String(secondRes.status));
  } finally {
    await closeActivePicker();
    await deleteSmokeProject();
    const [afterCleanup] = await verify`select id from tenants where slug = ${SMOKE_PROJECT}`;
    check("cleanup deleted the smoke project's tenant row (cascading its ticket rows)", afterCleanup === undefined);
    await verify.end();
    await closeStorePool();
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  smoke-picker (${failures} failing check(s))`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
