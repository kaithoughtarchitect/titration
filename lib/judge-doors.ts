// Titration MCP — CLI judge "door" I/O: resolves the door's CLI, spawns it,
// and returns the raw answer text. See lib/judge-doors-core.ts for argv
// construction, prompt composition, output parsing, and failure
// classification — all pure and unit-tested offline; this file is the thin
// process/filesystem shell around it.

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCliDoor } from "./cli-resolve";
import type { ResolvedCli } from "./cli-resolve-core";
import {
  buildDoorInvocation,
  classifyDoorFailure,
  composePrompt,
  parseDoorOutput,
  type DoorReasoningEffort,
  type JudgeDoor,
} from "./judge-doors-core";

const DOOR_TIMEOUT_MS = 180_000; // matches the OpenRouter judge timeout in lib/judge.ts

export interface CallDoorOptions {
  model: string;
  effort?: DoorReasoningEffort;
  timeoutMs?: number; // defaults to DOOR_TIMEOUT_MS; long-form helper calls pass more
}

export interface CallDoorDeps {
  resolve?: (door: JudgeDoor) => Promise<ResolvedCli | null>;
  spawn?: typeof nodeSpawn;
}

interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runOnce(cli: ResolvedCli, args: string[], stdinText: string | undefined, deps: CallDoorDeps, timeoutMs: number): Promise<SpawnResult> {
  const spawnFn = deps.spawn ?? nodeSpawn;
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let child: ChildProcess;
    try {
      child = spawnFn(cli.executable, [...cli.prefixArgs, ...args], { shell: false, windowsHide: true });
    } catch (err: any) {
      resolvePromise({ exitCode: null, stdout: "", stderr: String(err?.message ?? err), timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ exitCode, stdout, stderr, timedOut });
    };
    child.on("error", (err) => { stderr += String(err?.message ?? err); finish(null); });
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code) => finish(code));
    child.stdin?.on("error", () => { /* recorded via exit-code path; never hangs the caller */ });
    if (stdinText !== undefined) {
      child.stdin?.write(stdinText);
    }
    child.stdin?.end();
  });
}

// Returns the door's raw answer TEXT (the caller — lib/judge.ts, once wired
// — parses JSON with the existing loose parser, same as the OpenRouter and
// codex paths do today). Resolution failure and door failure both throw:
// fail-closed, never a success-shaped empty verdict.
export async function callDoor(
  door: JudgeDoor,
  options: CallDoorOptions,
  system: string,
  user: string,
  deps: CallDoorDeps = {},
): Promise<string> {
  const resolveFn = deps.resolve ?? resolveCliDoor;
  const cli = await resolveFn(door);
  if (!cli) throw new Error(`${door} CLI not available`);

  const prompt = composePrompt(system, user);
  const dir = await mkdtemp(join(tmpdir(), `titration-${door}-`));
  const promptFile = door === "grok" ? join(dir, "prompt.txt")
    : door === "codex" ? join(dir, "out.txt")
    : undefined;

  try {
    if (door === "grok" && promptFile) await writeFile(promptFile, prompt, "utf8");

    const invocation = buildDoorInvocation(door, { model: options.model, effort: options.effort, promptFile });
    const stdinText = invocation.stdin ? prompt : undefined;

    const attempt = async (): Promise<{ result: SpawnResult; outputFileText?: string }> => {
      const result = await runOnce(cli, invocation.args, stdinText, deps, options.timeoutMs ?? DOOR_TIMEOUT_MS);
      const outputFileText = invocation.outputFile && promptFile
        ? await readFile(promptFile, "utf8").catch(() => "")
        : undefined;
      return { result, outputFileText };
    };

    let { result, outputFileText } = await attempt();
    let failure = classifyDoorFailure(door, {
      exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout, timedOut: result.timedOut,
    });
    if (failure?.retryable) {
      ({ result, outputFileText } = await attempt());
      failure = classifyDoorFailure(door, {
        exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout, timedOut: result.timedOut,
      });
    }
    if (failure) throw new Error(failure.message);

    return parseDoorOutput(door, { stdout: result.stdout, outputFileText });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
