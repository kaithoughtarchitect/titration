// Titration MCP — B4b goal_titrate loop-core unit test (no network, no DB, no judge).
// Pins the PURE loop decision the I/O layer + server route on: sub-objective locking,
// per-turn scoring (converge / continue / stall / budget), the inconclusive-never-
// converges discipline, turn-over-turn stall detection, and the stop→origin mapping.
// Mirrors jobs.test.ts / rate-dissent.test.ts. The DB turn store snapshots these
// outcomes verbatim, so this is the offline contract for the loop.
// Run: npx tsx lib/__tests__/goal-titrate.test.ts

import {
  scoreTurn,
  classifyStop,
  lockSubObjectives,
  normalizeCandidateProvenance,
  environmentWarnings,
  PROGRESS_EPS,
  GOAL_TITRATE_TERMINAL_ORIGINS,
  type TurnVerdict,
  type TurnOutcome,
  type GoalTitrateConfig,
} from "../goal-titrate-core";
import { readFileSync } from "node:fs";

process.env.TITRATION_DATABASE_URL ??= "postgres://127.0.0.1:1/titration-offline-import-only";
const { stepGoalTitrateWithDependencies } = await import("../goal-titrate");
const { resolvePanel } = await import("../verify");

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}

// ── factories ─────────────────────────────────────────────────────────────────
function mkConfig(p: Partial<GoalTitrateConfig> = {}): GoalTitrateConfig {
  return {
    goal: "kill the bug",
    baseline_id: "b-1",
    budget: 10,
    stall_threshold: 3,
    target_rate: 0,
    sub_objectives: ["all"],
    ...p,
  };
}
function mkVerdict(p: Partial<TurnVerdict> = {}): TurnVerdict {
  const candidate_rate = p.candidate_rate ?? 0;
  const baseline_rate = p.baseline_rate ?? 0.8;
  return {
    passed: p.passed ?? false,
    inconclusive: p.inconclusive ?? false,
    metric_delta: p.metric_delta ?? candidate_rate - baseline_rate,
    baseline_rate,
    candidate_rate,
    floor_intact: p.floor_intact ?? true,
    direction_split: p.direction_split ?? false,
    failure_origin: p.failure_origin ?? null,
    confidence: p.confidence ?? "high",
    per_mode_candidate: p.per_mode_candidate ?? { all: { rate: candidate_rate, n: 20 } },
  };
}

// ── lockSubObjectives ─────────────────────────────────────────────────────────
check("lock: modes pass through deduped", JSON.stringify(lockSubObjectives(["engaged", "climax", "engaged"])) === JSON.stringify(["engaged", "climax"]));
check("lock: no modes → ['all']", JSON.stringify(lockSubObjectives([])) === JSON.stringify(["all"]));
check("lock: blanks filtered, falls back to ['all']", JSON.stringify(lockSubObjectives(["", "  "])) === JSON.stringify(["all"]));

// Structured candidate provenance stays separate from the baseline goal.
{
  const candidate = normalizeCandidateProvenance({
    name: "  CV91   Dedup  ",
    version: " 70c3fd7 ",
    summary: " staged   ingest dedup ",
    deferred_scope: " fuzzy semantic matching ",
  });
  check("candidate provenance: trims and normalizes every declared field", JSON.stringify(candidate) === JSON.stringify({
    name: "CV91 Dedup",
    version: "70c3fd7",
    summary: "staged ingest dedup",
    deferred_scope: "fuzzy semantic matching",
  }));
  check("candidate provenance: missing name degrades to null", normalizeCandidateProvenance({ summary: "anonymous" }) === null);
  check("candidate provenance: non-object degrades to null", normalizeCandidateProvenance("CV91") === null);
}

// ── classifyStop ──────────────────────────────────────────────────────────────
check("classifyStop converged → goal-complete", classifyStop("converged", false) === "goal-complete");
check("classifyStop critical-stall → progress-stalled", classifyStop("critical-stall", true) === "progress-stalled");
check("classifyStop budget+stalled → progress-stalled", classifyStop("budget-exhausted", true) === "progress-stalled");
check("classifyStop budget+progressing → turn-budget-reached", classifyStop("budget-exhausted", false) === "turn-budget-reached");
check("classifyStop continue → null", classifyStop("continue", false) === null);
check(
  "public terminal-origin contract stays aligned with the decision core",
  GOAL_TITRATE_TERMINAL_ORIGINS.join(" / ") === "goal-complete / turn-budget-reached / progress-stalled",
  GOAL_TITRATE_TERMINAL_ORIGINS.join(" / "),
);

// ── scoreTurn: convergence ──────────────────────────────────────────────────────
{
  const o = scoreTurn(mkVerdict({ passed: true, candidate_rate: 0 }), null, mkConfig(), 1);
  check("converge: passed + all met → converged/terminal", o.decision === "converged" && o.terminal && o.converged);
  check("converge: origin goal-complete", o.failure_origin === "goal-complete");
  check("converge: sub-objective 'all' met", o.sub_objectives[0].met && o.sub_objectives[0].status === "met");
  check("converge: overall_progress 1.0", o.overall_progress === 1);
}

// passed but not yet at target → keep iterating (passed alone ≠ converged)
{
  const o = scoreTurn(mkVerdict({ passed: true, candidate_rate: 0.3 }), null, mkConfig(), 1);
  check("passed-but-not-met → continue (not converged)", o.decision === "continue" && !o.converged);
  check("passed-but-not-met → sub not met", o.sub_objectives[0].met === false);
}

// ── scoreTurn: inconclusive never converges, never progresses ────────────────────
{
  const o = scoreTurn(mkVerdict({ passed: true, inconclusive: true, candidate_rate: 0, failure_origin: "judge-variance" }), null, mkConfig(), 1);
  check("inconclusive: never converged even if rate at target", o.converged === false && o.decision === "continue");
  check("inconclusive: flagged + no progress credited", o.inconclusive === true && o.progressed === false);
  check("inconclusive: stall counter advances", o.stall_turns === 1);
}

// ── scoreTurn: turn-1 vs-baseline improvement is progress (no spurious stall) ─────
{
  const o = scoreTurn(mkVerdict({ candidate_rate: 0.3, baseline_rate: 0.8 }), null, mkConfig(), 1);
  check("turn-1 improvement vs baseline → progressed, stall 0", o.progressed === true && o.stall_turns === 0);
  check("turn-1 unmet sub → status 'starting'", o.sub_objectives[0].status === "starting");
}

// ── scoreTurn: turn-over-turn progress resets stall; no-progress accrues it ───────
{
  const turn1 = scoreTurn(mkVerdict({ candidate_rate: 0.5 }), null, mkConfig(), 1);
  const turn2 = scoreTurn(mkVerdict({ candidate_rate: 0.2 }), turn1, mkConfig(), 2); // dropped 0.3 > EPS
  check("turn-2 meaningful drop → progressed, stall 0", turn2.progressed === true && turn2.stall_turns === 0);
  check("turn-2 sub delta computed vs prior", turn2.sub_objectives[0].delta === -0.3);
  const turn3 = scoreTurn(mkVerdict({ candidate_rate: 0.19 }), turn2, mkConfig(), 3); // moved < EPS
  check("turn-3 sub-EPS move → no progress, stall 1", turn3.progressed === false && turn3.stall_turns === 1);
}

// ── scoreTurn: critical-stall fires at the threshold ─────────────────────────────
{
  const cfg = mkConfig({ stall_threshold: 2 });
  const turn1 = scoreTurn(mkVerdict({ candidate_rate: 0.5 }), null, cfg, 1);
  const turn2 = scoreTurn(mkVerdict({ candidate_rate: 0.5 }), turn1, cfg, 2); // no change → stall 1
  const turn3 = scoreTurn(mkVerdict({ candidate_rate: 0.5 }), turn2, cfg, 3); // no change → stall 2 ≥ threshold
  check("critical-stall: fires when stall ≥ threshold", turn3.decision === "critical-stall" && turn3.terminal);
  check("critical-stall: origin progress-stalled", turn3.failure_origin === "progress-stalled");
  check("critical-stall: sub status 'stalled'", turn3.sub_objectives[0].status === "stalled");
}

// ── scoreTurn: budget reached while not stalled → neutral observed origin ─────────
{
  const cfg = mkConfig({ budget: 2, stall_threshold: 5 });
  const turn1 = scoreTurn(mkVerdict({ candidate_rate: 0.5 }), null, cfg, 1);
  const turn2 = scoreTurn(mkVerdict({ candidate_rate: 0.2 }), turn1, cfg, 2); // still improving, hit budget
  check("budget: exhausted at turn==budget, not converged → terminal", turn2.decision === "budget-exhausted" && turn2.terminal);
  check("budget: neutral origin turn-budget-reached", turn2.failure_origin === "turn-budget-reached");
  check("budget: reason does not diagnose goal size", !/goal needs more turns|goal-too-large/i.test(turn2.reason), turn2.reason);
}

// converged takes precedence over budget on the same turn
{
  const cfg = mkConfig({ budget: 1 });
  const o = scoreTurn(mkVerdict({ passed: true, candidate_rate: 0 }), null, cfg, 1);
  check("precedence: converged wins over budget on the final turn", o.decision === "converged");
}

// ── scoreTurn: floor breach blocks convergence ───────────────────────────────────
{
  const o = scoreTurn(mkVerdict({ passed: false, floor_intact: false, candidate_rate: 0 }), null, mkConfig(), 1);
  check("floor breach: all rates at target but not passed/floor → not converged", o.converged === false);
}

// ── scoreTurn: multi-mode — unmeasured sub stays unmet, blocks convergence ────────
{
  const cfg = mkConfig({ sub_objectives: ["engaged", "climax"] });
  // candidate only exercised 'engaged'; 'climax' unmeasured → assumed failing (rate 1)
  const v = mkVerdict({ passed: true, candidate_rate: 0, per_mode_candidate: { engaged: { rate: 0, n: 10 } } });
  const o = scoreTurn(v, null, cfg, 1);
  const climax = o.sub_objectives.find((s) => s.id === "climax")!;
  check("multi-mode: unmeasured sub rate carried to 1 (assumed unmet)", climax.measured === false && climax.rate === 1 && climax.met === false);
  check("multi-mode: a single unmet sub blocks convergence", o.converged === false && o.overall_progress === 0.5);
}

// PROGRESS_EPS is exposed for the I/O layer + this test to share one constant
check("PROGRESS_EPS exported", typeof PROGRESS_EPS === "number" && PROGRESS_EPS > 0);

// ── dependency-bound I/O seam ────────────────────────────────────────────────
check(
  "step dependency seam is explicit and not selectable through the ordinary signature",
  typeof stepGoalTitrateWithDependencies === "function"
    && stepGoalTitrateWithDependencies.length === 2,
);
// ── B2: environment drift warnings (fingerprint + per-mode n swings) ──────────
{
  check(
    "no fingerprints, no per-mode data → no warnings",
    environmentWarnings({}).length === 0,
  );
  check(
    "identical fingerprints → silent",
    environmentWarnings({
      prior_fingerprint: { client_script: "628355371dc17791", engine: "275c2a9" },
      fingerprint: { client_script: "628355371dc17791", engine: "275c2a9" },
    }).length === 0,
  );
  const clientScriptMoved = environmentWarnings({
    prior_fingerprint: { client_script: "old-sha", engine: "275c2a9" },
    fingerprint: { client_script: "new-sha", engine: "275c2a9" },
  });
  check(
    "a changed fingerprint field warns and NAMES the field (the mid-day client-script edit case)",
    clientScriptMoved.length === 1 && clientScriptMoved[0]!.includes("[client_script]") && clientScriptMoved[0]!.includes("may not be comparable"),
    JSON.stringify(clientScriptMoved),
  );
  const dropped = environmentWarnings({
    prior_fingerprint: { client_script: "sha" },
    fingerprint: null,
  });
  check(
    "declaring a fingerprint then omitting it warns (drift became uncheckable)",
    dropped.length === 1 && dropped[0]!.includes("not on this one"),
    JSON.stringify(dropped),
  );
  check(
    "a FIRST fingerprint declaration has nothing to compare — silent",
    environmentWarnings({ prior_fingerprint: null, fingerprint: { client_script: "sha" } }).length === 0,
  );
  const quotaDeath = environmentWarnings({
    prior_per_mode: { tool_ran: { rate: 0.7333, n: 18 }, no_tool: { rate: 0.0, n: 6 } },
    per_mode: { tool_ran: { rate: 0.4444, n: 9 }, no_tool: { rate: 0.0, n: 15 } },
  });
  check(
    "a large per-mode n swing warns per mode (the quota-died-mid-capture signature)",
    quotaDeath.length === 2 && quotaDeath.every((w) => w.includes("environment changed underneath")),
    JSON.stringify(quotaDeath),
  );
  check(
    "small n movement stays silent",
    environmentWarnings({
      prior_per_mode: { all: { rate: 0.5, n: 17 } },
      per_mode: { all: { rate: 0.45, n: 16 } },
    }).length === 0,
  );
}

{
  const source = readFileSync("lib/goal-titrate.ts", "utf8");
  check(
    "dependency-bound step calls its injected Verify port",
    /stepGoalTitrateWithDependencies\([\s\S]*?dependencies\.verify\(\s*\{/.test(source),
  );
  check(
    "ordinary step stays bound to the production Verify export",
    /const defaultStepDependencies[^=]*=\s*\{\s*verify\s*\}/.test(source)
      && /export async function stepGoalTitrate\([\s\S]*?return stepGoalTitrateWithDependencies\(\s*defaultStepDependencies,\s*args,\s*opts\s*\)/.test(source),
  );
  check(
    "grading failure preserves its original cause after the failed job state is recorded",
    /const gradingError = new Error\(msg, \{ cause \}\)/.test(source)
      && /await failJob\(jobId, msg\)[\s\S]*?throw gradingError/.test(source),
  );
  check(
    "grading plus failed-state persistence failure preserves both errors in order",
    /new AggregateError\(\s*\[gradingError, persistenceError\]/.test(source),
  );

  const startArgs = source.match(/export interface StartArgs \{[\s\S]*?\n\}/);
  check(
    "start does not accept judges to freeze into jobs.input",
    startArgs !== null && !/\bjudges\??:/.test(startArgs[0]),
    startArgs?.[0] ?? "StartArgs missing",
  );

  const configLit = source.match(/const config: GoalTitrateConfig = \{[\s\S]*?\n  \};/);
  check(
    "jobs.input config is not given a duplicate panel document",
    configLit !== null
      && /createJob\(args\.tenant, "goal_titrate", config\)/.test(source)
      && !/\bpanel\b/.test(configLit[0])
      && !/judge_panel/.test(configLit[0])
      && !/\bjudges\b/.test(configLit[0])
      && !/\bselection\b/.test(configLit[0]),
    configLit?.[0] ?? "config literal missing",
  );

  const verifyArgs = source.match(/dependencies\.verify\(\s*\{[\s\S]*?\}\s*,/);
  check(
    "step forwards caller judges and frozen baseline_id (lock reuse is verify's)",
    verifyArgs !== null
      && /judges:\s*args\.judges/.test(verifyArgs[0])
      && /baseline_id:\s*config\.baseline_id/.test(verifyArgs[0])
      && !/\bpanel\b/.test(verifyArgs[0])
      && !/judge_panel/.test(verifyArgs[0]),
    verifyArgs?.[0] ?? "verify args missing",
  );
  check(
    "default-panel steps unchanged: one verify call, no lock-side judge rewrite",
    (source.match(/dependencies\.verify\(/g) ?? []).length === 1
      && !/parseSelectedPanelLock/.test(source)
      && !/resolvePanel\s*\(/.test(source)
      && !/status:\s*4\d\d/.test(source),
  );
}

{
  // Chokepoint: a selected-panel step still forwards caller judges, but
  // resolvePanel rebuilds from the lock. Extra / substituting ids never run.
  const lockResolved = [
    {
      id: "anthropic/claude-opus-5",
      family: "anthropic",
      door: "openrouter" as const,
      model: "anthropic/claude-opus-5",
      effort: "low" as const,
    },
    {
      id: "openai/gpt-5.6-sol",
      family: "openai",
      door: "openrouter" as const,
      model: "openai/gpt-5.6-sol",
      effort: "medium" as const,
    },
    {
      id: "x-ai/grok-4.6",
      family: "x-ai",
      door: "openrouter" as const,
      model: "x-ai/grok-4.6",
      effort: "high" as const,
    },
  ];
  const lock = {
    source: "selected-panel-lock",
    resolved: lockResolved,
    ran: lockResolved.map((item) => item.id),
    failed: [],
    selection: {
      receipt_id: "receipt-1",
      confirmed_at: "2026-08-26T00:01:00.000Z",
      display: [
        { id: "anthropic/claude-opus-5", family: "anthropic" as const, effort: "low" as const },
        { id: "openai/gpt-5.6-sol", family: "openai" as const, effort: "medium" as const },
        { id: "x-ai/grok-4.6", family: "x-ai" as const, effort: "high" as const },
      ],
    },
  };
  const callerSubstitution = ["grok", "gpt", "deepseek", "extra-judge"];
  const envSubset = () => [{
    id: "grok",
    family: "xAI",
    door: "openrouter" as const,
    model: "x-ai/grok-4.3",
  }];
  const locked = resolvePanel(callerSubstitution, envSubset, lock);
  check(
    "selected-panel step does not honor caller judges substitution (lock ids reach verify)",
    locked.map((judge) => judge.id).join(",") === lockResolved.map((item) => item.id).join(",")
      && locked.every((judge, i) => judge.effort === lockResolved[i]!.effort),
    locked.map((judge) => `${judge.id}:${judge.effort}`).join(","),
  );

  const legacyPanel = [
    { id: "grok", family: "xAI", door: "openrouter" as const, model: "x-ai/grok-4.3" },
    { id: "gpt", family: "OpenAI", door: "openrouter" as const, model: "openai/gpt-5.5", effort: "high" as const },
    { id: "deepseek", family: "DeepSeek", door: "openrouter" as const, model: "deepseek/deepseek-v4-pro" },
  ];
  const defaultSubset = resolvePanel(["grok", "gpt"], () => legacyPanel);
  check(
    "default-panel step still honors caller judges subset",
    defaultSubset.map((judge) => judge.id).join(",") === "grok,gpt",
    defaultSubset.map((judge) => judge.id).join(","),
  );
}

// ── thresholds are frozen at turn 1, not settable per turn ────────────────────
//
// The gate a run is graded by must not be movable by the thing being graded. Before
// this, `thresholds` was accepted on `goal_titrate_step` and forwarded straight into
// verify, so a caller could pass `min_n: 1` on the very turn being graded (defeating
// the effective-N floor), `min_rate: 0` (defeating the baseline-reproduction refusal)
// or `panel_floor_share: 1` (defeating corroboration) — and `VerifyResult` does not
// echo the thresholds it used, so the weakened turn was indistinguishable from a
// default one in the stored verdict. `goal_titrate` (start) never accepted thresholds
// at all, so the per-turn door was the only one. They now freeze into the run config
// at turn 1 beside budget and sub_objectives, and every turn is graded by the same
// ruler — which is the only way turn N and turn N+1 are comparable at all.
{
  const config: GoalTitrateConfig = {
    goal: "g",
    baseline_id: "b-1",
    budget: 10,
    stall_threshold: 3,
    target_rate: 0,
    sub_objectives: ["all"],
    thresholds: { min_n: 3, min_abs: 2 },
  };
  check(
    "config carries frozen thresholds",
    config.thresholds?.min_n === 3 && config.thresholds?.min_abs === 2,
  );

  const libSource = readFileSync("lib/goal-titrate.ts", "utf8");
  const stepArgs = libSource.slice(
    libSource.indexOf("export interface StepArgs"),
    libSource.indexOf("export interface AuditEntry"),
  );
  check(
    "StepArgs does not accept thresholds",
    stepArgs.length > 0 && !/^\s*thresholds\??:/m.test(stepArgs),
    "a per-turn threshold override lets the graded party move its own gate",
  );
  check(
    "the step grades with the RUN's frozen thresholds, never the call's",
    /config\.thresholds \? \{ thresholds: config\.thresholds/.test(libSource)
      && !/thresholds: args\.thresholds/.test(libSource),
  );
  check(
    "StartArgs is the only door for thresholds",
    /export interface StartArgs[\s\S]*?thresholds\?: Thresholds;[\s\S]*?\n\}/.test(libSource),
  );

  // The MCP surface must not advertise what the lib refuses, or a caller gets a
  // silently-ignored argument and believes the gate moved when it did not.
  const mcpSource = readFileSync("server/mcp-server.ts", "utf8");
  const stepTool = mcpSource.slice(
    mcpSource.indexOf('name: "goal_titrate_step"'),
    mcpSource.indexOf('name: "harness_design"'),
  );
  check(
    "goal_titrate_step schema does not advertise thresholds",
    stepTool.length > 0 && !/thresholds: THRESHOLDS/.test(stepTool),
  );
  const startTool = mcpSource.slice(
    mcpSource.indexOf('name: "goal_titrate"'),
    mcpSource.indexOf('name: "goal_titrate_step"'),
  );
  check(
    "goal_titrate (start) schema advertises thresholds — the one door",
    startTool.length > 0 && /thresholds: \{ \.\.\.THRESHOLDS/.test(startTool),
    "without a start-time door the gates become unsettable rather than frozen",
  );
  // A schema that advertises an argument the handler drops is worse than no
  // argument: the caller sets the gates, sees no error, and is graded at the
  // defaults anyway. Advertising and forwarding must move together.
  check(
    "the goal_titrate start HANDLER forwards thresholds, not just the schema",
    /name === "goal_titrate"\)?\s*\n?\s*result = await startGoalTitrate\(\{[^}]*thresholds: a\.thresholds/.test(mcpSource),
    "schema advertises thresholds but the handler drops them — silently ignored argument",
  );
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
