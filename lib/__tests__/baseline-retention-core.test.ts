// Offline unit suite for the per-row retention decision (no DB, no network, no model — $0).
//
// This suite exists because a review found that the single most load-bearing expression in the
// opt-in retention feature had ZERO coverage anywhere in the tree: deleting it (always `null`)
// silently persisted nothing behind a 2xx receipt, and inverting it persisted judge verdicts for
// callers who never asked — and BOTH mutations passed the entire suite. The expression now lives in
// an import-clean core precisely so this file can reach it.
//
// Run: npx tsx lib/__tests__/baseline-retention-core.test.ts  (also under `npm test`)

import { readFileSync, readdirSync } from "node:fs";
import { resolveRetainedRows, shouldBindPerRowColumn } from "../baseline-retention-core";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail = ""): void {
  total++;
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name} ${detail}`);
  }
}

const ROWS = [{ id: "c1" }, { id: "c2" }];

// ── resolveRetainedRows: the opt-in gate ──────────────────────────────────────────────────────
check(
  "retain_rows === true returns the rows (the whole point of the feature)",
  resolveRetainedRows(true, ROWS)?.length === 2,
);
check(
  "the returned array IS the graded rows, not a copy with different contents",
  resolveRetainedRows(true, ROWS)?.[0]?.id === "c1",
);

// The mutation that used to survive: always-null. If someone deletes the feature's payload branch,
// THIS is the assertion that goes red.
check(
  "MUTATION GUARD — retention is not silently disabled (always-null would fail here)",
  resolveRetainedRows(true, ROWS) !== null,
);
// The opposite mutation: `!== true`, persisting for everyone who did not ask.
check(
  "MUTATION GUARD — retention is not silently enabled for non-opted-in callers",
  resolveRetainedRows(false, ROWS) === null && resolveRetainedRows(undefined, ROWS) === null,
);

// ── strictness: a truthy non-boolean must NOT opt anyone in to a persistent write ─────────────
for (const truthy of ["true", 1, "yes", {}, [1], "1"] as unknown[]) {
  check(
    `truthy non-boolean ${JSON.stringify(truthy)} does NOT opt in to retention`,
    resolveRetainedRows(truthy, ROWS) === null,
  );
}
for (const falsy of [false, 0, "", null, undefined, NaN] as unknown[]) {
  check(
    `falsy ${String(falsy)} does not retain`,
    resolveRetainedRows(falsy, ROWS) === null,
  );
}

// ── null, never undefined — the store branches on `per_row == null` ───────────────────────────
check(
  "a non-retaining call yields exactly null (not undefined)",
  resolveRetainedRows(false, ROWS) === null && resolveRetainedRows(false, ROWS) !== undefined,
);
check(
  "missing/!Array rows yield null even when retention was requested (never undefined)",
  resolveRetainedRows(true, undefined) === null
    && resolveRetainedRows(true, "not an array" as unknown as never[]) === null,
);
check(
  "an empty graded corpus retains an empty array, not null (structurally unreachable today, but the distinction is real: [] means 'retained nothing', null means 'not retained')",
  Array.isArray(resolveRetainedRows(true, [])),
);

// ── shouldBindPerRowColumn: the INSERT arm selector ───────────────────────────────────────────
check("null per_row selects the pre-040 arm (no per_row column bound)", shouldBindPerRowColumn(null) === false);
check("undefined per_row selects the pre-040 arm", shouldBindPerRowColumn(undefined) === false);
check("an array selects the db/040 retain arm", shouldBindPerRowColumn([{ id: "c1" }]) === true);
check("an EMPTY array still selects the retain arm (it is data, not absence)", shouldBindPerRowColumn([]) === true);
check(
  "MUTATION GUARD — the arms are not swapped (a swap would make EVERY baseline write depend on db/040)",
  shouldBindPerRowColumn(null) === false && shouldBindPerRowColumn([]) === true,
);

// ── the store actually ROUTES through the selector, not a hand-inlined ternary ────────────────
// Without this, the two functions above could be perfectly correct and perfectly unused.
{
  const baselineSrc = readFileSync("lib/baseline.ts", "utf8");
  check(
    "lib/baseline.ts routes its INSERT arms through shouldBindPerRowColumn",
    baselineSrc.includes("shouldBindPerRowColumn"),
  );
  const verifySrc = readFileSync("lib/verify.ts", "utf8");
  check(
    "lib/verify.ts routes the retention decision through resolveRetainedRows",
    verifySrc.includes("resolveRetainedRows(args.retain_rows"),
  );
  // VP-B6 (tenant-agnostic retention) previously scanned ONLY lib/baseline.ts — but the natural
  // place to introduce a per-tenant carve-out is the translation point in verify.ts, which that
  // scan never read. Cover the whole retention path here.
  for (const file of ["lib/verify.ts", "lib/baseline.ts", "lib/baseline-retention-core.ts"]) {
    const src = readFileSync(file, "utf8");
    check(
      `VP-B6 ${file} carries no tenant/System-specific branch in the retention path`,
      !/(retain_rows|per_row)[\s\S]{0,400}?("titration"|'titration'|tenant\s*===|slug\s*===)/i.test(src),
    );
  }
}

// ── the jsonb-READ contract: a corrupt blob is RECOVERABLE BY THE CALLER ──────────────────────
// The constitution's rule is "fail open to the raw string" so the CALLER can inspect or recover it.
// An earlier version collapsed corrupt data to `null`, making "retained but corrupt" identical to
// "never retained" at the API — and a server log does not satisfy the rule, because an API consumer
// has no database access. These pin that the raw value comes back beside the parsed grades.
{
  const src = readFileSync("lib/baseline.ts", "utf8");
  check(
    "the detail row exposes per_row_unparsed alongside per_row",
    src.includes("per_row_unparsed: string | null"),
  );
  check(
    "an unparseable string is returned raw, not collapsed to null",
    src.includes("returning it raw for recovery"),
  );
  check(
    "dropped non-RowGrade entries are handed back rather than deleted",
    src.includes("returning them raw for recovery"),
  );
  check(
    "the raw echo is BOUNDED so a pathological blob cannot be echoed unbounded",
    src.includes("PER_ROW_RAW_ECHO_MAX") && src.includes("truncated"),
  );
  check(
    "a healthy read reports no unparsed remainder",
    src.includes("return { rows: rows.length > 0 ? rows : null, unparsed: null };"),
  );
}

// ── every door that can request retention actually forwards it ────────────────────────────────
// Guards against the conditional spread silently getting deleted, which would drop the flag for
// real callers while the durable path keeps working, so the feature "works" in tests and does
// nothing through the door.
{
  const forwarders: Array<[string, string]> = [
    ["server/mcp-server.ts", "retain_rows: true"],
  ];
  for (const [file, expr] of forwarders) {
    check(`${file} forwards retain_rows`, readFileSync(file, "utf8").includes(expr));
  }
  // And every door REFUSES a non-boolean rather than quietly treating it as off — a silent drop
  // there costs the caller a full paid grade and is indistinguishable from "not implemented".
  for (const file of [
    "server/mcp-server.ts",
  ]) {
    const src = readFileSync(file, "utf8");
    check(
      `${file} refuses a non-boolean retain_rows rather than coercing it`,
      src.includes('typeof b.retain_rows !== "boolean"')
        || src.includes('typeof a.retain_rows !== "boolean"')
        || src.includes("boolFlag(replay.retain_rows"),
    );
  }
}

// ── read amplification: exactly ONE per_row fetch in the WHOLE tree ───────────────────────────
// The previous check named four specific consumer files, so a FIFTH file adding a per_row read
// would have sailed straight through. Walk every source file instead.
{
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__" && entry.name !== "node_modules") walk(full);
      } else if (entry.name.endsWith(".ts") && readFileSync(full, "utf8").includes("loadBaselineDetail(")) {
        hits.push(full);
      }
    }
  };
  for (const root of ["lib", "server"]) walk(root);
  const callers = hits.filter((f) => !f.endsWith("lib/baseline.ts"));
  check(
    `VP-B4 at most one file in the tree calls loadBaselineDetail (found: ${callers.join(", ") || "none"})`,
    callers.length <= 1,
  );
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${total - failures}/${total}`);
process.exit(failures === 0 ? 0 : 1);
