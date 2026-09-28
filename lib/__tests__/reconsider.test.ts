// Titration MCP — reconsideration decision unit test (no network, no judges).
// Pins the pure §9.6+ reconsideration logic (applyReconsideration) that classify.ts
// runs after re-prompting the majority judges: re-tally + verdict_changed +
// judges_who_changed + initial/reconsidered audit. The judge I/O is separated out,
// so this is fully deterministic.
// Run: npx tsx lib/__tests__/reconsider.test.ts

import { findDissent } from "../consensus";
import { applyReconsideration, type ClassifyJudgeView } from "../classify";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}

const v = (id: string, origin: string): ClassifyJudgeView => ({
  id, family: "x", model: "m", failure_origin: origin, reasoning: `${id} reasoning`, confidence: "high",
});

// Scenario 1 — both majority judges STICK → verdict unchanged.
{
  const initial = [v("grok", "system-under-test"), v("gpt", "system-under-test"), v("deepseek", "corpus-gap")];
  const split = findDissent(initial.map((j) => j.failure_origin));
  // reconsidered majority (aligned to split.majority = [0,1]): both stick.
  const recon = [v("grok", "system-under-test"), v("gpt", "system-under-test")];
  const r = applyReconsideration(initial, split, recon);
  check(
    "1. majority sticks → verdict unchanged",
    split.eligible && r.tally.winner === "system-under-test" && r.verdict_changed === false && r.judges_who_changed.length === 0 &&
      r.initial.failure_origin === "system-under-test" && r.reconsidered.failure_origin === "system-under-test",
    JSON.stringify(r),
  );
}

// Scenario 2 — one majority judge is CONVINCED by the dissenter → verdict flips.
{
  const initial = [v("grok", "system-under-test"), v("gpt", "system-under-test"), v("deepseek", "corpus-gap")];
  const split = findDissent(initial.map((j) => j.failure_origin));
  // grok changes to the dissenter's origin; gpt sticks → final votes corpus-gap,corpus-gap,SUT.
  const recon = [v("grok", "corpus-gap"), v("gpt", "system-under-test")];
  const r = applyReconsideration(initial, split, recon);
  check(
    "2. one majority judge convinced → verdict flips",
    r.tally.winner === "corpus-gap" && r.verdict_changed === true &&
      r.judges_who_changed.length === 1 && r.judges_who_changed[0] === "grok" &&
      r.initial.failure_origin === "system-under-test" && r.reconsidered.failure_origin === "corpus-gap",
    JSON.stringify(r),
  );
}

// Scenario 3 — both majority judges move to NEW (different) origins → 1-1-1 → inconclusive.
{
  const initial = [v("grok", "system-under-test"), v("gpt", "system-under-test"), v("deepseek", "corpus-gap")];
  const split = findDissent(initial.map((j) => j.failure_origin));
  const recon = [v("grok", "formatter"), v("gpt", "rubric-ambiguity")];
  const r = applyReconsideration(initial, split, recon);
  check(
    "3. majority dissolves → inconclusive (conservative)",
    r.tally.inconclusive === true && r.reconsidered.failure_origin === null && r.verdict_changed === true &&
      r.judges_who_changed.length === 2,
    JSON.stringify(r),
  );
}

// Scenario 4 — audit preserves BOTH rounds (initial votes intact regardless of outcome).
{
  const initial = [v("grok", "formatter"), v("gpt", "formatter"), v("deepseek", "system-under-test")];
  const split = findDissent(initial.map((j) => j.failure_origin));
  const recon = [v("grok", "formatter"), v("gpt", "formatter")];
  const r = applyReconsideration(initial, split, recon);
  const initialOk = r.initial.votes.length === 3 && r.initial.votes[2].failure_origin === "system-under-test";
  const reconOk = r.reconsidered.votes.length === 3 && r.reconsidered.votes[0].failure_origin === "system-under-test"; // dissenter first
  check("4. audit preserves both rounds", initialOk && reconOk && r.tally.winner === "formatter", JSON.stringify(r));
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
