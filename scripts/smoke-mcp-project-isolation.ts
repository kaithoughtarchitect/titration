// Direct stdio + PostgreSQL proof; excluded from the offline suite.
// Requires an exclusively used, disposable, schema-ready database and explicit
// user permission for scratch writes and the unchanged server startup job sweep.
// Set TITRATION_SMOKE_DATABASE_URL and TITRATION_SMOKE_CONFIRM_DATABASE (exact
// database name), then: node --import tsx scripts/smoke-mcp-project-isolation.ts
// Retains one scratch card/run. No provisioning, migrations, cleanup, or models.
import { randomInt, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import postgres from "postgres";
import { postgresOptions } from "../lib/db-connect-core";
import { canonicalizeCard } from "../lib/card-contract-core";

let checks = 0;
// Sibling smoke check helpers are private and continue after failures. This proof
// must stop on the first unexpected result, before any further fixture writes.
function check(name: string, condition: boolean): void {
  if (!condition) throw new Error(`SMOKE_ASSERTION_FAILED: ${name}`);
  checks++;
  console.log(`PASS  ${name}`);
}

type Snapshot = Record<string, string[]>;
async function main(): Promise<void> {
  // No bootstrap import: refuse before creating a pool or launching a child.
  const databaseUrl = process.env.TITRATION_SMOKE_DATABASE_URL;
  const confirmation = process.env.TITRATION_SMOKE_CONFIRM_DATABASE;
  if (!databaseUrl || !confirmation) {
    throw new Error("SMOKE_DATABASE_REQUIRED: set both explicit smoke database inputs; no connection or child started");
  }
  let parsed: URL;
  try { parsed = new URL(databaseUrl); }
  catch { throw new Error("SMOKE_DATABASE_INVALID: expected a PostgreSQL URL"); }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)
      || decodeURIComponent(parsed.pathname.slice(1)) !== confirmation
      || parsed.search || parsed.hash) {
    throw new Error("SMOKE_DATABASE_MISMATCH: exact database confirmation and a URL without query/fragment required");
  }
  const sql = postgres(databaseUrl, {
    ...postgresOptions(databaseUrl, {}), max: 1, connect_timeout: 10,
    connection: { default_transaction_read_only: true },
  });
  const cardRef = `T-MET-${Date.now()}${randomInt(100000, 1000000)}`;
  const runRef = `RUN-${randomUUID()}`;
  const other = `smoke-other-${randomUUID()}`;
  const body = `Private isolation fixture ${runRef}`;
  const fixture = { card_ref: cardRef, type: "METHOD", title: "Project isolation smoke", body };
  const expectedBody = canonicalizeCard(fixture).body;
  let children = 0;
  let calls = 0;
  let embedWarnings = 0;
  try {
    const [db] = await sql`select current_database() as name`;
    check("connected database exactly matches confirmation", db.name === confirmation);
    const tables = await sql`select tablename from pg_tables where schemaname = 'public' order by tablename`;
    for (const required of ["tenants", "cards", "runs", "jobs", "card_relationships", "baselines"]) {
      check(`schema contains ${required}`, tables.some(t => t.tablename === required));
    }
    const [jobs] = await sql`select count(*)::int as n from jobs`;
    check("preflight has zero jobs (startup sweep has nothing to change)", jobs.n === 0);
    const [absent] = await sql`select
      (select count(*)::int from cards where card_ref = ${cardRef}) as cards,
      (select count(*)::int from runs where ref = ${runRef}) as runs,
      (select count(*)::int from tenants where slug = ${other}) as tenants`;
    check("unique fixtures and comparison project absent before writes", absent.cards === 0 && absent.runs === 0 && absent.tenants === 0);
    // Exact full-row snapshots detect edits, not just count changes.
    // This proof is limited to a small, exclusively used disposable database.
    async function snapshot(): Promise<Snapshot> {
      const result: Snapshot = {};
      for (const table of tables) {
        const rows = await sql`select to_jsonb(t)::text as row from ${sql(table.tablename)} t order by to_jsonb(t)::text`;
        result[table.tablename] = rows.map(r => r.row as string);
      }
      return result;
    }
    const before = await snapshot();
    async function session(config: string, exercise: (client: Client) => Promise<void>): Promise<void> {
      const transport = new StdioClientTransport({
        command: process.execPath, args: ["--import", "tsx", "server/server.ts"],
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        // SDK adds only its OS-required allowlist; never spread process.env.
        env: { TITRATION_DATABASE_URL: databaseUrl!, OPENROUTER_API_KEY: "",
          TITRATION_PROJECT: config, TITRATION_DB_SSL: postgresOptions(databaseUrl!, {}).ssl === false ? "disable" : "require",
          NODE_OPTIONS: "" },
        stderr: "pipe",
      });
      const client = new Client({ name: "project-isolation-smoke", version: "1.0.0" });
      let stderr = "";
      transport.stderr?.on("data", chunk => { stderr += String(chunk); });
      try {
        await client.connect(transport);
        children++;
        await exercise(client);
      } finally {
        try { await client.close(); } finally { await transport.close(); }
      }
      const warnings = stderr.split("\n").filter(line => line.includes("[cardCreate] embed-on-write failed"));
      for (const warning of warnings) {
        check("embed attempt refused locally by empty key", warning.includes(`scratch/${cardRef}`)
          && warning.includes("Set OPENROUTER_API_KEY before using an OpenRouter judge or embeddings."));
      }
      embedWarnings += warnings.length;
      check("stdio has no unexpected stderr", stderr.split("\n").every(line => !line.trim()
        || line.includes("titration MCP server ready (stdio)") || warnings.includes(line)));
    }
    async function call(client: Client, name: string, args: Record<string, unknown>, error?: RegExp): Promise<Record<string, unknown>> {
      calls++;
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as Array<{ type: string; text?: string }>).filter(c => c.type === "text").map(c => c.text).join("\n");
      if (error) {
        check(`${name} refuses with ${error.source}`, result.isError === true && error.test(text));
        return {};
      }
      check(`${name} succeeds`, result.isError !== true);
      return JSON.parse(text) as Record<string, unknown>;
    }
    async function read(client: Client, project: string | undefined, present: boolean): Promise<void> {
      const result = await call(client, "card_get", { card_ref: `project:${cardRef}`, ...(project === undefined ? {} : { project }) }, present ? undefined : /not found in tenant/i);
      if (present) check("MCP read returns exact private fixture", result.card_ref === cardRef && result.body === expectedBody && result.layer === "project");
    }
    await session(" scratch ", async client => {
      for (const project of [undefined, other, "default", "__base__"]) await read(client, project, false);
      const created = await call(client, "card_create", fixture);
      check("configured omission writes scratch card", created.tenant === "scratch" && created.card_ref === cardRef);
      const run = await call(client, "run_capture", { ref: runRef, summary: body });
      check("configured omission writes scratch run", run.tenant === "scratch" && run.run === runRef && run.linked_cards === 0);
      for (const project of [undefined, other, "scratch", "default", "scratch", "__base__", undefined]) {
        await read(client, project, project === undefined || project === "scratch");
      }
      await call(client, "card_create", { ...fixture, project: "__base__" }, /read.only/i);
    });
    await session(other, async client => {
      await read(client, undefined, false);
      await read(client, " scratch ", true);
      await read(client, undefined, false);
    });
    for (const config of ["INVALID CONFIG!", "__base__"]) {
      await session(config, async client => {
        await call(client, "card_get", { card_ref: `project:${cardRef}` }, /Invalid TITRATION_PROJECT:/);
        await read(client, "scratch", true);
        await read(client, "default", false);
      });
    }
    for (const config of ["", " \t "]) {
      await session(config, async client => {
        await call(client, "card_create", fixture, /PROJECT_REQUIRED/);
        await read(client, "scratch", true);
      });
    }
    check("exactly one expected embed warning; no model request reachable on exercised paths", embedWarnings === 1);
    const cards = await sql`select c.*, t.slug from cards c join tenants t on t.id = c.tenant_id where c.card_ref = ${cardRef}`;
    const runs = await sql`select r.*, t.slug from runs r join tenants t on t.id = r.tenant_id where r.ref = ${runRef}`;
    check("one actual card row joins only to scratch with NULL embedding", cards.length === 1 && cards[0].slug === "scratch" && cards[0].embedding === null && cards[0].body === expectedBody);
    check("one actual run row joins only to same scratch tenant_id", runs.length === 1 && runs[0].slug === "scratch" && runs[0].tenant_id === cards[0].tenant_id && runs[0].summary === body);
    const after = await snapshot();
    for (const table of Object.keys(before)) {
      const remaining = after[table].filter(row => {
        const value = JSON.parse(row) as Record<string, unknown>;
        if (table === "cards" && value.id === cards[0].id) return false;
        if (table === "runs" && value.id === runs[0].id) return false;
        if (table === "tenants" && value.slug === "scratch" && !before.tenants.some(old => JSON.parse(old).slug === "scratch")) return false;
        return true;
      });
      check(`exact unchanged snapshot: ${table} except authorized scratch additions`, JSON.stringify(remaining) === JSON.stringify(before[table]));
    }
    console.log(JSON.stringify({ card_ref: cardRef, run_ref: runRef, tenant_id: cards[0].tenant_id,
      persisted_cards: cards.length, persisted_runs: runs.length, stdio_children_closed: children,
      mcp_calls: calls, expected_embedding_refusals: embedWarnings, model_calls: 0,
      model_call_evidence: "Only card_get/run_capture/card_create and pre-dispatch refusals; empty key refused embed before HTTP; no judge paths invoked",
      scratch_rows_retained: true }));
  } finally {
    await sql.end({ timeout: 5 });
  }
  console.log(`PASS ${checks}/${checks} smoke-mcp-project-isolation`);
}

main().catch(error => {
  // Do not print driver objects/connection secrets. Assertion/safety messages are ours.
  const message = error instanceof Error && /^SMOKE_/.test(error.message)
    ? error.message : "SMOKE_FAILED: database, transport, or response failure; inspect the authorized disposable database before retrying";
  console.error(message);
  process.exitCode = 1;
});
