// Import-graph check: walks every relative import reachable from the entry points
// and fails if any resolves outside the tree, to a missing file, or to a module on
// the removed-module deny-list. Offline; import extraction uses the TypeScript compiler API
// (typescript is a devDependency) rather than a hand-rolled regex, so it tracks the
// language's actual import/export/dynamic-import grammar instead of approximating it.
// Run: node scripts/import-graph-check.mjs
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const ENTRY_POINTS = [
  "server/server.ts",
  "ingest/ingest-base.ts",
  "ingest/embed-cards.ts",
  "query/card-search.ts",
  "retrieval-eval/run.ts",
  "scripts/migrate.ts",
];

export const DENIED = [
  /^cockpit\//,
  /^bridge\//,
  /^client\//,
  /^lib\/(hosted-context-core|interactive-workflow-core|provider-credential-core|provider-credentials|knowledge-visibility-core|corpus-sync-core|harness-session-core|harness-design-visibility-core|adaptation-[\w-]+)\.ts$/,
  /^server\/(http-mcp|worker|evolution-input|evolution-repair|client-binding)\.ts$/,
];

function resolveSpecifier(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base, `${base}.ts`, `${base}.mts`, `${base}.mjs`, `${base}.js`, `${base}.json`, join(base, "index.ts")];
  if (/\.js$/.test(base)) candidates.push(base.replace(/\.js$/, ".ts"));
  return candidates.find((c) => existsSync(c) && !c.endsWith("/")) ?? null;
}

// Static imports/exports-from, side-effect imports, and dynamic import() — the same
// set the old regex targeted, but read from the real parser instead of approximated.
function importedSpecifiers(text) {
  return ts.preProcessFile(text, /* readImportFiles */ true, /* detectJavaScriptImports */ true)
    .importedFiles
    .map((f) => f.fileName);
}

export function walk(entries = ENTRY_POINTS) {
  const seen = new Set();
  const problems = [];
  const queue = entries.map((e) => resolve(root, e));
  while (queue.length) {
    const file = queue.pop();
    const rel = relative(root, file).replace(/\\/g, "/");
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!existsSync(file)) { problems.push(`missing entry ${rel}`); continue; }
    const text = readFileSync(file, "utf8");
    for (const spec of importedSpecifiers(text)) {
      if (!spec || !spec.startsWith(".")) continue;
      const target = resolveSpecifier(file, spec);
      if (!target) { problems.push(`${rel} → unresolved ${spec}`); continue; }
      const trel = relative(root, target).replace(/\\/g, "/");
      if (trel.startsWith("..")) { problems.push(`${rel} → outside tree ${spec}`); continue; }
      if (DENIED.some((re) => re.test(trel))) { problems.push(`${rel} → denied ${trel}`); continue; }
      queue.push(target);
    }
  }
  return { files: [...seen].sort(), problems };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { files, problems } = walk();
  if (process.argv.includes("--list")) console.log(files.join("\n"));
  if (problems.length) {
    console.error(`import-graph: ${problems.length} problem(s)\n` + problems.join("\n"));
    process.exit(1);
  }
  console.log(`import-graph: ${files.length} files reachable, no denied or missing edges`);
}
