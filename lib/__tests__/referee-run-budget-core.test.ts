// Titration MCP — referee-run-budget-core unit test (no network, no DB, no model — $0).
// Pins allowed upcoming-run counts 1–10 and the required vs optional parsers.
// Mirrors referee-catalog-core.test.ts (check/total/failures + process.exit).
// Run: npx tsx lib/__tests__/referee-run-budget-core.test.ts

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  REFEREE_RUN_BUDGETS,
  isRefereeRunBudget,
  parseOptionalRunBudget,
  parseRequiredRunBudget,
  runBudgetStateFromSnapshot,
} from "../referee-run-budget-core";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail = ""): void {
  total++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}

function throws(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e: unknown) {
    return String(e instanceof Error ? e.message : e);
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const corePath = join(here, "..", "referee-run-budget-core.ts");
const coreSource = readFileSync(corePath, "utf8");

check(
  "REFEREE_RUN_BUDGETS is exactly 1 through 10",
  JSON.stringify([...REFEREE_RUN_BUDGETS]) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
);

for (const count of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const) {
  check(
    `isRefereeRunBudget accepts ${count}`,
    isRefereeRunBudget(count) && parseRequiredRunBudget(count) === count,
  );
}

check("isRefereeRunBudget refuses 11", isRefereeRunBudget(11) === false);
check("isRefereeRunBudget refuses 20", isRefereeRunBudget(20) === false);
check("isRefereeRunBudget refuses 0", isRefereeRunBudget(0) === false);
check('isRefereeRunBudget refuses string "5"', isRefereeRunBudget("5") === false);
check("isRefereeRunBudget refuses 4.5", isRefereeRunBudget(4.5) === false);
check("isRefereeRunBudget refuses null", isRefereeRunBudget(null) === false);

check("parseRequiredRunBudget refuses 11", parseRequiredRunBudget(11) === null);
check("parseRequiredRunBudget refuses 20", parseRequiredRunBudget(20) === null);
check("parseRequiredRunBudget refuses 0", parseRequiredRunBudget(0) === null);
check('parseRequiredRunBudget refuses string "5"', parseRequiredRunBudget("5") === null);
check("parseRequiredRunBudget refuses 4.5", parseRequiredRunBudget(4.5) === null);
check("parseRequiredRunBudget refuses null", parseRequiredRunBudget(null) === null);
check("parseRequiredRunBudget refuses undefined", parseRequiredRunBudget(undefined) === null);

check("parseOptionalRunBudget null is null", parseOptionalRunBudget(null) === null);
check("parseOptionalRunBudget absent/undefined is null", parseOptionalRunBudget(undefined) === null);
check("parseOptionalRunBudget 5 is 5", parseOptionalRunBudget(5) === 5);
check("parseOptionalRunBudget 10 is 10", parseOptionalRunBudget(10) === 10);
check("parseOptionalRunBudget 20 is null", parseOptionalRunBudget(20) === null);
check('parseOptionalRunBudget string "5" is null', parseOptionalRunBudget("5") === null);
check(
  "parseOptionalRunBudget never throws on invalid values",
  throws(() => parseOptionalRunBudget(11)) === null
    && throws(() => parseOptionalRunBudget("5")) === null
    && throws(() => parseOptionalRunBudget(4.5)) === null
    && throws(() => parseOptionalRunBudget({})) === null
    && throws(() => parseOptionalRunBudget(undefined)) === null,
);

check(
  "runBudgetStateFromSnapshot: stored allowed count is set",
  runBudgetStateFromSnapshot({ run_budget: 5 }) === "set"
    && runBudgetStateFromSnapshot({ run_budget: 5, run_budget_corrupt: true }) === "set",
);
check(
  "runBudgetStateFromSnapshot: absent count without marker is legacy",
  runBudgetStateFromSnapshot({}) === "legacy"
    && runBudgetStateFromSnapshot({ run_budget: undefined }) === "legacy",
);
check(
  "runBudgetStateFromSnapshot: corrupt marker is corrupt, never legacy",
  runBudgetStateFromSnapshot({ run_budget_corrupt: true }) === "corrupt"
    && runBudgetStateFromSnapshot({ run_budget: undefined, run_budget_corrupt: true }) === "corrupt",
);

check("core has no Date.now()", !/\bDate\.now\s*\(/.test(coreSource));
check("core has no Math.random()", !/\bMath\.random\s*\(/.test(coreSource));
check(
  "core is import-free (no from / require)",
  !/\bfrom\s+["']/.test(coreSource) && !/\brequire\s*\(/.test(coreSource),
);
check(
  "core has no fs / fetch / network / clock imports",
  !/from\s+["']node:(fs|http|https|net|dgram|dns|crypto)["']/.test(coreSource)
    && !/\bfetch\s*\(/.test(coreSource),
);

console.log(`${failures === 0 ? "PASS" : "FAIL"} ${total - failures}/${total}`);
process.exit(failures === 0 ? 0 : 1);
