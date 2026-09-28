// Titration MCP — verify dependency seam regression test (no network, no DB, no model, $0).
//
// The injected path is reserved for deterministic proof harnesses. It must still run
// verify's real prompt construction, panel aggregation, effective-N, noise-floor,
// rubric-freeze, and dissent logic; only the I/O ports are replaceable. The ordinary
// production export remains bound to the real panel, baseline store, and draft hook.
// Run: npx tsx lib/__tests__/verify.test.ts

import { readFileSync } from "node:fs";
import type { EstablishDependencies, VerifyDependencies } from "../verify";
import type { BaselineRow, NewBaseline } from "../baseline";
import {
  DEFAULT_PANEL,
  snapshotPanel,
  type JudgeSpec,
} from "../judge";
import type { ConfirmedPanelSnapshot } from "../referee-panel-ticket-core";

process.env.TITRATION_DATABASE_URL ??= "postgres://127.0.0.1:1/titration-offline-import-only";
const { verifyWithDependencies, establishWithDependencies, resolvePanel } = await import("../verify");

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail = "") {
  total++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}

const panel: JudgeSpec[] = [
  { id: "dry-a", family: "DryVendorA", door: "codex", model: "deterministic-a" },
  { id: "dry-b", family: "DryVendorB", door: "codex", model: "deterministic-b" },
];
const baseline: BaselineRow = {
  id: "baseline-dry",
  tenant: "demo",
  goal: "remove the synthetic failure",
  system_ref: null,
  corpus_ref: "dry-corpus",
  rubric_text: "Fail only when the output contains BUG.",
  rubric_hash: "sealed-rubric-hash",
  baseline_rate: 1,
  effective_n: 2,
  agreement: 1,
  per_mode: { all: { rate: 1, n: 2 } },
  per_judge: {
    "dry-a": { rate: 1, n: 2 },
    "dry-b": { rate: 1, n: 2 },
  },
  judge_panel: {
    source: "recorded-at-grade",
    resolved: [],
    ran: ["dry-a", "dry-b"],
    failed: [],
  },
  reproduced: true,
  created_at: "2026-08-20T00:00:00.000Z",
};

const prompts: string[] = [];
let beforeProviderCalls = 0;
let draftCalls = 0;
let panelCalls = 0;
// ideal-model fake: this proves only the injected port contract; a live smoke
// test separately supplies the cross-layer database/retrieval evidence.
const dependencies: VerifyDependencies = {
  activePanel: () => panel,
  loadBaseline: async () => baseline,
  maybeDraftRefusalCandidate: async () => { draftCalls++; },
  runPanel: async (system, user, resolvedPanel, beforeProviderCall) => {
    panelCalls++;
    prompts.push(`${system}\n${user}`);
    if (beforeProviderCall) await beforeProviderCall();
    const secondFails = user.includes("CLEAN TWO");
    const judges = resolvedPanel ?? [];
    return {
      ok: judges
        .filter((judge) => !(secondFails && judge.id === "dry-b"))
        .map((judge) => ({
          id: judge.id,
          family: judge.family,
          model: judge.model,
          json: { reasoning: "synthetic output is clean", verdict: "pass", confidence: "high" },
        })),
      failed: secondFails
        ? [{ id: "dry-b", family: "DryVendorB", model: "deterministic-b", error: "typed fake outage" }]
        : [],
    };
  },
};

const result = await verifyWithDependencies(
  dependencies,
  {
    tenant: "demo",
    baseline_id: baseline.id,
    candidate_outputs: [
      { id: "row-1", mode: "all", input: "probe one", output: "CLEAN ONE" },
      { id: "row-2", mode: "all", input: "probe two", output: "CLEAN TWO" },
    ],
    judges: ["dry-a", "dry-b"],
    // panel_floor_share raised above the fixture's 1-of-2 single-vote row: this suite
    // proves the dependency SEAM, not the A8 panel-floor policy (that policy has its
    // own suite, panel-coverage.test.ts).
    thresholds: { min_n: 2, panel_floor_share: 0.5 },
  },
  { beforeProviderCall: async () => { beforeProviderCalls++; } },
);

check("injected panel port runs once per candidate row", panelCalls === 2, String(panelCalls));
check("before-provider hook crosses the injected port once per row", beforeProviderCalls === 2, String(beforeProviderCalls));
check(
  "real grader prompt construction wraps each output as data under the frozen rubric",
  prompts.length === 2
    && prompts[0]!.includes("Fail only when the output contains BUG.")
    && prompts[0]!.includes("<output>\nCLEAN ONE\n</output>")
    && prompts[1]!.includes("<output>\nCLEAN TWO\n</output>"),
);
check(
  "real aggregation/effective-N/rubric logic returns the expected improvement",
  result.passed
    && !result.inconclusive
    && result.metric_delta === -1
    && result.effective_n.candidate === 2
    && result.rubric_hash === baseline.rubric_hash,
  JSON.stringify(result),
);
check(
  "a row-level judge failure remains visible in the returned panel trace",
  result.panel.ran.join(",") === "dry-a,dry-b"
    && result.panel.failed.length === 1
    && result.panel.failed[0]!.id === "dry-b"
    && result.panel.failed[0]!.count === 1
    && result.panel.failed[0]!.error === "typed fake outage",
  JSON.stringify(result.panel),
);
check("default-off refusal drafting stays off on the injected path", draftCalls === 0, String(draftCalls));

const source = readFileSync("lib/verify.ts", "utf8");
check(
  "ordinary verify remains bound to the real production dependency set",
  /const defaultVerifyDependencies[^=]*=\s*\{[\s\S]*?activePanel[\s\S]*?runPanel[\s\S]*?loadBaseline[\s\S]*?maybeDraftRefusalCandidate[\s\S]*?\}/.test(source)
    && /export async function verify\([\s\S]*?return verifyWithDependencies\(\s*defaultVerifyDependencies,\s*args,\s*opts\s*\)/.test(source),
);
check(
  "resolvePanel is exported as the lock chokepoint",
  /export function resolvePanel\(/.test(source)
    && source.includes("parseSelectedPanelLock(lock)"),
);
check(
  "EstablishArgs accepts optional panel_receipt_id",
  /export interface EstablishArgs[\s\S]*?panel_receipt_id\?: string;/.test(source),
);
check(
  "lock path does not fall through via isSelectedPanelLock to DEFAULT_PANEL",
  !/if\s*\(\s*isSelectedPanelLock/.test(source),
);
check(
  "selected-panel freeze overwrites recorded-at-grade before insert",
  source.includes("frozenSelectedPanel(selectedLock, g.panel)")
    && source.indexOf("frozenSelectedPanel(selectedLock, g.panel)") < source.indexOf("dependencies.insertBaseline"),
);
check(
  "sync path stamps used_for_baseline_id after insertBaseline",
  source.indexOf("dependencies.insertBaseline") < source.indexOf("dependencies.stampUsedForBaseline")
    && source.includes("stampUsedForBaseline"),
);
check(
  "skipReceiptStamp no-ops the inner stamp so the async job worker's own stamp is authoritative",
  source.includes("skipReceiptStamp")
    && source.includes("stampUsedForBaseline: async () => undefined"),
);

function throws(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e: unknown) {
    return String(e instanceof Error ? e.message : e);
  }
}

async function throwsAsync(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e: unknown) {
    return String(e instanceof Error ? e.message : e);
  }
}

const LOCK_RESOLVED = [
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
const LOCK_IDS = LOCK_RESOLVED.map((item) => item.id).join(",");
const LOCK_DISPLAY = [
  { id: "anthropic/claude-opus-5", family: "anthropic" as const, effort: "low" as const },
  { id: "openai/gpt-5.6-sol", family: "openai" as const, effort: "medium" as const },
  { id: "x-ai/grok-4.6", family: "x-ai" as const, effort: "high" as const },
];

function validLock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: "selected-panel-lock",
    resolved: LOCK_RESOLVED.map((item) => ({ ...item })),
    ran: LOCK_RESOLVED.map((item) => item.id),
    failed: [],
    selection: {
      receipt_id: "receipt-1",
      confirmed_at: "2026-08-26T00:01:00.000Z",
      display: LOCK_DISPLAY.map((item) => ({ ...item })),
    },
    ...overrides,
  };
}

const reconstructed = {
  source: "reconstructed-from-engine-config" as const,
  resolved: snapshotPanel(DEFAULT_PANEL),
  ran: DEFAULT_PANEL.map((judge) => judge.id),
  failed: [] as { id: string; error: string; count?: number }[],
};

// The ticket's confirmed snapshot IS the lock shape —
// `resolved` reuses LOCK_RESOLVED verbatim (same {id, family,
// door, model, effort} shape), no separate catalog `picks`/`display` cards.
const CONFIRMED_SNAPSHOT: ConfirmedPanelSnapshot = {
  resolved: [{ ...LOCK_RESOLVED[0]! }, { ...LOCK_RESOLVED[1]! }, { ...LOCK_RESOLVED[2]! }] as unknown as ConfirmedPanelSnapshot["resolved"],
  selection: {
    receipt_id: "receipt-1",
    confirmed_at: "2026-08-26T00:01:00.000Z",
    player_family: null,
  },
};

{
  const envSubset: JudgeSpec[] = [DEFAULT_PANEL[0]!];
  const locked = resolvePanel(["grok", "gpt", "extra-judge"], () => envSubset, validLock());
  check(
    "locked resolvePanel ignores extra caller judges and env subset",
    locked.map((judge) => judge.id).join(",") === LOCK_IDS
      && locked[0]?.effort === "low"
      && locked[1]?.effort === "medium"
      && locked[2]?.effort === "high",
    locked.map((judge) => `${judge.id}:${judge.effort}`).join(","),
  );
  check(
    "locked specs keep catalog family + slug identity",
    locked[0]?.family === "anthropic"
      && locked[0]?.model === "anthropic/claude-opus-5"
      && locked[0]?.door === "openrouter",
  );
}

{
  const errReconstructed = throws(() => resolvePanel(undefined, () => DEFAULT_PANEL, reconstructed));
  check(
    "reconstructed is not used as lock",
    errReconstructed !== null && errReconstructed.includes("selected-panel-lock"),
    errReconstructed ?? "no throw",
  );
  const two = LOCK_RESOLVED.slice(0, 2);
  const errStrip = throws(() => resolvePanel(undefined, () => DEFAULT_PANEL, validLock({
    resolved: two,
    ran: two.map((item) => item.id),
    selection: {
      receipt_id: "receipt-1",
      confirmed_at: "2026-08-26T00:01:00.000Z",
      display: LOCK_DISPLAY.slice(0, 2),
    },
  })));
  check(
    "lock strip throws (never silent subset)",
    errStrip !== null,
    errStrip ?? "no throw",
  );
  const errSubstitute = throws(() => resolvePanel(undefined, () => DEFAULT_PANEL, {
    source: "selected-panel-lock",
    resolved: snapshotPanel(DEFAULT_PANEL),
    ran: ["grok", "gpt", "deepseek"],
    failed: [],
    selection: {
      receipt_id: "receipt-1",
      confirmed_at: "2026-08-26T00:01:00.000Z",
      display: DEFAULT_PANEL.map((judge) => ({
        id: judge.id,
        family: judge.family,
        effort: "high",
      })),
    },
  }));
  check(
    "lock substitute of DEFAULT_PANEL identity throws",
    errSubstitute !== null,
    errSubstitute ?? "no throw",
  );
}

{
  const envOnlyGrok = () => [DEFAULT_PANEL[0]!];
  const noLock = throws(() => resolvePanel(["grok"], envOnlyGrok));
  check(
    "legacy no-lock still refuses <2 after env strip",
    noLock !== null && noLock.includes("≥2"),
    noLock ?? "no throw",
  );
}

const lockedBaseline: BaselineRow = {
  ...baseline,
  id: "baseline-lock",
  per_judge: {
    "anthropic/claude-opus-5": { rate: 1, n: 2 },
    "openai/gpt-5.6-sol": { rate: 1, n: 2 },
    "x-ai/grok-4.6": { rate: 1, n: 2 },
  },
  judge_panel: validLock() as unknown as BaselineRow["judge_panel"],
};

{
  const seen: string[][] = [];
  const lockedVerify = await verifyWithDependencies(
    {
      activePanel: () => DEFAULT_PANEL,
      loadBaseline: async () => lockedBaseline,
      maybeDraftRefusalCandidate: async () => {},
      runPanel: async (_system, _user, resolvedPanel) => {
        seen.push((resolvedPanel ?? []).map((judge) => judge.id));
        return {
          ok: (resolvedPanel ?? []).map((judge) => ({
            id: judge.id,
            family: judge.family,
            model: judge.model,
            json: { reasoning: "clean", verdict: "pass", confidence: "high" },
          })),
          failed: [],
        };
      },
    },
    {
      tenant: "demo",
      baseline_id: lockedBaseline.id,
      candidate_outputs: [
        { id: "row-1", mode: "all", output: "CLEAN ONE" },
        { id: "row-2", mode: "all", output: "CLEAN TWO" },
      ],
      judges: ["grok", "gpt", "deepseek", "extra-judge"],
      thresholds: { min_n: 2, panel_floor_share: 0.5 },
    },
  );
  check(
    "locked verify ignores extra judges and invokes only selected referees",
    seen.length === 2 && seen.every((ids) => ids.join(",") === LOCK_IDS),
    JSON.stringify(seen),
  );
  check(
    "locked verify result panel.source remains recorded-at-grade",
    lockedVerify.panel.source === "recorded-at-grade"
      && lockedVerify.panel.resolved.map((snap) => snap.id).join(",") === LOCK_IDS,
    JSON.stringify(lockedVerify.panel),
  );
}

{
  const seen: string[][] = [];
  await verifyWithDependencies(
    {
      activePanel: () => panel,
      loadBaseline: async () => ({
        ...baseline,
        judge_panel: reconstructed,
      }),
      maybeDraftRefusalCandidate: async () => {},
      runPanel: async (_system, _user, resolvedPanel) => {
        seen.push((resolvedPanel ?? []).map((judge) => judge.id));
        return {
          ok: (resolvedPanel ?? []).map((judge) => ({
            id: judge.id,
            family: judge.family,
            model: judge.model,
            json: { reasoning: "clean", verdict: "pass", confidence: "high" },
          })),
          failed: [],
        };
      },
    },
    {
      tenant: "demo",
      baseline_id: baseline.id,
      candidate_outputs: [
        { id: "row-1", mode: "all", output: "CLEAN ONE" },
        { id: "row-2", mode: "all", output: "CLEAN TWO" },
      ],
      judges: ["dry-a", "dry-b"],
      thresholds: { min_n: 2, panel_floor_share: 0.5 },
    },
  );
  check(
    "reconstructed baseline is not used as lock (DEFAULT_PANEL path)",
    seen.length === 2 && seen.every((ids) => ids.join(",") === "dry-a,dry-b"),
    JSON.stringify(seen),
  );
}

{
  const garbageErr = await throwsAsync(() => verifyWithDependencies(
    {
      activePanel: () => DEFAULT_PANEL,
      loadBaseline: async () => ({
        ...baseline,
        judge_panel: validLock({ resolved: LOCK_RESOLVED.slice(0, 1) }) as unknown as BaselineRow["judge_panel"],
      }),
      maybeDraftRefusalCandidate: async () => {},
      runPanel: async () => ({ ok: [], failed: [] }),
    },
    {
      tenant: "demo",
      baseline_id: baseline.id,
      candidate_outputs: [{ id: "row-1", mode: "all", output: "CLEAN" }],
    },
  ));
  check(
    "lock-shaped garbage on verify throws rather than substituting DEFAULT_PANEL",
    garbageErr !== null && !garbageErr.includes("grok"),
    garbageErr ?? "no throw",
  );
}

{
  // Greptile follow-up contract: an UNREADABLE stored panel survives the READ
  // (loadBaseline returns panel:null + bounded raw companion) but verify still
  // REFUSES before any judge spend — never substituting caller judges or
  // DEFAULT_PANEL (NV-06).
  let panelCalls = 0;
  const unreadableErr = await throwsAsync(() => verifyWithDependencies(
    {
      activePanel: () => DEFAULT_PANEL,
      loadBaseline: async () => ({
        ...baseline,
        judge_panel: null,
        judge_panel_unreadable: { error: "judge_panel.resolved must be an array", raw: "{\"source\":\"selected-panel-lock\"}" },
      }),
      maybeDraftRefusalCandidate: async () => {},
      runPanel: async () => {
        panelCalls += 1;
        return { ok: [], failed: [] };
      },
    },
    {
      tenant: "demo",
      baseline_id: baseline.id,
      candidate_outputs: [{ id: "row-1", mode: "all", output: "CLEAN" }],
    },
  ));
  check(
    "unreadable stored panel refuses to grade before spend (no substitution)",
    unreadableErr !== null
      && unreadableErr.includes("unreadable")
      && unreadableErr.includes("Re-establish")
      && panelCalls === 0,
    `${unreadableErr ?? "no throw"} panelCalls=${panelCalls}`,
  );
}

const failRows = [
  { id: "row-1", mode: "all", output: "BUG ONE" },
  { id: "row-2", mode: "all", output: "BUG TWO" },
  { id: "row-3", mode: "all", output: "BUG THREE" },
];

function establishDeps(opts: {
  activePanel?: () => JudgeSpec[];
  loadConfirmedReceipt?: EstablishDependencies["loadConfirmedReceipt"];
  resolveEnvJudgePanel?: EstablishDependencies["resolveEnvJudgePanel"];
  runPanel: EstablishDependencies["runPanel"];
  inserted: NewBaseline[];
  stamps: { id: string; baselineId: string }[];
}): EstablishDependencies {
  return {
    activePanel: opts.activePanel ?? (() => DEFAULT_PANEL),
    runPanel: opts.runPanel,
    insertBaseline: async (_tenant, row) => {
      opts.inserted.push(row);
      return { baseline_id: "baseline-frozen-1" };
    },
    hasPerRowColumn: async () => true,
    maybeDraftRefusalCandidate: async () => {},
    loadConfirmedReceipt: opts.loadConfirmedReceipt ?? (async () => {
      throw new Error("loadConfirmedReceipt should not run without panel_receipt_id");
    }),
    stampUsedForBaseline: async (input) => {
      opts.stamps.push({ id: input.id, baselineId: input.baselineId });
      return {};
    },
    // The real production default (lib/judges-roster.ts's
    // resolveEnvJudgePanel) refuses naming referee_panel_mint when TITRATION_JUDGES
    // is unset and no receipt was supplied — this fake mirrors exactly that, so a
    // test that wants the OLD "no receipt -> DEFAULT_PANEL" shape must override it.
    resolveEnvJudgePanel: opts.resolveEnvJudgePanel ?? (async () => {
      throw new Error(
        "no judge panel is available: TITRATION_JUDGES is unset and no panel_receipt_id was supplied " +
        "(mint one with referee_panel_mint)",
      );
    }),
  };
}

{
  const inserted: NewBaseline[] = [];
  const stamps: { id: string; baselineId: string }[] = [];
  const seen: string[][] = [];
  const result = await establishWithDependencies(
    establishDeps({
      activePanel: () => DEFAULT_PANEL,
      inserted,
      stamps,
      loadConfirmedReceipt: async () => ({
        id: "receipt-1",
        confirmation_snapshot: CONFIRMED_SNAPSHOT,
      }),
      runPanel: async (_system, _user, resolvedPanel) => {
        seen.push((resolvedPanel ?? []).map((judge) => judge.id));
        return {
          ok: (resolvedPanel ?? []).map((judge) => ({
            id: judge.id,
            family: judge.family,
            model: judge.model,
            json: { reasoning: "bug present", verdict: "fail", confidence: "high" },
          })),
          failed: [],
        };
      },
    }),
    {
      tenant: "demo",
      goal: "remove the synthetic failure",
      rubric: "Fail only when the output contains BUG.",
      baseline_outputs: failRows,
      judges: ["grok", "gpt", "deepseek", "extra-judge"],
      panel_receipt_id: "receipt-1",
      thresholds: { min_n: 2, min_abs: 1, min_rate: 0.1 },
    },
  );
  check(
    "locked establish ignores extra judges and invokes only selected referees",
    seen.length === 3 && seen.every((ids) => ids.join(",") === LOCK_IDS),
    JSON.stringify(seen),
  );
  check("locked establish freezes", result.reproduced === true && result.baseline_id === "baseline-frozen-1");
  const stored = inserted[0]?.judge_panel;
  check(
    "freeze writes selected-panel-lock + selection (not recorded-at-grade)",
    stored?.source === "selected-panel-lock"
      && stored.selection?.receipt_id === "receipt-1"
      && stored.selection?.confirmed_at === CONFIRMED_SNAPSHOT.selection.confirmed_at
      && stored.resolved.map((snap) => snap.id).join(",") === LOCK_IDS
      && stored.selection.display.map((item) => item.id).join(",") === LOCK_IDS,
    JSON.stringify(stored),
  );
  check(
    "establish result panel.source stays recorded-at-grade",
    result.panel.source === "recorded-at-grade",
    result.panel.source,
  );
  check(
    "sync path stamps used_for_baseline_id after freeze",
    stamps.length === 1 && stamps[0]?.id === "receipt-1" && stamps[0]?.baselineId === "baseline-frozen-1",
    JSON.stringify(stamps),
  );
}

// establish_baseline with neither a panel_receipt_id
// NOR TITRATION_JUDGES refuses with a typed error naming referee_panel_mint
// instead of silently grading on a default panel. 3 checks prove that refusal: it
// throws, it names referee_panel_mint, and it fires before any judge spend,
// baseline insert, or receipt stamp.
{
  const inserted: NewBaseline[] = [];
  const stamps: { id: string; baselineId: string }[] = [];
  let panelCalls = 0;
  const err = await throwsAsync(() => establishWithDependencies(
    establishDeps({
      inserted,
      stamps,
      runPanel: async () => {
        panelCalls++;
        return { ok: [], failed: [] };
      },
    }),
    {
      tenant: "demo",
      goal: "remove the synthetic failure",
      rubric: "Fail only when the output contains BUG.",
      baseline_outputs: failRows,
      thresholds: { min_n: 2, min_abs: 1, min_rate: 0.1 },
    },
  ));
  check(
    "no receipt and no TITRATION_JUDGES refuses (typed error, not a silent DEFAULT_PANEL fall-through)",
    err !== null,
    err ?? "no throw",
  );
  check(
    "the refusal names referee_panel_mint",
    err !== null && err.includes("referee_panel_mint"),
    err ?? "no throw",
  );
  check(
    "the refusal fires before any judge spend, baseline insert, or receipt stamp",
    panelCalls === 0 && inserted.length === 0 && stamps.length === 0,
    `panelCalls=${panelCalls} inserted=${inserted.length} stamps=${stamps.length}`,
  );
}

{
  const inserted: NewBaseline[] = [];
  const stamps: { id: string; baselineId: string }[] = [];
  let panelCalls = 0;
  const err = await throwsAsync(() => establishWithDependencies(
    establishDeps({
      inserted,
      stamps,
      loadConfirmedReceipt: async () => {
        throw new Error("not_confirmed");
      },
      runPanel: async () => {
        panelCalls++;
        return { ok: [], failed: [] };
      },
    }),
    {
      tenant: "demo",
      goal: "remove the synthetic failure",
      rubric: "Fail only when the output contains BUG.",
      baseline_outputs: failRows,
      panel_receipt_id: "pending-ticket",
    },
  ));
  check(
    "unconfirmed receipt refuses before spend",
    err === "not_confirmed" && panelCalls === 0 && inserted.length === 0 && stamps.length === 0,
    `err=${err} calls=${panelCalls} inserted=${inserted.length}`,
  );
}

// A full panel that finds no failure refuses as not-reproduced, and says so.
{
  const clean = Array.from({ length: 24 }, (_, i) => ({ id: `clean-${i + 1}`, mode: "all", output: `CLEAN ${i + 1}` }));
  const inserted: NewBaseline[] = [];
  const stamps: { id: string; baselineId: string }[] = [];
  const notReproduced = await establishWithDependencies(
    establishDeps({
      inserted,
      stamps,
      loadConfirmedReceipt: async () => ({ id: "receipt-1", confirmation_snapshot: CONFIRMED_SNAPSHOT }),
      runPanel: async (_system, _user, resolvedPanel) => ({
        ok: (resolvedPanel ?? []).map((judge) => ({
          id: judge.id,
          family: judge.family,
          model: judge.model,
          json: { reasoning: "clean", verdict: "pass", confidence: "high" },
        })),
        failed: [],
      }),
    }),
    {
      tenant: "demo",
      goal: "remove the synthetic failure",
      rubric: "Fail only when the output contains BUG.",
      baseline_outputs: clean,
      panel_receipt_id: "receipt-1",
    },
  );
  check(
    "a corpus that does not show the failure refuses with refused_because: not_reproduced",
    notReproduced.baseline_id === null
      && notReproduced.reproduced === false
      && notReproduced.refused_because === "not_reproduced"
      && inserted.length === 0,
    JSON.stringify({ refused_because: notReproduced.refused_because, baseline_id: notReproduced.baseline_id }),
  );
}

{
  const twentyFour = Array.from({ length: 24 }, (_, i) => ({
    id: `row-${i + 1}`,
    mode: "all",
    output: `CLEAN ${i + 1}`,
  }));
  const surviving = LOCK_RESOLVED[0]!.id;
  const inserted: NewBaseline[] = [];
  const stamps: { id: string; baselineId: string }[] = [];
  const establishDegraded = await establishWithDependencies(
    establishDeps({
      inserted,
      stamps,
      loadConfirmedReceipt: async () => ({
        id: "receipt-1",
        confirmation_snapshot: CONFIRMED_SNAPSHOT,
      }),
      runPanel: async (_system, _user, resolvedPanel) => ({
        ok: (resolvedPanel ?? []).filter((judge) => judge.id === surviving).map((judge) => ({
          id: judge.id,
          family: judge.family,
          model: judge.model,
          json: { reasoning: "clean", verdict: "pass", confidence: "high" },
        })),
        failed: (resolvedPanel ?? []).filter((judge) => judge.id !== surviving).map((judge) => ({
          id: judge.id,
          family: judge.family,
          model: judge.model,
          error: "OpenRouter request failed (402)",
        })),
      }),
    }),
    {
      tenant: "demo",
      goal: "remove the synthetic failure",
      rubric: "Fail only when the output contains BUG.",
      baseline_outputs: twentyFour,
      panel_receipt_id: "receipt-1",
    },
  );
  check(
    "a panel-degraded refusal names its gate (refused_because: panel_degraded)",
    establishDegraded.refused_because === "panel_degraded",
    String(establishDegraded.refused_because),
  );
  check(
    "<2 selected responders refuse to freeze without retuning coverage math",
    establishDegraded.baseline_id === null
      && establishDegraded.reproduced === false
      && establishDegraded.reason.includes("REFUSED to freeze")
      && establishDegraded.votes.expected === 72
      && establishDegraded.votes.received === 24
      && inserted.length === 0
      && stamps.length === 0,
    JSON.stringify({
      reason: establishDegraded.reason,
      votes: establishDegraded.votes,
      inserted: inserted.length,
    }),
  );

  const verifyDegraded = await verifyWithDependencies(
    {
      activePanel: () => DEFAULT_PANEL,
      loadBaseline: async () => ({
        id: "baseline-lock",
        tenant: "demo",
        goal: "remove the synthetic failure",
        system_ref: null,
        corpus_ref: "dry-corpus",
        rubric_text: "Fail only when the output contains BUG.",
        rubric_hash: "sealed-rubric-hash",
        baseline_rate: 1,
        effective_n: 24,
        agreement: 1,
        per_mode: { all: { rate: 1, n: 24 } },
        per_judge: {
          "anthropic/claude-opus-5": { rate: 1, n: 24 },
          "openai/gpt-5.6-sol": { rate: 1, n: 24 },
          "x-ai/grok-4.6": { rate: 1, n: 24 },
        },
        judge_panel: validLock() as unknown as BaselineRow["judge_panel"],
        reproduced: true,
        created_at: "2026-08-26T00:00:00.000Z",
      }),
      maybeDraftRefusalCandidate: async () => {},
      runPanel: async (_system, _user, resolvedPanel) => ({
        ok: (resolvedPanel ?? []).filter((judge) => judge.id === surviving).map((judge) => ({
          id: judge.id,
          family: judge.family,
          model: judge.model,
          json: { reasoning: "clean", verdict: "pass", confidence: "high" },
        })),
        failed: (resolvedPanel ?? []).filter((judge) => judge.id !== surviving).map((judge) => ({
          id: judge.id,
          family: judge.family,
          model: judge.model,
          error: "OpenRouter request failed (402)",
        })),
      }),
    },
    {
      tenant: "demo",
      baseline_id: "baseline-lock",
      candidate_outputs: twentyFour,
    },
  );
  check(
    "<2 selected responders on verify stay panel-degraded (coverage math untouched)",
    verifyDegraded.inconclusive === true
      && verifyDegraded.passed === false
      && verifyDegraded.failure_origin === "panel-degraded"
      && verifyDegraded.votes.expected === 72
      && verifyDegraded.votes.received === 24
      && verifyDegraded.panel.source === "recorded-at-grade",
    JSON.stringify({
      origin: verifyDegraded.failure_origin,
      votes: verifyDegraded.votes,
      source: verifyDegraded.panel.source,
    }),
  );
}

console.log(`\n${failures === 0 ? `ALL PASS (${total})` : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
