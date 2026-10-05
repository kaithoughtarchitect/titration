// Real SDK roots + production Git resolver; ideal-model picker replies only.
// No database, browser, provider or shipped server startup. CLI refusal checks
// use an inert URL and must stop before any pool/child/fixture is created.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createRepositoryProjectResolver } from "../repository-project";
import { bindRepositoryProject } from "../repository-project-core";
import { createPickerProofClient, provePickerBoundary, PICKER_PROOF_PROJECT, PICKER_PROOF_ORIGIN } from "../../scripts/prove-picker-boundary";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = await mkdtemp(join(tmpdir(), "picker-client-contract-"));
await mkdir(join(fixture, ".git", "objects"), { recursive: true });
await mkdir(join(fixture, ".git", "refs"));
await writeFile(join(fixture, ".git", "HEAD"), "ref: refs/heads/main\n");
const config = (origin: string) => `[core]\nrepositoryformatversion = 0\nbare = false\n[remote "origin"]\nurl = ${origin}\n`;
await writeFile(join(fixture, ".git", "config"), config(PICKER_PROOF_ORIGIN));

async function exercise(client: Client, expectedError?: RegExp) {
  const server = new Server({ name: "ideal-model-picker", version: "1" }, { capabilities: { tools: {} } });
  const resolveRepository = createRepositoryProjectResolver({ protocol: server, timeoutMs: 5000 });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  let accepted = 0;
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: ["referee_panel_mint", "referee_panel_status"].map(name =>
    ({ name, inputSchema: { type: "object" as const, properties: {} } })) }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const scope = bindRepositoryProject(await resolveRepository(), request.params.arguments?.project);
    assert.equal(scope, PICKER_PROOF_PROJECT);
    accepted++;
    const value = request.params.name === "referee_panel_mint"
      ? { ticket_id: "ideal-ticket", expires_at: "ideal-expiry", picker_url: "http://127.0.0.1/ideal-picker-not-opened" }
      : { status: "confirmed", panel_receipt_id: "ideal-receipt", panel:
        ["openai", "google", "x-ai"].map(family => ({ id: `ideal-${family}`, family, door: "ideal", effort: "high" })) };
    if (request.params.name === "referee_panel_status") assert.equal(request.params.arguments?.ticket_id, "ideal-ticket");
    return { content: [{ type: "text", text: JSON.stringify(value) }] };
  });
  try {
    await server.connect(st); await client.connect(ct);
    if (expectedError) {
      await assert.rejects(() => provePickerBoundary(client), expectedError);
      assert.equal(accepted, 0);
    } else {
      assert.equal(server.getClientCapabilities()?.roots?.listChanged, false);
      await provePickerBoundary(client);
      assert.equal(accepted, 2);
    }
  } finally { try { await client.close(); } finally { await server.close(); } }
}
// Replays the old client construction, which cannot satisfy automatic binding.
await exercise(new Client({ name: "picker-boundary-proof", version: "1.0.0" }), /REPOSITORY_CONTEXT_REQUIRED/);
await exercise(createPickerProofClient(fixture));
await writeFile(join(fixture, ".git", "config"), config("https://github.com/other-proof/picker-boundary.git"));
await exercise(createPickerProofClient(fixture), /REPOSITORY_PROJECT_CONFLICT/);
console.log("PASS: real roots discovery; picker mint/status accepted; missing or changed scope refuses before ideal-model work");

const inert = "postgres://127.0.0.1:1/picker_offline_guard";
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith("TITRATION_"))) as Record<string, string>;
Object.assign(cleanEnv, { TITRATION_DATABASE_URL: inert, OPENROUTER_API_KEY: "", NODE_OPTIONS: "" });
function invoke(extra: Record<string, string>, args: string[] = [], script = "scripts/prove-picker-boundary.ts") {
  const result = spawnSync(process.execPath, ["--import", "tsx", script, ...args],
    { cwd: root, env: { ...cleanEnv, ...extra }, encoding: "utf8", timeout: 15_000, shell: false });
  assert.equal(result.error, undefined);
  return result;
}
const description = invoke({}, ["--describe"]);
assert.equal(description.status, 0);
assert.deepEqual(JSON.parse(description.stdout), { origin: PICKER_PROOF_ORIGIN, project: PICKER_PROOF_PROJECT });
for (const [env, error] of [
  [{}, "PICKER_PROOF_DATABASE_REQUIRED"],
  [{ TITRATION_PICKER_PROOF_DATABASE_URL: "invalid", TITRATION_PICKER_PROOF_CONFIRM_DATABASE: "picker_offline_guard" }, "PICKER_PROOF_DATABASE_INVALID"],
  [{ TITRATION_PICKER_PROOF_DATABASE_URL: inert, TITRATION_PICKER_PROOF_CONFIRM_DATABASE: "wrong" }, "PICKER_PROOF_DATABASE_MISMATCH"],
  [{ TITRATION_PICKER_PROOF_DATABASE_URL: inert, TITRATION_PICKER_PROOF_CONFIRM_DATABASE: "picker_offline_guard" }, "PICKER_PROOF_PROJECT_REQUIRED"],
  [{ TITRATION_PICKER_PROOF_DATABASE_URL: inert, TITRATION_PICKER_PROOF_CONFIRM_DATABASE: "picker_offline_guard", TITRATION_PICKER_PROOF_CONFIRM_PROJECT: "picker-proof" }, "PICKER_PROOF_PROJECT_REQUIRED"],
] as Array<[Record<string, string>, string]>) {
  const result = invoke(env);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(error), result.stderr);
  assert.equal(result.stdout, "");
  assert.ok(!/ECONN|fixture_directory|server up/i.test(result.stderr));
}
console.log("PASS: describe and five authorization refusals; no live proof executed");
const smokeScript = "scripts/smoke-mcp-project-isolation.ts";
const scopes = new Set<string>();
for (const anchorCase of ["qualified", "ssh-path", "ssh-suffix"]) {
  const result = invoke({ TITRATION_SMOKE_ANCHORS: anchorCase }, ["--describe"], smokeScript);
  assert.equal(result.status, 0, result.stderr);
  const description = JSON.parse(result.stdout);
  assert.equal(description.anchorCase, anchorCase);
  assert.equal(description.projects.length, 2);
  assert.notEqual(description.projects[0], description.projects[1]);
  description.projects.forEach((scope: string) => { assert.match(scope, /^repo-[a-f0-9]{58}$/); scopes.add(scope); });
  const refusal = invoke({ TITRATION_SMOKE_ANCHORS: anchorCase, TITRATION_SMOKE_DATABASE_URL: inert,
    TITRATION_SMOKE_CONFIRM_DATABASE: "picker_offline_guard", TITRATION_SMOKE_CONFIRM_PROJECTS: "wrong-project" }, [], smokeScript);
  assert.equal(refusal.status, 1);
  assert.match(refusal.stderr, /SMOKE_PROJECTS_REQUIRED/);
  assert.equal(refusal.stdout, "");
}
assert.equal(scopes.size, 5);
const unknown = invoke({ TITRATION_SMOKE_ANCHORS: "constructor" }, ["--describe"], smokeScript);
assert.equal(unknown.status, 1);
assert.match(unknown.stderr, /SMOKE_ANCHORS_INVALID/);
console.log("PASS: three smoke case descriptions, distinct collision scopes and exact-authorization refusals");
