// Offline unit-suite runner: globs lib/__tests__/*.test.ts and runs each under tsx.
// Cross-platform (no shell loop). Exit 0 only if every suite passes. ($0, no DB/network.)
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "lib", "__tests__");
const tests = readdirSync(dir).filter((f) => f.endsWith(".test.ts")).sort();

let pass = 0;
const failed = [];
for (const t of tests) {
  const rel = join("lib", "__tests__", t);
  const r = spawnSync("npx", ["tsx", rel], { cwd: here, stdio: "inherit", shell: true });
  if (r.status === 0) { pass++; } else { failed.push(t); }
}

console.log(`\n${pass}/${tests.length} suites passed${failed.length ? ` — FAILED: ${failed.join(", ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
