// Titration MCP — CLI judge "door" invocation + output parsing + failure
// classification (PURE, import-clean).
//
// Self-hosted judges can run through a $0-marginal CLI
// subscription (claude, codex, grok) instead of a paid OpenRouter call. Each
// door has its own argv shape, its own place to read the answer from, and
// its own vendor-specific failure text — this module is the pure, offline
// part of all three: no process spawned, no filesystem touched (lib/judge-
// doors.ts does that). Deliberately independent of lib/judge.ts (concurrent
// edit elsewhere); the root wires the two together.

export type JudgeDoor = "codex" | "claude" | "grok";
export type DoorReasoningEffort = "low" | "medium" | "high";

// None of the three shares a vendor family with the Claude agent running the
// caller's own loop (goal-titrate-judge-model-spec §1.3's cross-vendor rule
// applies to CLI doors the same as it does to the OpenRouter panel).
export const DOOR_FAMILY: Readonly<Record<JudgeDoor, string>> = Object.freeze({
  claude: "anthropic",
  codex: "openai",
  grok: "x-ai",
});

// The exact system+user composition lib/judge.ts's callCodex uses today —
// judges get one prompt on stdin (or in a file, for doors with no stdin
// separation), never a system/user split the CLI itself understands.
export function composePrompt(system: string, user: string): string {
  return `${system}\n\n${"=".repeat(60)}\nINPUT TO EVALUATE:\n${"=".repeat(60)}\n\n${user}\n`;
}

export interface DoorInvocationInput {
  model: string;
  effort?: DoorReasoningEffort;
  // Overloaded by door: for grok this is where the caller must have already
  // written the composed prompt (an input file); for codex this is where the
  // caller should read the answer back from after the process exits (an
  // output file, per `outputFile: true` below). claude ignores it — its
  // prompt goes on stdin and its answer comes back on stdout.
  promptFile?: string;
}

export interface DoorInvocation {
  args: string[];
  stdin: boolean;      // true → the caller must write composePrompt(...) to the child's stdin
  outputFile?: boolean; // true → the answer is `promptFile`'s contents after the process exits, not stdout
}

export function buildDoorInvocation(door: JudgeDoor, input: DoorInvocationInput): DoorInvocation {
  const { model, effort, promptFile } = input;
  switch (door) {
    case "codex": {
      // codex exec has no system/user separation: one prompt on stdin ("-"),
      // the clean final answer captured with `-o <file>` (avoids header
      // noise mixed into stdout) — mirrors today's callCodex exactly, minus
      // the `shell:true` npm-shim workaround (cli-resolve never needs it).
      if (!promptFile) throw new Error("codex door invocation requires an output file path");
      const args = ["exec", "-m", model];
      if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
      args.push("--sandbox", "read-only", "--skip-git-repo-check", "-o", promptFile, "-");
      return { args, stdin: true, outputFile: true };
    }
    case "claude": {
      // Judges get zero tools — `--tools ""` per `claude --help` ("Use \"\"
      // to disable all tools"). `--effort` exists in `claude --help` too, so
      // it is passed whenever the judge spec names a reasoning effort.
      const args = ["-p", "--model", model, "--output-format", "text", "--no-session-persistence", "--tools", ""];
      if (effort) args.push("--effort", effort);
      return { args, stdin: true };
    }
    case "grok": {
      // grok has no stdin prompt mode for a single turn — `--prompt-file`
      // instead. `--tools ""` clears the built-in allow-list, `--disable-
      // web-search` removes the two tools that flag governs separately (per
      // `grok --help`, not covered by --tools/--allow), and `--no-subagents`
      // stops a subagent loop from reaching for tools of its own.
      if (!promptFile) throw new Error("grok door invocation requires a prompt file path");
      const args = ["--prompt-file", promptFile, "--output-format", "json"];
      if (effort) args.push("--reasoning-effort", effort);
      args.push("-m", model, "--tools", "", "--disable-web-search", "--no-subagents");
      return { args, stdin: false };
    }
    /* c8 ignore next 4 -- exhaustiveness guard, not a reachable branch */
    default: {
      const exhaustive: never = door;
      throw new Error(`unknown judge door: ${String(exhaustive)}`);
    }
  }
}

export interface DoorOutputInput {
  stdout: string;
  outputFileText?: string;
}

// grok-specific: `--output-format json` can still exit 0 with non-empty
// stdout when the turn was cut short before producing a final answer
// (observed live, 2026-09-02: `stopReason: "cancelled"`). A named, typed
// failure — never silently treated as success.
export class GrokStopReasonError extends Error {
  constructor(readonly stopReason: string) {
    super(`grok stopped without finishing (stopReason: ${stopReason})`);
    this.name = "GrokStopReasonError";
  }
}

// Returns the raw answer TEXT for the door (never parsed JSON — the judge
// verdict is JSON only for the referee's own grading schema, parsed by the
// existing loose parser in lib/judge.ts, not here). Throws when the door's
// own transport succeeded but produced nothing usable.
export function parseDoorOutput(door: JudgeDoor, input: DoorOutputInput): string {
  if (door === "codex") {
    const text = (input.outputFileText ?? "").trim();
    if (!text) throw new Error("codex produced no output file content");
    return text;
  }
  if (door === "claude") {
    const text = input.stdout.trim();
    if (!text) throw new Error("claude produced empty output");
    return text;
  }
  // grok
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.stdout);
  } catch {
    throw new Error("grok output is not valid JSON");
  }
  const record = parsed as { stopReason?: unknown; text?: unknown };
  const stopReason = typeof record.stopReason === "string" ? record.stopReason : "unparsable";
  if (stopReason !== "end_turn") throw new GrokStopReasonError(stopReason);
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!text) throw new Error("grok returned empty text");
  return text;
}

export type DoorFailureKind = "usage_limit" | "auth" | "timeout" | "exit";

export interface DoorFailure {
  kind: DoorFailureKind;
  retryable: boolean;
  message: string;
}

export interface DoorFailureInput {
  exitCode: number | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

// Reused (semantics, generalized past codex-only) from lib/judge.ts's
// callCodex HARD_FAIL-style quota/rate-limit text scan, plus a vendor-exact
// usage-limit literal (unambiguous regardless of context, unlike a bare "429").
const USAGE_LIMIT_EXACT_RE = /you've hit your usage limit|\b429 Too Many Requests\b/i;
const QUOTA_RE = /rate.?limit|quota|usage.?limit|too.?many.?requests|429/i;

// usage_limit and auth are never retryable (a retry burns the same quota or
// hits the same missing login again); a generic non-zero exit is retryable
// once (transient — malformed output, a flaky 5xx-equivalent, etc.).
export function classifyDoorFailure(door: JudgeDoor, input: DoorFailureInput): DoorFailure | null {
  if (input.timedOut) {
    return { kind: "timeout", retryable: false, message: `${door} timed out` };
  }
  if (input.exitCode === 0) return null;
  const combined = `${input.stderr ?? ""}\n${input.stdout ?? ""}`;
  if (USAGE_LIMIT_EXACT_RE.test(combined) || QUOTA_RE.test(combined)) {
    return { kind: "usage_limit", retryable: false, message: `${door} usage limit or quota exhausted` };
  }
  const authRe = new RegExp(`unauthorized|not.?authenticated|please.?login|${door}.?login`, "i");
  if (authRe.test(combined)) {
    return { kind: "auth", retryable: false, message: `${door} not authenticated (run: ${door} login)` };
  }
  return { kind: "exit", retryable: true, message: `${door} exited with code ${input.exitCode}` };
}
