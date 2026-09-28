// OpenRouter U1/U2 admission ledger (no network, no DB, no model — $0).
// Pins: commissioned slugs in order; a row is admitted only when recorded
// live transport files exist for effort honor + snapshot contract; zero admits
// is a valid ship; admission.json must not invent index/price/P50.
// Mirrors dedupe-core.test.ts (check/total/failures + process.exit).
// Run: npx tsx lib/__tests__/openrouter-fixture-admission.test.ts

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const COMMISSIONED_IDS = [
  "anthropic/claude-opus-5",
  "openai/gpt-5.6-sol",
  "moonshotai/kimi-k3",
  "qwen/qwen3.8-max",
  "meta/muse-spark-1.2",
  "google/gemini-3.7-flash",
  "deepseek/deepseek-v4-pro-0813",
  "z-ai/glm-5.3",
  "deepseek/deepseek-v4-flash-0731",
  "x-ai/grok-4.6",
  "minimax/minimax-m3",
  "minimax/minimax-m2.7-20260318:nitro",
  "openai/gpt-oss-120b:nitro",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-luna",
  "google/gemini-3.8-flash",
  "z-ai/glm-5.3-flash",
  "meta/muse-spark-1.3",
  "qwen/qwen3.8-max-0902",
  "openai/gpt-6-sol",
  "openai/gpt-6-luna",
  "deepseek/deepseek-v4.1-flash",
  "x-ai/grok-4.7",
] as const;

const EFFORT_FILES = ["effort-low.json", "effort-medium.json", "effort-high.json"] as const;
const SNAPSHOT_FILES = ["model.json", "endpoints.json"] as const;
const ADMITTED_ROW_KEYS = new Set(["id", "status"]);
const HALTED_ROW_KEYS = new Set(["id", "status", "reason"]);
const INVENTED_METRIC_KEYS = new Set([
  "agentic_index",
  "p50",
  "price",
  "pricing",
  "latency",
  "throughput",
  "latency_last_30m",
  "throughput_last_30m",
  "prompt_price",
  "completion_price",
]);

type AdmissionStatus = "admitted" | "halted";

type AdmissionRow = {
  id: string;
  status: AdmissionStatus;
  reason?: string;
};

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail = ""): void {
  total++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "openrouter");
const admissionPath = join(fixtureRoot, "admission.json");
const recordedDir = join(fixtureRoot, "recorded");
const readmePath = join(fixtureRoot, "README.md");

function recordedIdDir(id: string): string {
  return join(recordedDir, id.replaceAll("/", "__").replaceAll(":", "--"));
}

function hasRecordedFiles(id: string, files: readonly string[]): boolean {
  const dir = recordedIdDir(id);
  return files.every((file) => existsSync(join(dir, file)));
}

function mayAdmit(id: string): boolean {
  return hasRecordedFiles(id, EFFORT_FILES) && hasRecordedFiles(id, SNAPSHOT_FILES);
}

function collectKeys(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    into.add(key);
    collectKeys(nested, into);
  }
}

function parseAdmission(raw: unknown): AdmissionRow[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("admission.json must be an object with candidates[]");
  }
  const body = raw as { candidates?: unknown };
  if (!Array.isArray(body.candidates)) {
    throw new Error("admission.json.candidates must be an array");
  }
  return body.candidates.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`candidates[${index}] must be an object`);
    }
    const row = entry as Record<string, unknown>;
    const keys = Object.keys(row);
    const id = row.id;
    const status = row.status;
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`candidates[${index}].id must be a non-empty string`);
    }
    if (status !== "admitted" && status !== "halted") {
      throw new Error(`candidates[${index}].status must be admitted|halted`);
    }
    if (status === "admitted") {
      if (keys.some((key) => !ADMITTED_ROW_KEYS.has(key))) {
        throw new Error(`candidates[${index}] admitted row has extra keys: ${keys.join(",")}`);
      }
      if ("reason" in row) {
        throw new Error(`candidates[${index}] admitted row must omit reason`);
      }
      return { id, status };
    }
    if (keys.some((key) => !HALTED_ROW_KEYS.has(key))) {
      throw new Error(`candidates[${index}] halted row has extra keys: ${keys.join(",")}`);
    }
    const reason = row.reason;
    if (typeof reason !== "string" || reason.trim().length === 0) {
      throw new Error(`candidates[${index}] halted row needs a non-empty reason`);
    }
    return { id, status, reason };
  });
}

function listRecordedProofFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === ".gitkeep") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...listRecordedProofFiles(path).map((child) => join(name, child)));
    } else {
      out.push(name);
    }
  }
  return out;
}

const admissionRaw = JSON.parse(readFileSync(admissionPath, "utf8")) as unknown;
const rows = parseAdmission(admissionRaw);
const readme = readFileSync(readmePath, "utf8");
const testSource = readFileSync(fileURLToPath(import.meta.url), "utf8");
const recordedProofFiles = listRecordedProofFiles(recordedDir);

check(
  "commissioned set matches admission rows",
  COMMISSIONED_IDS.length === rows.length && COMMISSIONED_IDS.length === 23,
  `commissioned=${COMMISSIONED_IDS.length} rows=${rows.length}`,
);
check(
  "admission rows match commissioned ids in order",
  rows.length === COMMISSIONED_IDS.length
    && rows.every((row, index) => row.id === COMMISSIONED_IDS[index]),
  rows.map((row) => row.id).join(","),
);
check(
  "commissioned ids are unique",
  new Set(COMMISSIONED_IDS).size === COMMISSIONED_IDS.length,
);

const admissionKeys = new Set<string>();
collectKeys(admissionRaw, admissionKeys);
const invented = [...INVENTED_METRIC_KEYS].filter((key) => admissionKeys.has(key));
check(
  "admission.json does not invent index/price/P50 fields",
  invented.length === 0,
  invented.join(","),
);

check("recorded/ exists", existsSync(recordedDir) && statSync(recordedDir).isDirectory());

let admittedCount = 0;
for (const row of rows) {
  const proofs = mayAdmit(row.id);
  if (row.status === "admitted") {
    admittedCount += 1;
    check(`${row.id} admitted requires recorded U1+U2 files`, proofs);
  } else {
    check(
      `${row.id} halted with reason`,
      row.status === "halted" && typeof row.reason === "string" && row.reason.trim().length > 0,
    );
  }
  if (!proofs) {
    check(`${row.id} without recorded proofs is halted`, row.status === "halted");
  }
}

check(
  "zero admits is allowed",
  admittedCount === 0
    || rows.every((row) => row.status !== "admitted" || mayAdmit(row.id)),
  `admitted=${admittedCount}`,
);

if (recordedProofFiles.length === 0) {
  check(
    "no recorded live fixtures ⇒ all 15 halted",
    admittedCount === 0 && rows.every((row) => row.status === "halted"),
    `admitted=${admittedCount} recorded=${recordedProofFiles.length}`,
  );
}

check(
  "README names Agentic Index candidate path",
  readme.includes("benchmarks.artificial_analysis.agentic_index"),
);
check(
  "README names P50 latency candidate path",
  readme.includes("latency_last_30m.p50"),
);
check(
  "README names P50 throughput candidate path",
  readme.includes("throughput_last_30m.p50"),
);
check(
  "README records disposable-only live probes",
  readme.includes("disposable-only"),
);
check(
  "offline suite does not import network modules",
  !/from ["']node:(http|https|net|dgram|dns)["']/.test(testSource)
    && !/from ["']undici["']/.test(testSource)
    && !/\bfetch\s*\(/.test(testSource),
);

console.log(`${failures === 0 ? "PASS" : "FAIL"} ${total - failures}/${total}`);
process.exit(failures === 0 ? 0 : 1);
