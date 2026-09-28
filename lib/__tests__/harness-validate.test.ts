// Titration MCP — harness-validate-core unit test (no network, no DB, no model).
// Pins the PURE scoring + assembly the I/O layer routes on: per-check deduction +
// floor, the weighted-/100 renormalization (thorough AND quick), the verdict mapping,
// the Critical→Revise/Reject promotion + override flag, severity normalization, the
// missing-check completeness gate, finding hygiene, must_fix ordering, and the prompt
// builder. The harness-validate.ts I/O call snapshots these specs verbatim, so this is
// the offline contract. Mirrors harness-design.test / flywheel.test.
// Run: npx tsx lib/__tests__/harness-validate.test.ts

import {
  assembleReport,
  scoreFromFindings,
  verdictFromScore,
  buildValidateUserPrompt,
  CHECKS,
  QUICK_CHECK_IDS,
  DEDUCTION,
  type Finding,
} from "../harness-validate-core";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}
function throws(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e: any) {
    return String(e?.message ?? e);
  }
}

// ── factories ───────────────────────────────────────────────────────────────────
// A clean (no-findings) report covering exactly the requested check set.
function cleanChecks(ids: number[]): any[] {
  return ids.map((id) => ({ check: id, findings: [] }));
}
function thoroughClean(): any {
  return { summary: "looks sound", checks: cleanChecks(CHECKS.map((c) => c.id)) };
}
// Override one check's findings inside an otherwise-clean thorough report.
function withFindings(id: number, findings: Finding[], extra: number[] = []): any {
  const base = thoroughClean();
  base.checks = base.checks.map((c: any) => (c.check === id ? { check: id, findings } : c));
  return base;
}

// ── scoreFromFindings (deduction + floor) ──────────────────────────────────────────
check("scoreFromFindings: none → 100", scoreFromFindings([]) === 100);
check("scoreFromFindings: one Critical → 60", scoreFromFindings([{ severity: "Critical", finding: "x" }]) === 100 - DEDUCTION.Critical);
check("scoreFromFindings: one Major → 80", scoreFromFindings([{ severity: "Major", finding: "x" }]) === 80);
check("scoreFromFindings: one Minor → 95", scoreFromFindings([{ severity: "Minor", finding: "x" }]) === 95);
check(
  "scoreFromFindings: compounds (Major+Minor → 75)",
  scoreFromFindings([{ severity: "Major", finding: "a" }, { severity: "Minor", finding: "b" }]) === 75,
);
check(
  "scoreFromFindings: floors at 0 (3 Criticals → 0, not -20)",
  scoreFromFindings([
    { severity: "Critical", finding: "a" },
    { severity: "Critical", finding: "b" },
    { severity: "Critical", finding: "c" },
  ]) === 0,
);

// ── verdictFromScore boundaries ─────────────────────────────────────────────────────
check("verdictFromScore: 100 → Proceed", verdictFromScore(100) === "Proceed");
check("verdictFromScore: 90 → Proceed (boundary)", verdictFromScore(90) === "Proceed");
check("verdictFromScore: 89 → Revise", verdictFromScore(89) === "Revise");
check("verdictFromScore: 70 → Revise (boundary)", verdictFromScore(70) === "Revise");
check("verdictFromScore: 69 → Reject", verdictFromScore(69) === "Reject");
check("verdictFromScore: 0 → Reject", verdictFromScore(0) === "Reject");

// ── assembleReport happy path ───────────────────────────────────────────────────────
const clean = assembleReport(thoroughClean());
check("clean thorough report → score 100", clean.score === 100);
check("clean → Proceed", clean.recommendation === "Proceed");
check("clean → no Critical, no override", !clean.has_critical && !clean.critical_override);
check("report is always advisory:true (advisory-not-blocking)", clean.advisory === true);
check("clean thorough has all 9 checks", clean.checks.length === 9);
check("clean → empty must_fix", clean.must_fix.length === 0);
check("model summary passes through", clean.summary === "looks sound");
check("missing model summary → generated summary", assembleReport({ checks: cleanChecks(CHECKS.map((c) => c.id)) }).summary.startsWith("Proceed — 100/100"));

// ── weighted renormalization (thorough) ─────────────────────────────────────────────
// one Major in check 1 (w20): (80×20 + 100×80)/100 = 96 → Proceed.
const oneMajor = assembleReport(withFindings(1, [{ severity: "Major", finding: "aggregator key drift" }]));
check("one Major in check1 (w20) → score 96", oneMajor.score === 96, `got ${oneMajor.score}`);
check("one Major → still Proceed (a single Major doesn't sink it)", oneMajor.recommendation === "Proceed");
check("one Major → no critical_override", !oneMajor.critical_override);
check("one Major → in must_fix", oneMajor.must_fix.length === 1 && oneMajor.must_fix[0].startsWith("[Major] File-Contract Integrity:"));

// ── Critical override (score would Proceed, but a Critical demotes) ─────────────────
// one Critical in check 3 (w15): (60×15 + 100×85)/100 = 94 → score-verdict Proceed,
// but the Critical caps it at Revise.
const oneCrit = assembleReport(withFindings(3, [{ severity: "Critical", finding: "CHAR_ID does not resolve in supplied facts" }]));
check("one Critical in check3 (w15) → score 94", oneCrit.score === 94, `got ${oneCrit.score}`);
check("score≥90 but Critical → recommendation Revise (override)", oneCrit.recommendation === "Revise");
check("one Critical → has_critical true", oneCrit.has_critical === true);
check("one Critical (score≥90) → critical_override true", oneCrit.critical_override === true);
check("one Critical → in must_fix as [Critical]", oneCrit.must_fix[0].startsWith("[Critical] Codebase Grounding:"));

// ── Reject (every check Critical → score 60 → Reject; override flag false) ──────────
const allCrit = assembleReport({ checks: CHECKS.map((c) => ({ check: c.id, findings: [{ severity: "Critical", finding: `crit in ${c.key}` }] })) });
check("every check Critical → score 60", allCrit.score === 60, `got ${allCrit.score}`);
check("score 60 → Reject", allCrit.recommendation === "Reject");
check("Reject has_critical true", allCrit.has_critical === true);
check("Reject → critical_override false (score already <90, Critical isn't the deciding factor)", allCrit.critical_override === false);
check("all-Critical → 9 must_fix entries", allCrit.must_fix.length === 9);

// must_fix ordering: Critical before Major, Minor excluded.
const mixed = assembleReport(
  withFindings(5, [
    { severity: "Minor", finding: "generic corpus naming" },
    { severity: "Major", finding: "sample size mismatched" },
    { severity: "Critical", finding: "engine ON in candidate, OFF in baseline" },
  ]),
);
check("must_fix excludes Minor", mixed.must_fix.every((m) => !m.startsWith("[Minor]")));
check("must_fix Critical before Major", mixed.must_fix[0].startsWith("[Critical]") && mixed.must_fix[1].startsWith("[Major]"));

// ── completeness gate (missing required check → throws) ─────────────────────────────
const missingOne = { checks: cleanChecks(CHECKS.map((c) => c.id).filter((id) => id !== 7)) };
check("thorough report missing check 7 → throws (lists it)", (throws(() => assembleReport(missingOne)) ?? "").includes("Statistical Soundness"));

// ── quick mode (4 checks, renormalized over Σweight 55) ─────────────────────────────
const quickClean = assembleReport({ checks: cleanChecks([...QUICK_CHECK_IDS]) }, "quick");
check("quick mode → exactly 4 checks", quickClean.checks.length === 4);
check("quick mode → ids are 1,2,3,8", quickClean.checks.map((c) => c.id).join(",") === "1,2,3,8");
check("quick clean → score 100 (renormalized over 55)", quickClean.score === 100);
check("quick mode marked on report", quickClean.mode === "quick");
// quick with a Major in check 2 (w10): (100×20 + 80×10 + 100×15 + 100×10)/55 = 5300/55 = 96.36 → 96 → Proceed.
const quickMajor = assembleReport(
  { checks: [{ check: 1, findings: [] }, { check: 2, findings: [{ severity: "Major", finding: "vague label" }] }, { check: 3, findings: [] }, { check: 8, findings: [] }] },
  "quick",
);
check("quick Major in check2 → score 96 (renormalized)", quickMajor.score === 96, `got ${quickMajor.score}`);
// quick mode ignores an out-of-set check the model volunteers (check 5 not requested).
const quickExtra = assembleReport({ checks: [...cleanChecks([...QUICK_CHECK_IDS]), { check: 5, findings: [{ severity: "Critical", finding: "ignored" }] }] }, "quick");
check("quick mode ignores an out-of-set check (no phantom Critical)", quickExtra.checks.length === 4 && !quickExtra.has_critical);
// quick mode missing one of its 4 → throws.
check("quick missing check 8 → throws", (throws(() => assembleReport({ checks: cleanChecks([1, 2, 3]) }, "quick")) ?? "").includes("Judge Safety"));

// ── duplicate check id merges findings ──────────────────────────────────────────────
const dup = assembleReport({
  checks: [
    ...cleanChecks(CHECKS.map((c) => c.id).filter((id) => id !== 1)),
    { check: 1, findings: [{ severity: "Major", finding: "a" }] },
    { check: 1, findings: [{ severity: "Minor", finding: "b" }] },
  ],
});
check("duplicate check id merges findings (Major+Minor on check1 → score 75)", dup.checks.find((c) => c.id === 1)!.score === 75);

// ── finding hygiene ─────────────────────────────────────────────────────────────────
// blank-text finding with a valid severity is KEPT (severity is load-bearing) with default text.
const blankText = assembleReport(withFindings(2, [{ severity: "Critical", finding: "   " } as any]));
check("finding with valid severity but blank text → kept (score reflects it)", blankText.checks.find((c) => c.id === 2)!.score === 60);
check("blank-text finding gets a default detail", blankText.checks.find((c) => c.id === 2)!.findings[0].finding === "(no detail provided)");
// entirely-empty finding object is filtered out (no severity, no text).
const emptyObj = assembleReport(withFindings(4, [{} as any, { severity: "Minor", finding: "real" } as any]));
check("entirely-empty finding object filtered out", emptyObj.checks.find((c) => c.id === 4)!.findings.length === 1);
// text-but-no-severity throws (can't score it; might be a Critical the model forgot to tag).
check("finding with text but no severity → throws", !!throws(() => assembleReport(withFindings(6, [{ finding: "something is wrong" } as any]))));
// invalid severity throws.
check("invalid severity → throws", (throws(() => assembleReport(withFindings(6, [{ severity: "Catastrophic", finding: "x" } as any]))) ?? "").includes("invalid severity"));
// severity normalizes (case): "critical" → Critical.
const lcSev = assembleReport(withFindings(3, [{ severity: "critical", finding: "x" } as any]));
check("severity normalizes case (critical → Critical)", lcSev.checks.find((c) => c.id === 3)!.findings[0].severity === "Critical");

// ── malformed top-level → throws ────────────────────────────────────────────────────
check("non-object raw → throws", !!throws(() => assembleReport("not json" as any)));
check("no checks array → throws", !!throws(() => assembleReport({ summary: "x" } as any)));
check("empty checks array → throws", !!throws(() => assembleReport({ checks: [] } as any)));
check("check with non-1..9 id → throws", !!throws(() => assembleReport({ checks: [{ check: 12, findings: [] }] })));

// ── buildValidateUserPrompt ─────────────────────────────────────────────────────────
const up = buildValidateUserPrompt("DESIGN: narration-leak harness", "FACTS: CHAR_ID resolves; engine OFF both arms", "thorough");
check("prompt includes the design", up.includes("narration-leak harness"));
check("prompt includes the codebase facts", up.includes("engine OFF both arms"));
check("thorough prompt says all 9 checks", up.includes("all 9 checks"));
check("quick prompt says only checks 1,2,3,8", buildValidateUserPrompt("d", "f", "quick").includes("ONLY checks 1, 2, 3, 8"));

// ── enums / constants ────────────────────────────────────────────────────────────────
check("CHECKS has 9 entries summing to weight 100", CHECKS.length === 9 && CHECKS.reduce((s, c) => s + c.weight, 0) === 100);
check("File-Contract is weight 20, Cross-Harness weight 5", CHECKS[0].weight === 20 && CHECKS[8].weight === 5);
check("QUICK_CHECK_IDS is [1,2,3,8]", [...QUICK_CHECK_IDS].join(",") === "1,2,3,8");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
