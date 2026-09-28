// Titration MCP — callDoor timeout plumbing (no real CLI; a fake child process).
// Judges keep the default door timeout; long-form helper calls pass a longer
// timeoutMs. This checks the option actually reaches the process timer.
// Ideal-model: the fake child only emits the events runOnce listens for.
// Run: npx tsx lib/__tests__/judge-doors-timeout.test.ts

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { callDoor } from "../judge-doors";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}

// A child that answers after `answerAfterMs`, unless it is killed first.
function fakeSpawn(answerAfterMs: number) {
  return (() => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    const timer = setTimeout(() => {
      child.stdout.write('{"label":"PASS","reason":"ok"}');
      child.emit("close", 0);
    }, answerAfterMs);
    child.kill = () => { clearTimeout(timer); setImmediate(() => child.emit("close", null)); return true; };
    return child;
  }) as any;
}

const resolve = async () => ({ door: "claude" as const, executable: "claude", prefixArgs: [], owner: "npm-verified" as const, version: "test" });

{
  let err = "";
  const started = Date.now();
  try {
    await callDoor("claude", { model: "m", timeoutMs: 50 }, "sys", "user", { resolve, spawn: fakeSpawn(5_000) });
  } catch (e: any) {
    err = String(e?.message ?? e);
  }
  check("a short timeoutMs kills a slow door and reports a timeout", /timed out/.test(err), err);
  check("the short timeoutMs is honoured (well under the 180 s default)", Date.now() - started < 2_000, `${Date.now() - started} ms`);
}

{
  const out = await callDoor("claude", { model: "m", timeoutMs: 2_000 }, "sys", "user", { resolve, spawn: fakeSpawn(100) });
  check("a door that answers inside timeoutMs returns its answer", out.includes('"PASS"'), out);
}

console.log(failures ? `\n${failures} failure(s)` : "\nall judge-doors timeout checks passed");
process.exit(failures ? 1 : 0);
