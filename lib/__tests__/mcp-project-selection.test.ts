// Real SDK transport + shipped factory/selector. Offline; no DB or paid calls.
// HTTP responses below are ideal-model fixtures, adapted from the existing
// classify, harness-design, harness-validate and propose-core suites.
import { AsyncLocalStorage } from "node:async_hooks";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CANONICAL_FILES, DESIGN_SYSTEM } from "../harness-design-core";
import { CHECKS, VALIDATE_SYSTEM } from "../harness-validate-core";
import { PROPOSE_SYSTEM } from "../propose-core";
import { EMBED_DIMENSION } from "../embed-core";

let total = 0, failures = 0;
function check(name: string, condition: boolean, detail = "") {
  total++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : ` — ${detail}`}`);
  if (!condition) failures++;
}
const envKeys = ["TITRATION_DATABASE_URL", "OPENROUTER_API_KEY", "TITRATION_JUDGES"] as const;
const savedEnv = envKeys.map((key) => process.env[key]);
process.env.TITRATION_DATABASE_URL = "postgres://127.0.0.1:1/titration-offline-only";
process.env.OPENROUTER_API_KEY = "ideal-model-offline-not-a-key";
process.env.TITRATION_JUDGES = "openai/gpt-6-sol,moonshotai/kimi-k3,deepseek/deepseek-v4-pro-0813";
const originalFetch = globalThis.fetch;
const originalGetStore = AsyncLocalStorage.prototype.getStore;
let storage = 0, provider = 0, subprocess = 0, jobs = 0, unexpectedHttp = 0;
let allowedTool: string | undefined;
let prompts: string[] = [];
// Conservative guarded-storage-access observations, NOT SQL statement counts or
// selected-tenant proof. The real guard still blocks every observed access.
AsyncLocalStorage.prototype.getStore = function () {
  const state = originalGetStore.call(this);
  if (state?.kind === "no_context_guard") storage++;
  return state;
};
for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const) {
  mock.method(childProcess, method, () => {
    subprocess++;
    throw new Error("OFFLINE_SUBPROCESS_FORBIDDEN");
  });
}
syncBuiltinESMExports();
globalThis.fetch = async (url, init) => {
  provider++;
  const body = JSON.parse(String(init?.body ?? "{}"));
  const system = body.messages?.[0]?.content;
  const user = body.messages?.[1]?.content;
  if (allowedTool === "harness_design" && String(url) === "https://openrouter.ai/api/v1/embeddings") {
    return Response.json({ data: [{ index: 0, embedding: Array(EMBED_DIMENSION).fill(0) }] });
  }
  if (String(url) === "https://openrouter.ai/api/v1/chat/completions" && init?.method === "POST") {
    let response: unknown;
    if (allowedTool === "classify_failure" && system === CLASSIFY_SYSTEM) {
      response = { reasoning: "Ideal-model: raw output intact; formatter removed markers.", failure_origin: "formatter", confidence: "high" };
    } else if (allowedTool === "harness_design" && system === DESIGN_SYSTEM) {
      response = {
        readme_markdown: "# PROPOSED — harness for X\n\nGoal: prove the edit reduces narration leakage without regressing voice.\n\n## What this harness will NOT catch\n- latency, token cost, UI rendering.",
        labels: [{ name: "LABEL_leak", type: "Y/N", authority_class: "semantic", ship_gate: true, definition: "Does the reply leak narration?", decision_threshold: "rate drops ≥40%" }],
        manifest: CANONICAL_FILES.map((file) => ({ file, must_contain: [`do the ${file} thing`] })),
        thresholds: [{ label: "LABEL_leak", target: "rate drops ≥40%", rationale: "ideal-model" }],
        predicted_outcomes: [{ label: "LABEL_leak", hypothesis: "leak rate ≤30%" }], precedent_applied: [],
      };
    } else if (allowedTool === "harness_validate" && system === VALIDATE_SYSTEM) {
      response = { summary: "Ideal-model: looks sound", checks: CHECKS.map(({ id }) => ({ check: id, findings: [] })) };
    } else if (allowedTool === "propose_cards" && system === PROPOSE_SYSTEM) {
      response = { summary: "Ideal-model: reusable method", proposals: [{ type: "METHOD", title: "Reusable method", body: "Evidence and application.", confidence: "high", tags: ["test"], duplicate_of: "T-MET-001", rationale: "supplied context", suggested_edges: [] }] };
    }
    if (response) {
      prompts.push(String(user));
      return Response.json({ choices: [{ message: { content: JSON.stringify(response) } }] });
    }
  }
  unexpectedHttp++;
  throw new Error("OFFLINE_HTTP_FORBIDDEN");
};

const { createMcpServer, TRUSTED_LOCAL_MCP_TOOLS, TRUSTED_LOCAL_MCP_PRESENTATION } = await import("../../server/mcp-server");
const { createLocalEvolutionAdapter } = await import("../../server/evolution-local");
const { sql, withGuardedSql } = await import("../store");
const { CLASSIFY_SYSTEM } = await import("../classify");
const mandatory = ["card_search", "card_get", "card_create", "card_relate", "run_capture", "card_distill", "establish_baseline", "verify", "job_status", "goal_titrate", "goal_titrate_step", "edge_propose", "referee_panel_mint", "referee_panel_status"];
const optional = ["classify_failure", "harness_design", "propose_cards"];
type Args = Record<string, unknown>;
type Hook = (name: string, args: Args) => Args | Promise<Args>;
function reset() { storage = provider = subprocess = jobs = 0; prompts = []; }
function noWork() { return storage === 0 && provider === 0 && subprocess === 0 && jobs === 0; }
function counts() { return JSON.stringify({ storage, provider, subprocess, jobs }); }
async function session(configuredProject: string | undefined, run: (client: Client) => Promise<void>, prepareArguments?: Hook, resolveRepositoryProject?: () => Promise<string>, evolution = createLocalEvolutionAdapter()) {
  const server = createMcpServer({
    mode: TRUSTED_LOCAL_MCP_PRESENTATION.mode, tools: TRUSTED_LOCAL_MCP_TOOLS,
    presentation: TRUSTED_LOCAL_MCP_PRESENTATION, evolution,
    configuredProject, prepareArguments, resolveRepositoryProject,
    createJobContext() { jobs++; throw new Error("OFFLINE_JOB_FORBIDDEN"); },
  });
  const client = new Client({ name: "project-selection-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await withGuardedSql(async () => {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await run(client);
    });
  } finally {
    await client.close();
    await server.close();
  }
}
async function call(client: Client, name: string, args: Args = {}) {
  reset();
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text?: string }[]).filter((x) => x.type === "text").map((x) => x.text).join("\n");
  return { error: result.isError === true, text };
}
async function refused(client: Client, name: string, args: Args, pattern: RegExp) {
  const result = await call(client, name, args);
  check(`${name} refuses ${JSON.stringify(args.project)}: ${pattern}`, result.error && pattern.test(result.text), result.text);
  check(`${name} refusal precedes storage/provider/subprocess/job work`, noWork(), counts());
}
async function reachesStorage(client: Client, project: unknown) {
  const result = await call(client, "card_get", { project, card_ref: "project:T-MET-001" });
  check(`accepted ${JSON.stringify(project)} reaches guarded storage`, result.error && /trusted transaction context/.test(result.text) && storage > 0 && provider === 0 && subprocess === 0 && jobs === 0, result.text + counts());
}

try {
  reset();
  await withGuardedSql(() => { /* negative control: no storage */ });
  check("guard negative control observes no storage", storage === 0);
  let blocked = false;
  try { await withGuardedSql(async () => { await sql`select 1`; }); }
  catch (error) { blocked = error instanceof Error && /trusted transaction context/.test(error.message); }
  check("guard positive control observes and blocks actual SQL", blocked && storage > 0);
  reset();
  const omissions = [undefined, null, "", " \t\n "];
  for (const config of [undefined, "", " \t "]) {
    await session(config, async (client) => {
      const { tools } = await client.listTools();
      check("all 18 registered routes have an explicit policy classification", JSON.stringify(tools.map((t) => t.name).sort()) === JSON.stringify([...mandatory, ...optional, "harness_validate"].sort()));
      for (const name of mandatory) {
        const description = String(tools.find((t) => t.name === name)?.inputSchema.properties?.project && (tools.find((t) => t.name === name)!.inputSchema.properties!.project as { description: string }).description);
        check(`${name} metadata describes automatic stdio and independent assertions`, /automatic stdio/i.test(description) && /omit project/i.test(description) && /client.*roots/i.test(description) && /independent matching assertions/i.test(description) && /not overrides/i.test(description) && /invalid.*conflicting/i.test(description));
        check(`${name} metadata preserves legacy factory explicit/configured/required policy`, /without.*resolver/i.test(description) && /explicit project wins/i.test(description) && /TITRATION_PROJECT/.test(description) && /PROJECT_REQUIRED/.test(description) && /checked only when needed/i.test(description));
        check(`${name} metadata distinguishes legacy default and base from automatic scope`, /legacy.*"default"/i.test(description) && /"__base__".*read-only/i.test(description) && /no.*migration/i.test(description));
        for (const project of omissions) await refused(client, name, { project }, /PROJECT_REQUIRED/);
      }
      for (const name of optional) {
        const prop = tools.find((t) => t.name === name)!.inputSchema.properties!.project as { description: string };
        check(`${name} metadata describes automatic repository context that fails open`,
          /automatic stdio: omit it/i.test(prop.description) && /repository's own memory/i.test(prop.description)
          && /otherwise the call runs without private context/i.test(prop.description) && /must match the repository/i.test(prop.description));
        check(`${name} metadata preserves legacy optional context`, /legacy factory: omit/i.test(prop.description) && /configured defaults do not/i.test(prop.description));
      }
      check("harness_validate remains stateless metadata", !("project" in tools.find((t) => t.name === "harness_validate")!.inputSchema.properties!));
    });
  }
  for (const config of [" repo-b ", "INVALID", "__base__"]) {
    await session(config, async (client) => {
      for (const project of [" repo-a ", "default", "a".repeat(63), "__base__"]) await reachesStorage(client, project);
      for (const name of mandatory) {
        for (const project of [false, 0, 42, {}, [], "Bad Name", "a/b", "a".repeat(64)]) {
          await refused(client, name, { project }, /project must be a string|invalid project/i);
        }
        if (config !== " repo-b ") for (const project of omissions) await refused(client, name, { project }, /Invalid TITRATION_PROJECT:/);
      }
      if (config === " repo-b ") for (const project of omissions) await reachesStorage(client, project);
      for (const name of ["card_create", "card_relate", "run_capture"]) {
        await refused(client, name, { project: "__base__", type: "METHOD", title: "test", body: "test", from_ref: "T-MET-001", predicate: "supports", to: "T-MET-002", ref: "RUN-test" }, /read.only|curated/i);
      }
    });
  }
  await session(undefined, async (client) => {
    await refused(client, "card_get", { project: "repo-a", card_ref: "T-MET-001" }, /PROJECT_REQUIRED/);
  }, async (_name, args) => { const { project: _project, ...rest } = args; return rest; });
  await session("repo-b", async (client) => { await reachesStorage(client, "repo-a"); }, (_name, args) => ({ ...args, project: null }));
  await session("repo-b", async (client) => { await refused(client, "card_get", { project: "repo-a" }, /invalid project/i); }, (_name, args) => ({ ...args, project: "BAD" }));
  await session(undefined, async (client) => { await reachesStorage(client, undefined); }, (_name, args) => ({ ...args, project: "repo-hook" }));
  const shared = Object.freeze({ card_ref: "project:T-MET-001" });
  for (const config of ["repo-a", "repo-b", undefined]) {
    await session(config, async (client) => {
      if (config) await reachesStorage(client, undefined);
      else await refused(client, "card_get", {}, /PROJECT_REQUIRED/);
      check("shared frozen hook result is not contaminated", !("project" in shared));
    }, () => shared);
  }

  // Ideal-model resolver doubles exercise the shipped factory, not Git discovery.
  const derived = `repo-${"a".repeat(58)}`;
  const other = `repo-${"b".repeat(58)}`;
  let resolutions = 0;
  const resolve = async () => { resolutions++; return derived; };
  for (const name of mandatory) {
    await session(undefined, async (client) => {
      await refused(client, name, {}, /REPOSITORY_LOOKUP_TIMEOUT/);
    }, undefined, async () => { throw new Error("REPOSITORY_LOOKUP_TIMEOUT"); });
    await session(undefined, async (client) => {
      const before = resolutions;
      await refused(client, name, {}, /PREPARATION_REFUSED/);
      check(`${name} rejected preparation prevents resolution`, resolutions === before);
    }, async () => { await Promise.resolve(); throw new Error("PREPARATION_REFUSED"); }, resolve);
    await session(derived, async (client) => {
      for (const project of [other, "default", "__base__", false, 42, {}, [], "Bad Name", "a".repeat(64)]) {
        await refused(client, name, { project }, /REPOSITORY_PROJECT_(INVALID|CONFLICT)/);
      }
    }, undefined, resolve);
    for (const config of [other, "default", "__base__", "INVALID", "a".repeat(64)]) {
      await session(config, async (client) => {
        await refused(client, name, { project: derived }, /REPOSITORY_PROJECT_(INVALID|CONFLICT)/);
      }, undefined, resolve);
    }
  }
  // A throwing enumerable getter observes the fresh-copy boundary after binding,
  // without entering handlers that would otherwise need storage or providers.
  for (const config of [undefined, "", " \t ", derived, ` ${derived} `]) {
    await session(config, async (client) => {
      for (const name of mandatory) {
        for (const project of [...omissions, derived, ` ${derived} `]) {
          const before = resolutions;
          await refused(client, name, { project }, /BOUND_ARGUMENTS_COPIED/);
          check(`${name} accepted assertions resolve exactly once before copying`, resolutions === before + 1);
        }
      }
    }, (_name, args) => Object.freeze({
      ...args,
      get copyBoundary() { throw new Error("BOUND_ARGUMENTS_COPIED"); },
    }), resolve);
  }
  for (const config of [undefined, "", " \t ", derived, ` ${derived} `]) {
    await session(config, async (client) => {
      for (const project of [...omissions, derived, ` ${derived} `]) await reachesStorage(client, project);
    }, undefined, resolve);
  }
  let prepared = false;
  await session(undefined, async (client) => {
    await reachesStorage(client, other);
  }, async (_name, args) => {
    await Promise.resolve();
    prepared = true;
    return Object.freeze({ ...args, project: derived });
  }, async () => {
    check("automatic resolution follows completed async preparation", prepared);
    return derived;
  });
  await session(undefined, async (client) => {
    await refused(client, "card_get", { project: derived }, /REPOSITORY_PROJECT_CONFLICT/);
  }, async (_name, args) => ({ ...args, project: other }), resolve);
  for (const sharedPrepared of [{ card_ref: "project:T-MET-001" }, Object.freeze({ card_ref: "project:T-MET-001" })]) {
    await session(undefined, async (client) => {
      await reachesStorage(client, undefined);
      await reachesStorage(client, undefined);
      check("automatic binding does not mutate shared/frozen prepared object", !Object.hasOwn(sharedPrepared, "project"));
    }, () => sharedPrepared, resolve);
  }
  function deferred() {
    let done!: () => void;
    const promise = new Promise<void>((resolve) => { done = resolve; });
    return { promise, done };
  }
  const entered = deferred(), release = deferred();
  const captured: string[] = [];
  let current = derived;
  const evolution = createLocalEvolutionAdapter();
  evolution.prepare = async (input) => {
    captured.push(input.tenant);
    if (captured.length === 1) { entered.done(); await release.promise; }
    check("in-flight handler retains its captured scalar", input.tenant === (input.jobId === "first" ? derived : other));
    throw new Error("CAPTURE_OBSERVED");
  };
  await session(undefined, async (client) => {
    reset();
    const args = { player_model: "openai/gpt-6-sol", evolution: { artifact_kind: "code", note: "offline capture" } };
    const first = client.callTool({ name: "goal_titrate_step", arguments: { ...args, job_id: "first" } });
    await entered.promise;
    current = other;
    const second = await client.callTool({ name: "goal_titrate_step", arguments: { ...args, job_id: "second" } });
    release.done();
    const firstResult = await first;
    check("interleaved calls capture distinct per-call projects", captured.join() === [derived, other].join());
    check("capture observer stops both calls before storage/provider/jobs", firstResult.isError === true && second.isError === true && noWork(), counts());
  }, undefined, async () => current, evolution);
  await session(undefined, async (client) => {
    const before = resolutions;
    await refused(client, "unknown_tool", {}, /unknown tool/);
    check("unknown route does not resolve repository", resolutions === before);
  }, undefined, resolve);

  for (const automatic of [false, true]) {
  for (const config of [undefined, "repo-default", "INVALID", "__base__"]) {
    await session(config, async (client) => {
      for (const project of omissions) {
        for (const [name, args] of [
          ["classify_failure", { observation: "Raw output was intact; formatter removed markers.", mode: "panel" }],
          ["propose_cards", { run_summary: "A reusable method was observed.", existing_cards: "SUPPLIED-CONTEXT T-MET-001", propose_model: "openai/gpt-6-sol" }],
          ["harness_design", { system_description: "Detect narration leakage", change_type: "prompt-edit", design_model: "openai/gpt-6-sol" }],
          ["harness_validate", { design_or_manifest: "Proposed five-file harness", codebase_facts: "Isolated tests; no writes.", validate_model: "openai/gpt-6-sol" }],
        ] as [string, Args][]) {
          allowedTool = name;
          const result = await call(client, name, { ...args, ...(name === "harness_validate" ? {} : { project }) });
          check(`${name} succeeds with omitted context / config ${config}`, !result.error, result.text);
          const value = result.error ? {} : JSON.parse(result.text);
          if (name === "classify_failure") check("classify succeeds without ledger read", value.failure_origin === "formatter" && storage === 0 && provider === 3, counts());
          if (name === "propose_cards") check("proposal preserves supplied context without neighbors", value.advisory === true && value.proposals?.[0]?.duplicate_of === "T-MET-001" && prompts.some((p) => p.includes("SUPPLIED-CONTEXT")) && storage === 0 && provider === 1, counts());
          if (name === "harness_design") check("design succeeds after guarded base-only precedent degradation", value.status === "PROPOSED" && value.precedent_applied?.length === 0 && storage === 1 && provider === 2, counts());
          if (name === "harness_validate") check("validation remains stateless and successful", value.advisory === true && value.score === 100 && storage === 0 && provider === 1, counts());
          check(`${name} has no subprocess or job attempts`, subprocess === 0 && jobs === 0, counts());
          allowedTool = undefined;
        }
      }
      allowedTool = "classify_failure";
      const result = await call(client, "classify_failure", { project: "repo-explicit", ledger: false, observation: "Formatter removed markers." });
      check("ledger:false suppresses explicit project context with successful classification", !result.error && storage === 0 && provider === 3 && subprocess === 0 && jobs === 0, result.text + counts());
      allowedTool = undefined;
    }, undefined, automatic ? async () => { throw new Error("REPOSITORY_CONTEXT_REQUIRED"); } : undefined);
  }
  }

  // Automatic advisory context binds the repository when discoverable.
  const advisoryCalls: [string, Args, number][] = [
    ["classify_failure", { observation: "Raw output was intact; formatter removed markers.", mode: "panel" }, 0],
    ["propose_cards", { run_summary: "A reusable method was observed.", existing_cards: "SUPPLIED-CONTEXT T-MET-001", propose_model: "openai/gpt-6-sol" }, 0],
    ["harness_design", { system_description: "Detect narration leakage", change_type: "prompt-edit", design_model: "openai/gpt-6-sol" }, 1],
  ];
  for (const config of [undefined, "", derived]) {
    await session(config, async (client) => {
      for (const [name, args, omittedStorage] of advisoryCalls) {
        for (const project of [...omissions, derived, ` ${derived} `]) {
          allowedTool = name;
          const before = resolutions;
          const result = await call(client, name, { ...args, project });
          // The guarded store blocks every read, so success proves the memory read fails open.
          check(`${name} automatic context still returns advice`, !result.error, result.text);
          check(`${name} automatic context resolves exactly once`, resolutions === before + 1);
          check(`${name} automatic context reads repository memory`, storage > omittedStorage && subprocess === 0 && jobs === 0, counts());
          allowedTool = undefined;
        }
        for (const project of [other, "default", "__base__", "Bad Name", 42]) {
          await refused(client, name, { ...args, project }, /REPOSITORY_PROJECT_(INVALID|CONFLICT)/);
        }
      }
      const before = resolutions;
      allowedTool = "classify_failure";
      const result = await call(client, "classify_failure", { project: derived, ledger: false, observation: "Formatter removed markers." });
      check("ledger:false skips automatic discovery and memory", !result.error && resolutions === before && storage === 0, result.text + counts());
      allowedTool = "harness_validate";
      await call(client, "harness_validate", { design_or_manifest: "Proposed five-file harness", codebase_facts: "Isolated tests; no writes.", validate_model: "openai/gpt-6-sol" });
      check("harness_validate stays stateless without discovery", resolutions === before && storage === 0, counts());
      allowedTool = undefined;
    }, undefined, resolve);
  }
  for (const config of [other, "INVALID"]) {
    await session(config, async (client) => {
      for (const [name, args] of advisoryCalls) await refused(client, name, args, /REPOSITORY_PROJECT_(INVALID|CONFLICT)/);
    }, undefined, resolve);
  }
  // Failed discovery never lets a supplied name select another tenant.
  await session(undefined, async (client) => {
    for (const [name, args, omittedStorage] of advisoryCalls) {
      allowedTool = name;
      const result = await call(client, name, { ...args, project: other });
      check(`${name} failed discovery drops supplied project and runs without memory`, !result.error && storage === omittedStorage, result.text + counts());
      allowedTool = undefined;
    }
  }, undefined, async () => { throw new Error("REPOSITORY_LOOKUP_FAILED"); });
  check("no unrecognized provider traffic attempted", unexpectedHttp === 0, String(unexpectedHttp));
} finally {
  await sql.end();
  globalThis.fetch = originalFetch;
  AsyncLocalStorage.prototype.getStore = originalGetStore;
  mock.restoreAll();
  syncBuiltinESMExports();
  envKeys.forEach((key, index) => { if (savedEnv[index] === undefined) delete process.env[key]; else process.env[key] = savedEnv[index]; });
}
console.log(`\n${failures ? "FAIL" : "PASS"} ${total - failures}/${total}`);
process.exitCode = failures ? 1 : 0;
