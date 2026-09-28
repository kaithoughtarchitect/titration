// Titration MCP — public surface pins (no network, no DB, $0).
//
// 1. Every file reachable from the entry points resolves inside the tree and none is a
//    removed module (a web app, a local push client, or other
//    files that never shipped under lib/ or server/ in this build).
// 2. The stdio server registers exactly the 18 local tools, including the two
//    local picker tools, referee_panel_mint / referee_panel_status.
// Run: npx tsx lib/__tests__/oss-surface.test.ts

export {};

process.env.TITRATION_DATABASE_URL ??="postgres://127.0.0.1:1/titration-offline-import-only";

// @ts-expect-error — plain ESM helper without type declarations
const { walk } = await import("../../scripts/import-graph-check.mjs");
const { TRUSTED_LOCAL_MCP_TOOLS } = await import("../../server/mcp-server");

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}

const graph = walk() as { files: string[]; problems: string[] };
check("import graph has no removed-module, missing, or out-of-tree edges", graph.problems.length === 0, graph.problems.join("; "));
check("import graph reaches the stdio server", graph.files.includes("server/mcp-server.ts"));

const EXPECTED_TOOLS = [
  "card_search", "card_get", "card_create", "card_relate", "run_capture", "card_distill",
  "classify_failure", "establish_baseline", "verify", "job_status", "goal_titrate",
  "goal_titrate_step", "harness_design", "harness_validate", "propose_cards", "edge_propose",
  "referee_panel_mint", "referee_panel_status",
];
const names = (TRUSTED_LOCAL_MCP_TOOLS as readonly { name: string }[]).map((tool) => tool.name);
check("exactly 18 tools", names.length === 18, String(names.length));
check("tool names match the local registry", JSON.stringify([...names].sort()) === JSON.stringify([...EXPECTED_TOOLS].sort()), names.join(","));

console.log(failures ? `\n${failures} failure(s)` : "\nall oss-surface checks passed");
process.exit(failures ? 1 : 0);
