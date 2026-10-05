// Interactive shipped-stdio picker proof; no grading or model calls.
// Run: node --import tsx scripts/prove-picker-boundary.ts
// Requires an exclusive disposable schema-ready DB, zero jobs and explicit
// TITRATION_PICKER_PROOF_DATABASE_URL, TITRATION_PICKER_PROOF_CONFIRM_DATABASE,
// TITRATION_PICKER_PROOF_CONFIRM_PROJECT. --describe prints the required project
// without connecting or creating fixtures. Tickets and fixtures are retained.
// Existing provider configuration controls picker availability; it is not used
// to grade or call a model. Three eligible families must be available to confirm.
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import postgres from "postgres";
import { postgresOptions } from "../lib/db-connect-core";
import { deriveRepositoryProject, repositoryRemoteKey } from "../lib/repository-project-core";

export const PICKER_PROOF_ORIGIN = "https://github.com/titration-fixtures/picker-boundary.git";
export const PICKER_PROOF_PROJECT = deriveRepositoryProject(createHash("sha256")
  .update(repositoryRemoteKey(PICKER_PROOF_ORIGIN)).digest("hex"));
const PLAYER = "claude-opus-5-5";
const DEADLINE_MS = 10 * 60 * 1000;

export function createPickerProofClient(repositoryRoot: string): Client {
  const client = new Client({ name: "picker-boundary-proof", version: "1.0.0" },
    { capabilities: { roots: { listChanged: false } } });
  client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: [{ uri: pathToFileURL(repositoryRoot).href }] }));
  return client;
}

function text(result: any): any {
  const body = result?.content?.[0]?.text ?? "";
  if (result?.isError) throw new Error(body);
  try { return JSON.parse(body); } catch { return body; }
}

export async function provePickerBoundary(client: Client): Promise<void> {
  const tools = await client.listTools();
  console.log(`server up: ${tools.tools.length} tools`);
  // A derived matching assertion bounds write authority even if local Git
  // configuration rewrites the fixture URL. It cannot override repository scope.
  const minted = text(await client.callTool({ name: "referee_panel_mint",
    arguments: { project: PICKER_PROOF_PROJECT, player_model: PLAYER } }));
  console.log(`minted ticket ${minted.ticket_id}, expires ${minted.expires_at}`);
  console.log(`\nConfirm in the browser (open this link if necessary):\n${minted.picker_url}`);
  const started = Date.now();
  let status: any = { status: "pending" };
  while (status.status === "pending" && Date.now() - started < DEADLINE_MS) {
    status = text(await client.callTool({ name: "referee_panel_status",
      arguments: { project: PICKER_PROOF_PROJECT, ticket_id: minted.ticket_id, wait_seconds: 25 } },
    undefined, { timeout: 60_000 }));
    console.log(`status: ${status.status}`);
  }
  if (status.status !== "confirmed") throw new Error(`picker ended as '${status.status}'`);
  const judges: any[] = Array.isArray(status.panel) ? status.panel : [];
  const families = new Set(judges.map(judge => judge.family));
  if (families.has("anthropic")) throw new Error("Player family on the panel");
  if (families.size !== 3) throw new Error(`expected 3 families, got ${families.size}`);
  console.log(`PASS: confirmed through MCP; panel_receipt_id: ${status.panel_receipt_id}`);
  for (const judge of judges) console.log(`  ${judge.id} · ${judge.family} · ${judge.door} · ${judge.effort}`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--describe")) {
    console.log(JSON.stringify({ origin: PICKER_PROOF_ORIGIN, project: PICKER_PROOF_PROJECT }));
    return;
  }
  // No bootstrap import: authorization precedes pool, child and fixture creation.
  const databaseUrl = process.env.TITRATION_PICKER_PROOF_DATABASE_URL;
  const confirmation = process.env.TITRATION_PICKER_PROOF_CONFIRM_DATABASE;
  if (!databaseUrl || !confirmation) throw new Error("PICKER_PROOF_DATABASE_REQUIRED");
  let parsed: URL;
  try { parsed = new URL(databaseUrl); } catch { throw new Error("PICKER_PROOF_DATABASE_INVALID"); }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || parsed.search || parsed.hash
      || decodeURIComponent(parsed.pathname.slice(1)) !== confirmation) throw new Error("PICKER_PROOF_DATABASE_MISMATCH");
  if (process.env.TITRATION_PICKER_PROOF_CONFIRM_PROJECT !== PICKER_PROOF_PROJECT)
    throw new Error(`PICKER_PROOF_PROJECT_REQUIRED: ${PICKER_PROOF_PROJECT}`);
  const sql = postgres(databaseUrl, { ...postgresOptions(databaseUrl, {}), max: 1, connect_timeout: 10,
    connection: { default_transaction_read_only: true } });
  try {
    const [db] = await sql`select current_database() as name, current_setting('transaction_read_only') as readonly`;
    if (db.name !== confirmation || db.readonly !== "on") throw new Error("PICKER_PROOF_DATABASE_MISMATCH");
    const [jobs] = await sql`select count(*)::int as n from jobs`;
    if (jobs.n !== 0) throw new Error("PICKER_PROOF_REQUIRES_ZERO_JOBS: startup sweep must have nothing to change");
    const directory = await mkdtemp(join(tmpdir(), "picker-proof-"));
    const repository = join(directory, "repo");
    await mkdir(join(repository, ".git", "objects"), { recursive: true });
    await mkdir(join(repository, ".git", "refs"));
    await writeFile(join(repository, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(repository, ".git", "config"), '[core]\nrepositoryformatversion = 0\nbare = false\n[remote "origin"]\nurl = ' + PICKER_PROOF_ORIGIN + "\n");
    console.log(JSON.stringify({ fixture_directory_retained: directory, project: PICKER_PROOF_PROJECT }));
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ["--import", "tsx", "server/server.ts"], cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: { TITRATION_DATABASE_URL: databaseUrl, TITRATION_PROJECT: "", NODE_OPTIONS: "",
        ...(process.env.OPENROUTER_API_KEY === undefined ? {} : { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY }),
        TITRATION_DB_SSL: postgresOptions(databaseUrl, {}).ssl === false ? "disable" : "require" }, stderr: "inherit" });
    const client = createPickerProofClient(repository);
    try { await client.connect(transport); await provePickerBoundary(client); }
    finally { try { await client.close(); } finally { await transport.close(); } }
  } finally { await sql.end({ timeout: 5 }); }
  console.log("No rows or fixtures deleted; proof data retained in the confirmed project.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
