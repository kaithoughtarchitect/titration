// Titration MCP — CLI judge doors replayed against REAL recorded transport
// (no network, no CLI spawn, $0). Fixtures are written by
// scripts/record-cli-door-fixtures.ts from one live call per door.
// Run: npx tsx lib/__tests__/cli-door-replay.test.ts

import { readFileSync } from "node:fs";
import { buildDoorInvocation, classifyDoorFailure, parseDoorOutput, type JudgeDoor } from "../judge-doors-core";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}

interface Fixture {
  recorded: string;
  door: JudgeDoor;
  model: string;
  effort: "low" | "medium" | "high" | null;
  args: string[];
  stdin: boolean;
  exit_code: number | null;
  stdout: string;
  output_file_text: string | null;
  stderr: string;
}

function load(path: string): Fixture {
  return JSON.parse(readFileSync(new URL(`./fixtures/cli-doors/${path}`, import.meta.url), "utf8"));
}

function parseAnswer(text: string): any {
  const t = text.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  try { return JSON.parse(t); } catch { /* fall through */ }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  return JSON.parse(t.slice(a, b + 1));
}

// ── claude: recorded success ────────────────────────────────────────────────
{
  const f = load("claude/claude-opus-5-5.json");
  check("claude fixture is a real recording", /real transport/.test(f.recorded));
  const rebuilt = buildDoorInvocation("claude", { model: f.model, effort: f.effort ?? undefined });
  check("claude argv today equals the recorded argv", JSON.stringify(rebuilt.args) === JSON.stringify(f.args), JSON.stringify(rebuilt.args));
  check("claude takes the prompt on stdin", rebuilt.stdin === true && f.stdin === true);
  check("claude recorded call exited 0", f.exit_code === 0);
  check(
    "claude recorded exit classifies as success",
    classifyDoorFailure("claude", { exitCode: f.exit_code, stderr: f.stderr, stdout: f.stdout, timedOut: false }) === null,
  );
  const answer = parseAnswer(parseDoorOutput("claude", { stdout: f.stdout }));
  check("claude answer parses to the grading JSON shape", answer?.label === "PASS" && typeof answer?.reason === "string", JSON.stringify(answer));
}

// ── codex: recorded success ─────────────────────────────────────────────────
{
  const f = load("codex/gpt-6-astra.json");
  check("codex success fixture is a real recording", /real transport/.test(f.recorded));
  const rebuilt = buildDoorInvocation("codex", { model: f.model, effort: f.effort ?? undefined, promptFile: "<TEMP_FILE>" });
  check("codex argv today equals the recorded success argv", JSON.stringify(rebuilt.args) === JSON.stringify(f.args), JSON.stringify(rebuilt.args));
  check("codex takes the prompt on stdin", rebuilt.stdin === true && f.stdin === true);
  check("codex recorded call exited 0", f.exit_code === 0);
  check(
    "codex recorded exit classifies as success",
    classifyDoorFailure("codex", { exitCode: f.exit_code, stderr: f.stderr, stdout: f.stdout, timedOut: false }) === null,
  );
  const answer = parseAnswer(parseDoorOutput("codex", { stdout: f.stdout, outputFileText: f.output_file_text ?? undefined }));
  check("codex answer parses to the grading JSON shape", answer?.label === "PASS" && typeof answer?.reason === "string", JSON.stringify(answer));
}

// ── codex: recorded usage-limit failure (real transport) ────────────────────
{
  const f = load("codex/gpt-6-astra.usage-limit.json");
  check("codex fixture is a real recording", /real transport/.test(f.recorded));
  const rebuilt = buildDoorInvocation("codex", { model: f.model, effort: f.effort ?? undefined, promptFile: "<TEMP_FILE>" });
  check("codex argv today equals the recorded argv", JSON.stringify(rebuilt.args) === JSON.stringify(f.args), JSON.stringify(rebuilt.args));
  const failure = classifyDoorFailure("codex", { exitCode: f.exit_code, stderr: f.stderr, stdout: f.stdout, timedOut: false });
  check("codex recorded usage-limit is classified usage_limit", failure?.kind === "usage_limit", JSON.stringify(failure));
  check("codex usage-limit is not retried", failure?.retryable === false);
}

console.log(failures ? `\n${failures} failure(s)` : "\nall cli-door replay checks passed");
process.exit(failures ? 1 : 0);
