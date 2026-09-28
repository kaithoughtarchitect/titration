// Titration MCP — CLI door resolution unit test (no network, no real CLI).
// Exercises the generalized codex/claude/grok door table: unowned PATH executable
// never selected; wrong package name rejected; valid npm package accepted;
// a ".js" launcher runs through node; claude's ".exe" bin runs directly;
// grok (native, no npm package) is found by filename; nothing found → null.
// Fixture package.json shapes below are real probed-machine facts (name/bin,
// recorded verbatim), not a guess — "ideal-model" only in that the executable
// file contents are inert (never executed).
// Run: npx tsx lib/__tests__/cli-resolve-core.test.ts

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  DOOR_TABLE,
  absolutePathDirectories,
  launcherInvocation,
  npmPackageJsonPath,
  validatedBinPath,
} from "../cli-resolve-core";
import { resolveCliDoor } from "../cli-resolve";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}

// ── pure-core checks (no filesystem) ──────────────────────────────────────

check("door table has exactly codex, claude, grok", JSON.stringify(Object.keys(DOOR_TABLE).sort()) === JSON.stringify(["claude", "codex", "grok"]));
check("codex is an npm door on @openai/codex#codex", DOOR_TABLE.codex.kind === "npm" && (DOOR_TABLE.codex as any).packageName === "@openai/codex" && (DOOR_TABLE.codex as any).binKey === "codex");
check("claude is an npm door on @anthropic-ai/claude-code#claude", DOOR_TABLE.claude.kind === "npm" && (DOOR_TABLE.claude as any).packageName === "@anthropic-ai/claude-code" && (DOOR_TABLE.claude as any).binKey === "claude");
check("grok is native-unverified (no npm package to check)", DOOR_TABLE.grok.kind === "native" && (DOOR_TABLE.grok as any).owner === "native-unverified");

check("relative PATH entries are ignored", JSON.stringify(absolutePathDirectories(["relative-path", "C:\\ok"].join(delimiter))) === JSON.stringify(["C:\\ok"]));

check("wrong package name is never validated", validatedBinPath({ name: "unrelated", bin: { codex: "bin/codex.js" } }, DOOR_TABLE.codex as any) === null);
check("missing bin key is never validated", validatedBinPath({ name: "@openai/codex", bin: { other: "bin/other.js" } }, DOOR_TABLE.codex as any) === null);
check("matching name + bin key validates to the declared path (file existence is an I/O-layer check, not this one)", validatedBinPath({ name: "@openai/codex", bin: { codex: "bin/other.js" } }, DOOR_TABLE.codex as any) === "bin/other.js");

{
  const pj = join("C:\\pkg", "node_modules", "@openai", "codex", "package.json");
  const invocation = launcherInvocation(pj, "bin/codex.js", "C:\\node.exe");
  check(".js launcher runs through node", JSON.stringify(invocation) === JSON.stringify({ executable: "C:\\node.exe", prefixArgs: [join("C:\\pkg", "node_modules", "@openai", "codex", "bin", "codex.js")] }));
}
{
  const pj = join("C:\\pkg", "node_modules", "@anthropic-ai", "claude-code", "package.json");
  const invocation = launcherInvocation(pj, "bin/claude.exe", "C:\\node.exe");
  check(".exe launcher is the executable itself", JSON.stringify(invocation) === JSON.stringify({ executable: join("C:\\pkg", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"), prefixArgs: [] }));
}
check(".cmd shim is never a valid launcher", launcherInvocation("C:\\pkg\\package.json", "bin/codex.cmd", "C:\\node.exe") === null);
check(".ps1 shim is never a valid launcher", launcherInvocation("C:\\pkg\\package.json", "bin/codex.ps1", "C:\\node.exe") === null);

check("npm package.json path assumes global-install siblings", npmPackageJsonPath("C:\\npm", "@openai/codex") === join("C:\\npm", "node_modules", "@openai", "codex", "package.json"));

// ── end-to-end resolution against real temp-dir filesystem layouts ───────

const root = await mkdtemp(join(tmpdir(), "cli-resolve-"));
try {
  // 1. Unowned PATH executable must never be selected, even when it has the
  // right filename — no owning package metadata exists anywhere on PATH.
  const shadow = join(root, "shadow");
  await mkdir(shadow, { recursive: true });
  const impostor = join(shadow, process.platform === "win32" ? "codex.exe" : "codex");
  await writeFile(impostor, "#!/bin/sh\necho impostor\n");
  await chmod(impostor, 0o755);
  check("unowned PATH executable never selected", await resolveCliDoor("codex", { searchPath: shadow }) === null);

  // 2. Wrong package name under the right node_modules layout is rejected.
  const wrongName = join(root, "wrong-name");
  const wrongNamePkgDir = join(wrongName, "node_modules", "@openai", "codex");
  await mkdir(join(wrongNamePkgDir, "bin"), { recursive: true });
  await writeFile(join(wrongNamePkgDir, "package.json"), JSON.stringify({ name: "unrelated", bin: { codex: "bin/codex.js" } }));
  await writeFile(join(wrongNamePkgDir, "bin", "codex.js"), "throw new Error('must not be executed');\n");
  check("wrong package name rejected", await resolveCliDoor("codex", { searchPath: wrongName }) === null);

  // 2b. Matching name AND bin key, but the declared launcher file itself
  // does not exist — package name + bin key alone does not validate the
  // launcher; the file has to actually be there.
  const missingLauncher = join(root, "missing-launcher");
  const missingLauncherPkgDir = join(missingLauncher, "node_modules", "@openai", "codex");
  await mkdir(join(missingLauncherPkgDir, "bin"), { recursive: true });
  await writeFile(join(missingLauncherPkgDir, "package.json"), JSON.stringify({ name: "@openai/codex", bin: { codex: "bin/other.js" } }));
  // Note: "bin/codex.js" is written, not the declared "bin/other.js".
  await writeFile(join(missingLauncherPkgDir, "bin", "codex.js"), "// not the declared launcher\n");
  check("package name + bin key alone does not validate a missing launcher file", await resolveCliDoor("codex", { searchPath: missingLauncher }) === null);

  // 3. Valid npm package (codex, .js bin) accepted and run through node.
  const good = join(root, "good");
  const codexPkgDir = join(good, "node_modules", "@openai", "codex");
  await mkdir(join(codexPkgDir, "bin"), { recursive: true });
  await writeFile(join(codexPkgDir, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.157.0", bin: { codex: "bin/codex.js" } }));
  const codexLauncher = join(codexPkgDir, "bin", "codex.js");
  await writeFile(codexLauncher, "// inert — resolver must never execute this\n");
  await chmod(codexLauncher, 0o755);
  const resolvedCodex = await resolveCliDoor("codex", { searchPath: good, platform: "win32", arch: "x64" });
  check(".js launcher runs through node", JSON.stringify(resolvedCodex) === JSON.stringify({ door: "codex", executable: process.execPath, prefixArgs: [codexLauncher], owner: "npm-verified", version: "0.157.0" }), JSON.stringify(resolvedCodex));

  // 4. Valid npm package (claude, .exe bin) runs directly, no node prefix.
  const claudePkgDir = join(good, "node_modules", "@anthropic-ai", "claude-code");
  await mkdir(join(claudePkgDir, "bin"), { recursive: true });
  await writeFile(join(claudePkgDir, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version: "2.1.282", bin: { claude: "bin/claude.exe" } }));
  const claudeLauncher = join(claudePkgDir, "bin", "claude.exe");
  await writeFile(claudeLauncher, "inert — resolver must never execute this");
  await chmod(claudeLauncher, 0o755);
  const resolvedClaude = await resolveCliDoor("claude", { searchPath: good });
  check("claude .exe bin runs directly", JSON.stringify(resolvedClaude) === JSON.stringify({ door: "claude", executable: claudeLauncher, prefixArgs: [], owner: "npm-verified", version: "2.1.282" }), JSON.stringify(resolvedClaude));

  // 5. grok: native-only, found by filename, no package metadata involved.
  const grokDir = join(root, "grok-native");
  await mkdir(grokDir, { recursive: true });
  const grokExe = join(grokDir, process.platform === "win32" ? "grok.exe" : "grok");
  await writeFile(grokExe, "inert — resolver must never execute this");
  const resolvedGrok = await resolveCliDoor("grok", { searchPath: grokDir, platform: process.platform });
  check("grok native found", JSON.stringify(resolvedGrok) === JSON.stringify({ door: "grok", executable: grokExe, prefixArgs: [], owner: "native-unverified" }), JSON.stringify(resolvedGrok));

  // 6. Nothing found anywhere on PATH → null (never a throw).
  const empty = join(root, "empty");
  await mkdir(empty, { recursive: true });
  check("codex not found → null", await resolveCliDoor("codex", { searchPath: empty }) === null);
  check("claude not found → null", await resolveCliDoor("claude", { searchPath: empty }) === null);
  check("grok not found → null", await resolveCliDoor("grok", { searchPath: empty }) === null);

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
} finally {
  await rm(root, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
