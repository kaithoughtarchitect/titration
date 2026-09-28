// Records one REAL judge call per CLI door into lib/__tests__/fixtures/cli-doors/,
// so the offline replay suite asserts recorded transport behaviour rather than an
// ideal model. Uses the user's own subscription CLIs ($0 per call). Nothing
// secret is recorded: argv, exit code, raw stdout, the answer file, and stderr
// with anything key-shaped redacted.
//
// Run: npx tsx scripts/record-cli-door-fixtures.ts claude:claude-opus-5-5 codex:gpt-6-astra
//      (door:model pairs; add :effort to pass a reasoning effort, e.g. codex:gpt-6-astra:high)

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCliDoor } from "../lib/cli-resolve";
import {
  buildDoorInvocation,
  classifyDoorFailure,
  composePrompt,
  type DoorReasoningEffort,
  type JudgeDoor,
} from "../lib/judge-doors-core";
import { redactToolErrorText } from "../lib/tool-error-redaction-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// A minimal grading task in the engine's shape: a rubric, one output, JSON answer.
export const FIXTURE_SYSTEM =
  "You are a strict grader. Read the rubric and the output, then answer with JSON only: " +
  '{"label": "PASS" | "FAIL", "reason": "<one short sentence>"}. No prose outside the JSON.';
export const FIXTURE_USER =
  "RUBRIC: PASS if the output states the capital of France correctly, otherwise FAIL.\n\n" +
  "OUTPUT: The capital of France is Paris.";

async function record(door: JudgeDoor, model: string, effort?: DoorReasoningEffort) {
  const cli = await resolveCliDoor(door);
  if (!cli) throw new Error(`${door} CLI not available on PATH — cannot record`);
  const version = await new Promise<string>((done) => {
    const child = spawn(cli.executable, [...cli.prefixArgs, "--version"], { shell: false, windowsHide: true });
    let out = "";
    child.stdout?.on("data", (d) => { out += d.toString(); });
    child.on("close", () => done(out.trim()));
    child.on("error", () => done(""));
  });

  const prompt = composePrompt(FIXTURE_SYSTEM, FIXTURE_USER);
  const dir = await mkdtemp(join(tmpdir(), `titration-record-${door}-`));
  const promptFile = door === "grok" ? join(dir, "prompt.txt") : door === "codex" ? join(dir, "out.txt") : undefined;
  try {
    if (door === "grok" && promptFile) await writeFile(promptFile, prompt, "utf8");
    const invocation = buildDoorInvocation(door, { model, effort, promptFile });
    const started = Date.now();
    const result = await new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((done) => {
      const child = spawn(cli.executable, [...cli.prefixArgs, ...invocation.args], { shell: false, windowsHide: true });
      let stdout = "", stderr = "";
      child.stdout?.on("data", (d) => { stdout += d.toString(); });
      child.stderr?.on("data", (d) => { stderr += d.toString(); });
      child.on("close", (code) => done({ exitCode: code, stdout, stderr }));
      child.on("error", (e) => done({ exitCode: null, stdout, stderr: stderr + String(e) }));
      if (invocation.stdin) child.stdin?.write(prompt);
      child.stdin?.end();
    });
    const outputFileText = invocation.outputFile && promptFile ? await readFile(promptFile, "utf8").catch(() => "") : undefined;
    const failure = classifyDoorFailure(door, { exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout, timedOut: false });

    const fixture = {
      recorded: "real transport — one live call through the user's subscription CLI",
      door,
      model,
      effort: effort ?? null,
      cli_version: version,
      owner: cli.owner,
      // argv with the temp path normalized so the fixture is machine-independent
      args: invocation.args.map((a) => (promptFile && a === promptFile ? "<TEMP_FILE>" : a)),
      stdin: invocation.stdin,
      exit_code: result.exitCode,
      duration_ms: Date.now() - started,
      stdout: result.stdout,
      output_file_text: outputFileText ?? null,
      stderr: redactToolErrorText(result.stderr.slice(0, 4000)),
      failure,
    };
    const outDir = join(root, "lib", "__tests__", "fixtures", "cli-doors", door);
    await mkdir(outDir, { recursive: true });
    const outPath = join(outDir, `${model.replace(/[^a-z0-9.-]/gi, "_")}.json`);
    await writeFile(outPath, JSON.stringify(fixture, null, 2) + "\n", "utf8");
    console.log(`${door} (${model}) → exit ${result.exitCode}, ${failure ? `FAILURE ${failure.kind}` : "ok"} → ${outPath}`);
    if (failure) process.exitCode = 1;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const pairs = process.argv.slice(2);
if (!pairs.length) {
  console.error("usage: npx tsx scripts/record-cli-door-fixtures.ts <door:model[:effort]> …");
  process.exit(2);
}
for (const pair of pairs) {
  const [door, model, effort] = pair.split(":") as [JudgeDoor, string, DoorReasoningEffort | undefined];
  if (!["claude", "codex", "grok"].includes(door) || !model) throw new Error(`bad pair ${pair}`);
  await record(door, model, effort);
}
