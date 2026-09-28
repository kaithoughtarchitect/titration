// Titration MCP — the retrieval gate: LIVE read-only runner + regression gate.
//
// Loads the frozen labeled `{query -> expected card_ref(s)}`
// answer key (the selected retrieval-eval dataset), runs each query through the REAL `cardSearch` (DB +
// OpenRouter embeddings, read-only), and scores the ranked refs with the pure structural metric core
// (retrieval-metrics-core.ts — recall@k + MRR, NO LLM judge). Two modes:
//   • `--update-baseline` → re-freeze the selected dataset (intentional retrieval change only).
//   • default → compare the live scorecard to the committed baseline + exit non-zero on a regression (the gate).
//
// FAIL-LOUD throughout (it is a regression instrument): an unresolvable `expected` ref, a missing
// baseline, or a metric drop below `baseline - TOLERANCE` exits non-zero. NEVER swallow a regression
// or a missing ref into exit 0 — a green that hides a drop defeats the entire gate.
//
// READ-ONLY: only `cardSearch` + `cardGet` (no DB write); the SOLE artifact write is the selected baseline file.
//
// `../server/bootstrap-env` MUST be the FIRST import (side-effect, self-loads .env): both
// `../lib/store` (throws at import without TITRATION_DATABASE_URL) AND `../lib/embed` (captures
// OPENROUTER_API_KEY at import) read env AT IMPORT, so the creds must be present before either loads.
// Run: npm run retrieval:eval            (compare to baseline, gate)
//      npm run retrieval:eval -- --update-baseline   (re-freeze the Base baseline)

import "../server/bootstrap-env";

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { execSync } from "node:child_process";

import { cardSearch, cardGet, close } from "../lib/store";
import { EMBED_MODEL } from "../lib/embed";
import {
  scoreCorpus,
  compareToBaseline,
  type Scorecard,
} from "../lib/retrieval-metrics-core";

// The tolerance band that absorbs embedding nondeterminism / provider drift: a dip smaller than this
// is noise, not a regression. Small + fixed; an intentional model swap re-baselines (-- --update-baseline).
const TOLERANCE = 0.0001;

// Selected query-file schema (the frozen labeled set; read via readFileSync, NOT a JSON import — the canonical
// bundler-tsc has no --resolveJsonModule, so a JSON import would fail the typecheck gate).
interface QueryCase {
  id: string;
  query: string;
  expected: string[];
  note?: string;
  // Optional retrieval options. `type` restricts results to those card types (scored against
  // results[] as usual). `hops: 2` scores `expected` against the multi-hop `related[]` ranked refs as
  // their OWN sequence (recall over the walk output) — NOT appended to the direct results. Absent ⇒
  // today's behavior (3-arg cardSearch, results[] scoring), so the existing frozen cases are unchanged.
  type?: string[];
  hops?: 1 | 2;
}
interface QuerySet {
  tenant: string;
  search_k: number;
  k_values: number[];
  queries: QueryCase[];
}

// baseline.json schema (committed). Stamps embed_model + the capture SHA/date so a provider/model drift
// is auditable and an intentional re-baseline is traceable.
interface Baseline {
  tenant: string;
  embed_model: string;
  captured_at_sha: string;
  captured_at: string;
  n: number;
  recall: Record<number, number>;
  mrr: number;
}

// The one public dataset: the curated base starter pack and its frozen answer key.
const FILES = { queryFile: "base-queries.json", baselineFile: "base-baseline.json" } as const;

// Resolve a sibling file relative to THIS module (not the process cwd) so the script works from any dir.
function evalDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}
function readJsonFile<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(evalDir(), name), "utf8")) as T;
}

// Loud drift guard: every `expected` ref MUST resolve via cardGet, else a vanished/renamed truth ref
// would masquerade as a silent recall drop. cardGet throws on an absent ref; we catch ONLY to print
// the offending ref + exit 1 (a designed loud-failure path, not a swallow).
async function validateExpectedRefs(set: QuerySet, queryFile: string): Promise<void> {
  const seen = new Set<string>();
  for (const q of set.queries) {
    for (const ref of q.expected) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      try {
        await cardGet(ref, set.tenant);
      } catch (e) {
        console.error(
          `[retrieval-eval] expected ref '${ref}' (query ${q.id}) does not resolve in tenant '${set.tenant}': ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        console.error(`[retrieval-eval] the answer key has drifted from the live ledger — fix ${queryFile} or re-ingest. Aborting.`);
        throw new Error("retrieval answer key drift");
      }
    }
  }
}

// Run every query through the REAL cardSearch (read-only) and pair the ranked card_refs with the truth refs.
async function rankAllQueries(set: QuerySet): Promise<{ expected: string[]; ranked: string[] }[]> {
  const cases: { expected: string[]; ranked: string[] }[] = [];
  for (const q of set.queries) {
    const search = await cardSearch(q.query, set.tenant, set.search_k, { type: q.type, hops: q.hops });
    // A hops:2 case scores against the walk output (related[]) as its own ranked sequence, so a
    // multi-hop-only answer is measured where it actually surfaces (NOT appended past the ≤search_k
    // direct results, which would push it beyond recall@k and score 0). Every other case — including
    // type-scoped — rides the unchanged direct-results scoring.
    const ranked =
      q.hops === 2
        ? (search.related ?? []).map((r) => r.card_ref)
        : search.results.map((r) => r.card_ref);
    cases.push({ expected: q.expected, ranked });
  }
  return cases;
}

// The short HEAD sha stamped into a fresh baseline (best-effort; a non-git checkout stamps "unknown").
function shortHeadSha(): string {
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return "unknown";
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// Print a readable scorecard (recall@k for each k + MRR).
function printScorecard(label: string, sc: Scorecard): void {
  console.log(`\n${label} (n=${sc.n}):`);
  const ks = Object.keys(sc.recall)
    .map((k) => Number(k))
    .sort((a, b) => a - b);
  for (const k of ks) {
    console.log(`  recall@${k}\t${sc.recall[k].toFixed(4)}`);
  }
  console.log(`  mrr\t\t${sc.mrr.toFixed(4)}`);
}

async function run(): Promise<void> {
  const files = FILES;
  const set = readJsonFile<QuerySet>(files.queryFile);
  const maxK = Math.max(...set.k_values);
  if (set.search_k < maxK) {
    console.error(
      `[retrieval-eval] search_k (${set.search_k}) is below max(k_values) (${maxK}) — recall@k beyond search_k can never hit. Fix ${files.queryFile}.`,
    );
    throw new Error("invalid retrieval evaluation configuration");
  }

  await validateExpectedRefs(set, files.queryFile);

  const cases = await rankAllQueries(set);
  const current = scoreCorpus(cases, set.k_values);

  const updateBaseline = process.argv.includes("--update-baseline");

  if (updateBaseline) {
    // Re-freezing is the other door onto the same cheat: shrink the set, then re-baseline, and the
    // smaller corpus becomes the new truth with nothing red at any point. Refuse a shrinking
    // re-freeze unless the user names it deliberately: re-freeze only on an intentional change
    // with a documented reason and an answer-key check.
    let priorN: number | null = null;
    try {
      priorN = readJsonFile<Baseline>(files.baselineFile).n;
    } catch {
      priorN = null; // first capture for this dataset — nothing to protect yet
    }
    if (priorN !== null && current.n < priorN && process.env.TITRATION_RETRIEVAL_ALLOW_SHRINK !== "1") {
      console.error(
        `[retrieval-eval] REFUSING to re-baseline a SHRUNKEN corpus: committed baseline n=${priorN}, this run n=${current.n}. ` +
          `Restore the missing queries, or set TITRATION_RETRIEVAL_ALLOW_SHRINK=1 to record a deliberate re-freeze (document the reason and re-check the answer key).`,
      );
      process.exitCode = 1;
      return;
    }
    const baseline: Baseline = {
      tenant: set.tenant,
      embed_model: EMBED_MODEL,
      captured_at_sha: shortHeadSha(),
      captured_at: todayIso(),
      n: current.n,
      recall: current.recall,
      mrr: current.mrr,
    };
    // The SOLE artifact write — the committed, git-tracked baseline (no DB write anywhere in this runner).
    writeFileSync(resolve(evalDir(), files.baselineFile), JSON.stringify(baseline, null, 2) + "\n", "utf8");
    console.log(`[retrieval-eval] wrote ${files.baselineFile}:`);
    console.log(JSON.stringify(baseline, null, 2));
    printScorecard("baseline scorecard", current);
    return;
  }

  // Default: compare against the committed baseline + drive the exit-code regression gate.
  const baseline = readJsonFile<Baseline>(files.baselineFile);
  const baselineScorecard: Scorecard = { n: baseline.n, recall: baseline.recall, mrr: baseline.mrr };
  const cmp = compareToBaseline(current, baselineScorecard, TOLERANCE);

  printScorecard("current scorecard", current);
  console.log(
    `\nbaseline: ${baseline.embed_model} @ ${baseline.captured_at_sha} (${baseline.captured_at}), tenant=${baseline.tenant}, n=${baseline.n}`,
  );
  console.log("\nmetric\t\tbaseline\tcurrent\t\tdelta\t\tstatus");
  for (const row of cmp.rows) {
    const status = row.failed ? "REGRESSED" : "ok";
    console.log(
      `${row.metric}\t${row.baseline.toFixed(4)}\t\t${row.current.toFixed(4)}\t\t${row.delta >= 0 ? "+" : ""}${row.delta.toFixed(4)}\t\t${status}`,
    );
  }

  // Corpus size is checked BEFORE the metric rows: when n shrank, the rows above are a mean over a
  // different (smaller) set than the baseline and every one of them is unsafe to read as a delta.
  if (cmp.corpusShrank) {
    console.error(
      `\n[retrieval-eval] CORPUS SHRANK — baseline n=${cmp.corpus.baseline}, current n=${cmp.corpus.current}. ` +
        `The metrics above are means over a smaller set than the baseline and may read as an improvement while measuring less. ` +
        `STOP + diagnose: restore the missing queries, or re-freeze deliberately with a documented reason and an answer-key check. Gate FAILS (exit 1).`,
    );
    process.exitCode = 1;
    return;
  }

  if (cmp.regressed) {
    console.error(`\n[retrieval-eval] REGRESSION — at least one metric dropped below baseline - ${TOLERANCE}. Gate FAILS (exit 1).`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n[retrieval-eval] no regression (tolerance ${TOLERANCE}), corpus n=${cmp.corpus.current}. Gate PASSES (exit 0).`);
}

async function main(): Promise<void> {
  try {
    await run();
  } finally {
    await close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
