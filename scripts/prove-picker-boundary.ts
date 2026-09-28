// Live boundary proof for the judge picker: spawns the real stdio MCP server,
// drives it with the MCP SDK client (the same protocol Claude Code / Codex / Cursor
// use), mints a picker ticket, and long-polls referee_panel_status until a human
// confirms in the browser. Nothing is graded, so no judge is called.
//
// Run: npx tsx scripts/prove-picker-boundary.ts
// Env: TITRATION_DATABASE_URL (from .env). Uses project "picker-proof", removed at the end.

import "../server/bootstrap-env";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import postgres from "postgres";
import { postgresOptions } from "../lib/db-connect-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "picker-proof";
const PLAYER = "claude-opus-5-5";
const DEADLINE_MS = 10 * 60 * 1000;

function text(result: any): any {
  const body = result?.content?.[0]?.text ?? "";
  if (result?.isError) throw new Error(body);
  try { return JSON.parse(body); } catch { return body; }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(root, "node_modules/tsx/dist/cli.mjs"), resolve(root, "server/server.ts")],
  cwd: root,
  env: process.env as Record<string, string>,
  stderr: "ignore",
});
const client = new Client({ name: "picker-boundary-proof", version: "1.0.0" });
let failed = false;

try {
  await client.connect(transport);
  const tools = await client.listTools();
  console.log(`server up: ${tools.tools.length} tools`);

  const minted = text(await client.callTool({
    name: "referee_panel_mint",
    arguments: { project: PROJECT, player_model: PLAYER },
  }));
  console.log(`minted ticket ${minted.ticket_id}, expires ${minted.expires_at}`);
  console.log("\nIf no browser tab opened, open this link:\n");
  console.log(minted.picker_url);
  console.log("\nWaiting for a confirmation in the browser…");

  const started = Date.now();
  let status: any = { status: "pending" };
  let laps = 0;
  while (status.status === "pending" && Date.now() - started < DEADLINE_MS) {
    const lapStart = Date.now();
    status = text(await client.callTool(
      { name: "referee_panel_status", arguments: { project: PROJECT, ticket_id: minted.ticket_id, wait_seconds: 25 } },
      undefined,
      { timeout: 60_000 },
    ));
    laps++;
    console.log(`  status lap ${laps}: ${status.status} (${Math.round((Date.now() - lapStart) / 1000)} s)`);
  }

  if (status.status !== "confirmed") {
    failed = true;
    console.log(`\nFAIL: ticket ended as '${status.status}'`);
  } else {
    console.log("\nPASS: confirmed through the MCP client without a timeout");
    console.log(`panel_receipt_id: ${status.panel_receipt_id}`);
    const judges: any[] = Array.isArray(status.panel) ? status.panel : [];
    for (const j of judges) {
      console.log(`  - ${j.id} · ${j.family} · ${j.door} · effort ${j.effort}`);
    }
    const families = new Set(judges.map((j) => j.family));
    if (families.has("anthropic")) { failed = true; console.log("FAIL: Player family on the panel"); }
    if (families.size !== 3) { failed = true; console.log(`FAIL: expected 3 families, got ${families.size}`); }
  }
} catch (e) {
  failed = true;
  console.error("FAIL:", e instanceof Error ? e.message : e);
} finally {
  await client.close().catch(() => {});
  const url = process.env.TITRATION_DATABASE_URL!;
  const sql = postgres(url, postgresOptions(url, process.env));
  await sql`delete from referee_panel_ticket where tenant_id in (select id from tenants where slug = ${PROJECT})`;
  await sql`delete from tenants where slug = ${PROJECT}`;
  await sql.end();
  console.log("cleanup: picker-proof project removed");
  process.exit(failed ? 1 : 0);
}
