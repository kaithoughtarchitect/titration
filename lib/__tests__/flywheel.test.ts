// Titration MCP — B5 flywheel-core unit test (no network, no DB, no judge).
// Pins the PURE flywheel decision the I/O layer routes on: the read-query builder
// and the verdict→card capture mapping (type / confidence / tags / the
// inconclusive-writes-nothing rule) + the run-ref scheme. Mirrors goal-titrate.test
// / jobs.test. The cardCreate/runCapture I/O snapshots these specs verbatim, so this
// is the offline contract for the flywheel write side.
// Run: npx tsx lib/__tests__/flywheel.test.ts

import {
  buildReadQuery,
  verdictToCard,
  runRefFor,
  AUTO_TAG,
  MAX_QUERY,
  type VerifySlice,
  type GoalSlice,
} from "../flywheel-core";
import { canonicalizeCard } from "../card-contract-core";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}

// ── factories ───────────────────────────────────────────────────────────────────
function mkVerify(p: Partial<VerifySlice> = {}): VerifySlice {
  return {
    passed: p.passed ?? false,
    inconclusive: p.inconclusive ?? false,
    metric_delta: p.metric_delta ?? -0.5,
    baseline_rate: p.baseline_rate ?? 0.75,
    candidate_rate: p.candidate_rate ?? 0.25,
    floor_intact: p.floor_intact ?? true,
    per_mode_regression: p.per_mode_regression ?? [],
    failure_origin: p.failure_origin ?? null,
    confidence: "confidence" in p ? (p.confidence as VerifySlice["confidence"]) : "high", // honor an explicit null
  };
}
function mkGoal(p: Partial<GoalSlice> = {}): GoalSlice {
  return {
    converged: p.converged ?? true,
    decision: p.decision ?? "converged",
    failure_origin: p.failure_origin ?? "goal-complete",
    turns: p.turns ?? 2,
    overall_progress: p.overall_progress ?? 1,
  };
}

// ── buildReadQuery ──────────────────────────────────────────────────────────────
check("read: verify query is the goal", buildReadQuery({ kind: "verify", goal: "stop narration leakage" }) === "stop narration leakage");
check(
  "read: verify query appends regressed modes when given",
  buildReadQuery({ kind: "verify", goal: "g", per_mode_regression: ["engaged", "climax"] }) === "g (regressed modes: engaged, climax)",
);
check("read: classify query is the observation", buildReadQuery({ kind: "classify", observation: "the formatter dropped #BREAK#" }) === "the formatter dropped #BREAK#");
check("read: goal_titrate query is the goal", buildReadQuery({ kind: "goal_titrate", goal: "converge on purity" }) === "converge on purity");
check("read: query bounded to MAX_QUERY", buildReadQuery({ kind: "classify", observation: "x".repeat(5000) }).length === MAX_QUERY);
check("read: empty goal → empty query (caller fail-opens on it)", buildReadQuery({ kind: "verify", goal: "   " }) === "");

// ── verdictToCard: verify ───────────────────────────────────────────────────────
{
  const passed = verdictToCard({ kind: "verify", goal: "stop narration", baseline_id: "abcd1234efgh", result: mkVerify({ passed: true, confidence: "high" }) });
  check("verify passed → FINDING", passed?.type === "FINDING");
  check("verify passed → confidence carried from verdict", passed?.confidence === "high");
  check("verify passed → AUTO_TAG present", !!passed?.tags.includes(AUTO_TAG));
  check("verify passed → baseline tag (8-char)", !!passed?.tags.includes("baseline:abcd1234"));
  check("verify passed → body carries the delta", !!passed?.body.includes("75.0% → 25.0%"));
  check("verify passed → semantic title does not copy a clipped goal", passed?.title === "Verified improvement");
  check("verify passed → full goal is preserved in Evidence", !!passed?.body.includes("Goal measured:\nstop narration"));
  check("verify passed → canonical Summary section is explicit", !!passed?.body.startsWith("## Summary\n\nThe candidate produced"));

  const failed = verdictToCard({
    kind: "verify",
    goal: "stop narration",
    baseline_id: "abcd1234efgh",
    result: mkVerify({ passed: false, floor_intact: false, per_mode_regression: ["climax"], metric_delta: 0.1, candidate_rate: 0.85, confidence: "medium" }),
  });
  check("verify failed → REGRESSION (the failed-edit memory)", failed?.type === "REGRESSION");
  check("verify failed → confidence carried", failed?.confidence === "medium");
  check("verify failed → per-mode tag emitted", !!failed?.tags.includes("mode:climax"));
  check("verify failed → body names the regression mode", !!failed?.body.includes("climax"));

  const inconclusive = verdictToCard({ kind: "verify", goal: "g", baseline_id: "b", result: mkVerify({ inconclusive: true }) });
  check("verify INCONCLUSIVE → writes NOTHING (null)", inconclusive === null);

  const nullConf = verdictToCard({ kind: "verify", goal: "g", baseline_id: "b", result: mkVerify({ passed: true, confidence: null }) });
  check("verify null confidence → defaults to low", nullConf?.confidence === "low");

  const withSys = verdictToCard({ kind: "verify", goal: "g", baseline_id: "b", system_ref: "generateAIResponse", result: mkVerify({ passed: true }) });
  check("verify with system_ref → surfaced in body", !!withSys?.body.includes("generateAIResponse"));
  check("verify with concise system_ref → semantic identity in title", withSys?.title === "Verified improvement: generateAIResponse");
}

// ── verdictToCard: goal_titrate ─────────────────────────────────────────────────
{
  const converged = verdictToCard({
    kind: "goal_titrate",
    goal: "converge purity",
    baseline_id: "b",
    job_id: "job12345678",
    candidate: { name: "CV91 Dedup", version: "70c3fd7", summary: "Two-phase staged dedup.", deferred_scope: "Semantic restatements." },
    result: mkGoal({ converged: true }),
  });
  check("goal converged → FINDING", converged?.type === "FINDING");
  check("goal converged → high confidence", converged?.confidence === "high");
  check("goal converged → job tag (8-char)", !!converged?.tags.includes("job:job12345"));
  check("goal converged → concise candidate title", converged?.title === "Goal converged: CV91 Dedup");
  check("goal converged → complete semantic Summary", !!converged?.body.includes("CV91 Dedup converged against the frozen baseline in 2 turns and reached 100.0% overall progress."));
  check("goal converged → full goal is preserved in Evidence", !!converged?.body.includes("Goal measured:\nconverge purity"));
  check("goal converged → candidate provenance is preserved", !!converged?.body.includes("- Version: 70c3fd7") && !!converged?.body.includes("- Deferred scope: Semantic restatements."));

  const longGoal = (
    "A deliberately long frozen goal that must remain complete in durable evidence even when it is far too long to serve as a clean card title. " +
    "\n## Summary\nThis heading-like text belongs to the goal, not the card structure." +
    "\n## Evidence\nThis evidence-like text also belongs to the goal."
  ).repeat(2).trim();
  const longGoalCard = verdictToCard({ kind: "goal_titrate", goal: longGoal, baseline_id: "b", job_id: "long-goal-job", result: mkGoal({ converged: true }) });
  check("long goal → title falls back cleanly without an ellipsis", longGoalCard?.title === "Goal converged" && !longGoalCard.title.includes("…"));
  check("long goal → durable body contains the complete uncut goal", longGoalCard?.body.includes(longGoal) === true);
  const canonicalLongGoal = longGoalCard ? canonicalizeCard(longGoalCard) : null;
  const canonicalEvidence = canonicalLongGoal?.sections.find((section) => section.label === "Evidence")?.content ?? "";
  check("heading-like goal text → remains wholly inside canonical Evidence", canonicalEvidence.includes(longGoal));
  check("heading-like goal text → cannot create extra canonical sections", canonicalLongGoal?.sections.length === 3);

  const stalled = verdictToCard({
    kind: "goal_titrate",
    goal: "converge purity",
    baseline_id: "b",
    job_id: "job12345678",
    result: mkGoal({ converged: false, decision: "critical-stall", failure_origin: "progress-stalled", turns: 4, overall_progress: 0.5 }),
  });
  check("goal stalled → REGRESSION", stalled?.type === "REGRESSION");
  check("goal stalled → medium confidence", stalled?.confidence === "medium");
  check("goal stalled → origin tag emitted", !!stalled?.tags.includes("origin:progress-stalled"));
  check("goal stalled → body names the decision", !!stalled?.body.includes("critical-stall"));
}

// ── runRefFor ───────────────────────────────────────────────────────────────────
check("runRef: goal_titrate uses the job_id", runRefFor({ kind: "goal_titrate", job_id: "JID-9" }) === "RUN-goaltitrate-JID-9");
check("runRef: verify uses baseline(8)+nonce", runRefFor({ kind: "verify", baseline_id: "abcd1234efgh", nonce: "deadbeef" }) === "RUN-verify-abcd1234-deadbeef");
check(
  "runRef: distinct nonces → distinct refs (no run collision)",
  runRefFor({ kind: "verify", baseline_id: "b0000000", nonce: "n1" }) !== runRefFor({ kind: "verify", baseline_id: "b0000000", nonce: "n2" }),
);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
