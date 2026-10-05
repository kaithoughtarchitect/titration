// Titration MCP — the local stdio server entry point.
//
// Run: TITRATION_DATABASE_URL=... OPENROUTER_API_KEY=... npm run server

import "./bootstrap-env"; // FIRST: store reads its database credential at import time.
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createTrustedLocalJobContext,
  type JobExecutionContext,
} from "../lib/jobs";
import { failStaleRunningJobs } from "../lib/local-jobs";
import { createRepositoryProjectResolver } from "../lib/repository-project";
import {
  createMcpServer,
  TRUSTED_LOCAL_MCP_PRESENTATION,
  TRUSTED_LOCAL_MCP_TOOLS,
} from "./mcp-server";
import { createLocalEvolutionAdapter } from "./evolution-local";

function createStdioJobContext(tenant: string): JobExecutionContext {
  return createTrustedLocalJobContext(tenant);
}

// Boot sweep: a verify/establish_baseline job left `running` or `queued` by a
// previous process is a dead man's row — the in-memory scheduler (and its FIFO
// queue) that owned it died with that process, so nothing will ever move it out
// of a non-terminal state. Fail those rows BEFORE accepting any tool call, so a
// caller that polls job_status for a pre-restart job_id gets a typed "re-run it"
// instead of a poll that hangs forever. goal_titrate is client-driven and is
// never touched here. Fail-open by construction (failStaleRunningJobs never
// throws) — a boot-time DB hiccup must not block server startup.
await failStaleRunningJobs(new Date());

let resolveRepositoryProject: () => Promise<string>;
const server = createMcpServer({
  mode: "trusted-local",
  tools: TRUSTED_LOCAL_MCP_TOOLS,
  configuredProject: process.env.TITRATION_PROJECT,
  resolveRepositoryProject: () => resolveRepositoryProject(),
  createJobContext: createStdioJobContext,
  evolution: createLocalEvolutionAdapter(),
  presentation: TRUSTED_LOCAL_MCP_PRESENTATION,
});

resolveRepositoryProject = createRepositoryProjectResolver({
  protocol: server.server,
  timeoutMs: 5000,
  // For clients that advertise no roots: the directory they launched us in.
  launchContext: { cwd: process.cwd(), serverRoot: fileURLToPath(new URL("..", import.meta.url)) },
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("titration MCP server ready (stdio) — Memory: card_search/get/create/relate, run_capture, card_distill · Grading: referee_panel_mint/status (judge picker), classify_failure, establish_baseline, verify (sync/async), job_status, goal_titrate (+_step) · Harness design: harness_design, harness_validate · Extraction: propose_cards · Graph: edge_propose · Prompt: extract_learnings");
