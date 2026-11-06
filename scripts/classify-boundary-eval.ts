// Runs the saved classification cases against live judges, to check where
// classify_failure draws the line between the system and the instrument.
// Run this after changing CLASSIFY_SYSTEM. It writes nothing to the database.
//
// Each case spends one panel call (metered judges are billed by OpenRouter):
//   npx tsx scripts/classify-boundary-eval.ts
//
// The panel comes from TITRATION_JUDGES, or `auto` when that is unset.
// A set of live results is evidence for a change, not a guarantee: judges can vary.
// Exit 0 when every case gets its expected origin, 1 otherwise.

import "../server/bootstrap-env"; // FIRST: loads credentials before any judge call.
import { readFileSync } from "node:fs";
import { classifyFailure } from "../lib/classify";

interface BoundaryCase { id: string; expected: string; why: string; observation: string }

const cases: BoundaryCase[] = JSON.parse(
  readFileSync(new URL("../lib/__tests__/fixtures/classify-boundary-cases.json", import.meta.url), "utf8"),
);

let wrong = 0;
for (const c of cases) {
  try {
    const r = await classifyFailure({ observation: c.observation });
    const ok = r.failure_origin === c.expected;
    if (!ok) wrong++;
    const failed = r.panel.failed.map((f) => f.id).join(",");
    console.log(`${ok ? "OK" : "XX"}  ${c.id}: got ${r.failure_origin ?? "inconclusive"}, expected ${c.expected}, agreement ${r.agreement.toFixed(2)}, judges ${r.panel.ran.length}${failed ? `, failed ${failed}` : ""}`);
  } catch (error) {
    wrong++;
    console.log(`XX  ${c.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`\n${cases.length - wrong} of ${cases.length} as expected`);
process.exit(wrong === 0 ? 0 : 1);
