// Titration MCP — CLI judge door invocation/output/failure unit test (no
// network, no real CLI, no spawn). All inputs below are "ideal-model": shapes
// projected from `claude --help` / `grok --help` and callCodex's own failure
// text, not a captured real-transport receipt — the root records
// real-transport fixtures separately.
// Run: npx tsx lib/__tests__/judge-doors-core.test.ts

import {
  DOOR_FAMILY,
  GrokStopReasonError,
  buildDoorInvocation,
  classifyDoorFailure,
  composePrompt,
  parseDoorOutput,
} from "../judge-doors-core";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}

// ── DOOR_FAMILY ────────────────────────────────────────────────────────────

check("door family: claude → anthropic, codex → openai, grok → x-ai",
  DOOR_FAMILY.claude === "anthropic" && DOOR_FAMILY.codex === "openai" && DOOR_FAMILY.grok === "x-ai");

// ── composePrompt: byte-exact to today's callCodex prompt format ──────────

{
  // ideal-model: two short strings, no special characters.
  const got = composePrompt("SYSTEM", "USER");
  const want = `SYSTEM\n\n${"=".repeat(60)}\nINPUT TO EVALUATE:\n${"=".repeat(60)}\n\nUSER\n`;
  check("composePrompt byte-exact", got === want, JSON.stringify(got));
}

// ── buildDoorInvocation: argv is always an array of discrete elements ─────
// (a path containing a space must survive as ONE array element, never get
// string-joined and re-split by a shell — shell:false in the I/O layer means
// this is the only thing standing between a space in a temp path and a
// broken invocation.)

const SPACEY_PATH = "C:\\Users\\demo\\AppData\\Local\\Temp\\titration prompt.txt"; // ideal-model temp path

{
  // codex, with effort
  const inv = buildDoorInvocation("codex", { model: "gpt-5.5", effort: "high", promptFile: SPACEY_PATH });
  check("codex argv (with effort) is discrete array elements",
    JSON.stringify(inv.args) === JSON.stringify([
      "exec", "-m", "gpt-5.5", "-c", 'model_reasoning_effort="high"',
      "--sandbox", "read-only", "--skip-git-repo-check", "-o", SPACEY_PATH, "-",
    ]), JSON.stringify(inv.args));
  check("codex invocation reads prompt from stdin and answer from output file", inv.stdin === true && inv.outputFile === true);
}
{
  // codex, no effort — the -c pair is omitted entirely, not passed empty
  const inv = buildDoorInvocation("codex", { model: "gpt-5.5", promptFile: SPACEY_PATH });
  check("codex argv (no effort) omits the -c pair",
    JSON.stringify(inv.args) === JSON.stringify([
      "exec", "-m", "gpt-5.5", "--sandbox", "read-only", "--skip-git-repo-check", "-o", SPACEY_PATH, "-",
    ]), JSON.stringify(inv.args));
}
{
  // claude, with effort
  const inv = buildDoorInvocation("claude", { model: "claude-fable-5", effort: "high" });
  check("claude argv (with effort) is discrete array elements, tools disabled",
    JSON.stringify(inv.args) === JSON.stringify([
      "-p", "--model", "claude-fable-5", "--output-format", "text", "--no-session-persistence", "--tools", "", "--effort", "high",
    ]), JSON.stringify(inv.args));
  check("claude invocation reads prompt from stdin, answer from stdout (no output file)", inv.stdin === true && inv.outputFile === undefined);
}
{
  // claude, no effort — --effort is omitted entirely
  const inv = buildDoorInvocation("claude", { model: "claude-fable-5" });
  check("claude argv (no effort) omits --effort",
    JSON.stringify(inv.args) === JSON.stringify([
      "-p", "--model", "claude-fable-5", "--output-format", "text", "--no-session-persistence", "--tools", "",
    ]), JSON.stringify(inv.args));
}
{
  // grok, with effort
  const inv = buildDoorInvocation("grok", { model: "grok-4.3", effort: "high", promptFile: SPACEY_PATH });
  check("grok argv (with effort) is discrete array elements, tools disabled",
    JSON.stringify(inv.args) === JSON.stringify([
      "--prompt-file", SPACEY_PATH, "--output-format", "json", "--reasoning-effort", "high",
      "-m", "grok-4.3", "--tools", "", "--disable-web-search", "--no-subagents",
    ]), JSON.stringify(inv.args));
  check("grok invocation reads prompt from its file, not stdin", inv.stdin === false && inv.outputFile === undefined);
}
{
  // grok, no effort — --reasoning-effort is omitted entirely
  const inv = buildDoorInvocation("grok", { model: "grok-4.3", promptFile: SPACEY_PATH });
  check("grok argv (no effort) omits --reasoning-effort",
    JSON.stringify(inv.args) === JSON.stringify([
      "--prompt-file", SPACEY_PATH, "--output-format", "json",
      "-m", "grok-4.3", "--tools", "", "--disable-web-search", "--no-subagents",
    ]), JSON.stringify(inv.args));
}
{
  let threw = false;
  try { buildDoorInvocation("codex", { model: "gpt-5.5" }); } catch { threw = true; }
  check("codex invocation without a promptFile (output path) refuses rather than guessing", threw);
}
{
  let threw = false;
  try { buildDoorInvocation("grok", { model: "grok-4.3" }); } catch { threw = true; }
  check("grok invocation without a promptFile refuses rather than guessing", threw);
}

// ── parseDoorOutput ─────────────────────────────────────────────────────────

check("codex: reads the output file, not stdout",
  parseDoorOutput("codex", { stdout: "ignored header noise", outputFileText: '{"verdict":"ok"}' }) === '{"verdict":"ok"}');
{
  let threw = false;
  try { parseDoorOutput("codex", { stdout: "", outputFileText: "   " }); } catch { threw = true; }
  check("codex: blank output file throws", threw);
}
check("claude: reads stdout directly",
  parseDoorOutput("claude", { stdout: '  {"verdict":"ok"}  ' }) === '{"verdict":"ok"}');
{
  let threw = false;
  try { parseDoorOutput("claude", { stdout: "   " }); } catch { threw = true; }
  check("claude: blank stdout throws", threw);
}
{
  // ideal-model grok JSON, shaped like the door's own grokParsedTextOf/grokStopReasonOf.
  const stdout = JSON.stringify({ stopReason: "end_turn", text: '{"verdict":"ok"}' });
  check("grok: end_turn + text parses", parseDoorOutput("grok", { stdout }) === '{"verdict":"ok"}');
}
{
  const stdout = JSON.stringify({ stopReason: "cancelled", text: "" });
  let threw: unknown = null;
  try { parseDoorOutput("grok", { stdout }); } catch (e) { threw = e; }
  check("grok: non-end_turn stopReason throws a named GrokStopReasonError",
    threw instanceof GrokStopReasonError && (threw as GrokStopReasonError).stopReason === "cancelled");
}
{
  let threw = false;
  try { parseDoorOutput("grok", { stdout: "not json" }); } catch { threw = true; }
  check("grok: unparsable JSON throws", threw);
}
{
  const stdout = JSON.stringify({ stopReason: "end_turn", text: "   " });
  let threw = false;
  try { parseDoorOutput("grok", { stdout }); } catch { threw = true; }
  check("grok: end_turn with empty text still throws (transport success is not sufficient)", threw);
}

// ── classifyDoorFailure ──────────────────────────────────────────────────

check("exit 0 → null (no failure)",
  classifyDoorFailure("codex", { exitCode: 0, stderr: "", stdout: "", timedOut: false }) === null);

check("timeout → non-retryable timeout, regardless of exit code",
  JSON.stringify(classifyDoorFailure("claude", { exitCode: null, stderr: "", stdout: "", timedOut: true }))
  === JSON.stringify({ kind: "timeout", retryable: false, message: "claude timed out" }));

{
  // ideal-model: the exact vendor literal detectUsageLimit matches on.
  const failure = classifyDoorFailure("claude", { exitCode: 1, stderr: "You've hit your usage limit for this session.", stdout: "", timedOut: false });
  check("usage-limit exact literal → non-retryable usage_limit", failure?.kind === "usage_limit" && failure.retryable === false, JSON.stringify(failure));
}
{
  // ideal-model: bare 429, matched by callCodex's original loose quota regex.
  const failure = classifyDoorFailure("grok", { exitCode: 1, stderr: "HTTP 429 Too Many Requests", stdout: "", timedOut: false });
  check("429 → non-retryable usage_limit", failure?.kind === "usage_limit" && failure.retryable === false, JSON.stringify(failure));
}
{
  // ideal-model: quota wording without the word "limit".
  const failure = classifyDoorFailure("codex", { exitCode: 1, stderr: "codex quota exhausted", stdout: "", timedOut: false });
  check("quota wording → non-retryable usage_limit", failure?.kind === "usage_limit" && failure.retryable === false, JSON.stringify(failure));
}
{
  // ideal-model: door-specific login hint, mirrors callCodex's "codex login" check generalized per door.
  const failure = classifyDoorFailure("codex", { exitCode: 1, stderr: "codex not authenticated (run: codex login)", stdout: "", timedOut: false });
  check("login/unauthorized (door-specific) → non-retryable auth", failure?.kind === "auth" && failure.retryable === false, JSON.stringify(failure));
}
{
  const failure = classifyDoorFailure("claude", { exitCode: 1, stderr: "Error: unauthorized", stdout: "", timedOut: false });
  check("login/unauthorized (generic) → non-retryable auth", failure?.kind === "auth" && failure.retryable === false, JSON.stringify(failure));
}
{
  // ideal-model: a plain non-zero exit with no quota/auth/timeout signal.
  const failure = classifyDoorFailure("grok", { exitCode: 1, stderr: "unexpected internal error", stdout: "", timedOut: false });
  check("plain exit 1 → retryable exit", JSON.stringify(failure) === JSON.stringify({ kind: "exit", retryable: true, message: "grok exited with code 1" }), JSON.stringify(failure));
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
