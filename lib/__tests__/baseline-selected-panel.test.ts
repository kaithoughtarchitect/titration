// Titration MCP — baseline selected-panel-lock persist/load (no network, no DB, no model — $0).
// Pins the load chokepoint: parseJudgePanelTrace on stored panels, reconstructed fallback
// is not a lock, lock-shaped garbage throws rather than recorded-at-grade, insert stays sql.json.
// Does not import lib/baseline.ts (that module opens store.ts). Values are the ones
// parseLoadedJudgePanel would pass to parseJudgePanelTrace, plus source-wiring of baseline.ts.
// Mirrors lib/__tests__/judge-selected-panel-lock.test.ts (check/total/failures + process.exit).
// Run: npx tsx lib/__tests__/baseline-selected-panel.test.ts

import { readFileSync } from "node:fs";
import {
  DEFAULT_PANEL,
  isSelectedPanelLock,
  parseJudgePanelTrace,
  snapshotPanel,
} from "../judge";

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

const LOCK_DISPLAY = [
  { id: "anthropic/claude-opus-5", family: "anthropic", effort: "low" as const },
  { id: "openai/gpt-5.6-sol", family: "openai", effort: "medium" as const },
  { id: "x-ai/grok-4.6", family: "x-ai", effort: "high" as const },
];

function validLock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: "selected-panel-lock",
    resolved: LOCK_RESOLVED.map((item) => ({ ...item })),
    ran: LOCK_RESOLVED.map((item) => item.id),
    failed: [],
    selection: {
      receipt_id: "receipt-1",
      confirmed_at: "2026-08-26T00:00:00.000Z",
      display: LOCK_DISPLAY.map((item) => ({ ...item })),
    },
    ...overrides,
  };
}

function reconstructedFallback(ran: string[]) {
  const ids = new Set(ran);
  return {
    source: "reconstructed-from-engine-config" as const,
    resolved: snapshotPanel(DEFAULT_PANEL.filter((judge) => ids.has(judge.id))),
    ran,
    failed: [] as { id: string; error: string; count?: number }[],
  };
}

const baselineSrc = readFileSync("lib/baseline.ts", "utf8");

// ── wiring: load uses parseJudgePanelTrace; insert stays sql.json ─────────────
check(
  "baseline.ts imports parseJudgePanelTrace",
  /import\s*\{[^}]*parseJudgePanelTrace[^}]*\}\s*from\s*"\.\/judge"/.test(baselineSrc),
);
check(
  "loadBaseline routes judge_panel through parseLoadedJudgePanel",
  baselineSrc.includes("parseLoadedJudgePanel(r.judge_panel, Object.keys(perJudge))")
    && baselineSrc.includes("judge_panel: loaded.panel"),
);
check(
  "parseLoadedJudgePanel calls parseJudgePanelTrace on present panels",
  /export function parseLoadedJudgePanel[\s\S]*return \{ panel: parseJudgePanelTrace\(candidate\) \}/.test(baselineSrc),
);
check(
  "unparseable stored panel becomes panel:null with a bounded raw companion (read never throws)",
  /return \{\s*panel: null,\s*unreadable: \{/.test(baselineSrc)
    && baselineSrc.includes(".slice(0, 2048)")
    && baselineSrc.includes("judge_panel_unreadable"),
);
check(
  "local isPanelTrace guard is gone",
  !baselineSrc.includes("function isPanelTrace") && !baselineSrc.includes("isPanelTrace("),
);
check(
  "insert still binds judge_panel via sql.json (not JSON.stringify)",
  baselineSrc.includes("const panelJson = sql.json((b.judge_panel ?? reconstructedPanel(Object.keys(b.per_judge))) as any)")
    && baselineSrc.includes("${panelJson}")
    && !/JSON\.stringify\(\s*b\.judge_panel/.test(baselineSrc),
);
check(
  "missing stored panel reconstructs instead of parsing as a lock",
  /if \(isEmptyJudgePanel\(candidate\)\) \{\s*return \{ panel: reconstructedPanel\(fallbackRan\) \};/.test(baselineSrc),
);
check(
  "reconstructedPanel source is reconstructed-from-engine-config",
  /function reconstructedPanel[\s\S]*source:\s*"reconstructed-from-engine-config"/.test(baselineSrc),
);
check(
  "load path does not coerce unknown sources to recorded-at-grade",
  !/source:\s*["']recorded-at-grade["']/.test(baselineSrc)
    && !/source\s*=\s*["']recorded-at-grade["']/.test(baselineSrc)
    && !/source:\s*candidate\.source[\s\S]{0,80}recorded-at-grade/.test(baselineSrc),
);

// ── stored selected-panel-lock round-trips selection ──────────────────────────
{
  const stored = validLock();
  const parsed = parseJudgePanelTrace(stored);
  check("stored lock source is selected-panel-lock", parsed.source === "selected-panel-lock");
  check(
    "stored lock round-trips selection",
    parsed.selection?.receipt_id === "receipt-1"
      && parsed.selection.confirmed_at === "2026-08-26T00:00:00.000Z"
      && parsed.selection.display.map((item) => item.id).join(",")
        === "anthropic/claude-opus-5,openai/gpt-5.6-sol,x-ai/grok-4.6"
      && parsed.selection.display.map((item) => item.effort).join(",") === "low,medium,high",
  );
  check("stored lock isSelectedPanelLock", isSelectedPanelLock(parsed));
  check(
    "stored lock resolved ids are the confirmed slugs",
    parsed.resolved.map((snap) => snap.id).join(",")
      === "anthropic/claude-opus-5,openai/gpt-5.6-sol,x-ai/grok-4.6",
  );
}

{
  // jsonb may arrive as a scalar string (double-encoded legacy). parseLoadedJudgePanel
  // JSON.parse's then parseJudgePanelTrace's the object — same values, no DB.
  const asString = JSON.stringify(validLock());
  const parsed = parseJudgePanelTrace(JSON.parse(asString));
  check(
    "double-encoded lock string still round-trips selection",
    parsed.source === "selected-panel-lock"
      && parsed.selection?.receipt_id === "receipt-1"
      && isSelectedPanelLock(parsed),
  );
}

// ── reconstructed fallback is not a lock ──────────────────────────────────────
{
  const reconstructed = reconstructedFallback(["grok", "gpt", "deepseek"]);
  check("reconstructed fallback isSelectedPanelLock is false", isSelectedPanelLock(reconstructed) === false);
  const parsed = parseJudgePanelTrace(reconstructed);
  check(
    "parseJudgePanelTrace keeps reconstructed source (not a lock)",
    parsed.source === "reconstructed-from-engine-config"
      && parsed.selection === undefined
      && isSelectedPanelLock(parsed) === false,
  );
  check(
    "reconstructed DEFAULT_PANEL ids cannot satisfy lock",
    parsed.resolved.map((snap) => snap.id).join(",") === "grok,gpt,deepseek",
  );
}

{
  const reconstructedWithSelection = {
    ...reconstructedFallback(["grok", "gpt", "deepseek"]),
    selection: {
      receipt_id: "should-not-promote",
      confirmed_at: "2026-08-26T00:00:00.000Z",
      display: LOCK_DISPLAY,
    },
  };
  const parsed = parseJudgePanelTrace(reconstructedWithSelection);
  check(
    "a selection bag on reconstructed does not become a lock",
    parsed.source === "reconstructed-from-engine-config"
      && parsed.selection === undefined
      && isSelectedPanelLock(parsed) === false,
  );
}

// ── lock-shaped garbage throws rather than recorded-at-grade ──────────────────
{
  let coerced = false;
  const err = throws(() => {
    const parsed = parseJudgePanelTrace(validLock({ resolved: null }));
    coerced = parsed.source === "recorded-at-grade";
    return parsed;
  });
  check(
    "lock-shaped garbage throws rather than recorded-at-grade",
    err !== null && coerced === false,
    err ?? "parsed without throw",
  );
}

{
  let coerced = false;
  const err = throws(() => {
    const parsed = parseJudgePanelTrace(validLock({
      selection: {
        receipt_id: "receipt-1",
        confirmed_at: "2026-08-26T00:00:00.000Z",
        display: [],
      },
    }));
    coerced = parsed.source === "recorded-at-grade" || isSelectedPanelLock(parsed);
    return parsed;
  });
  check(
    "lock with empty display throws (not reconstructed, not recorded-at-grade)",
    err !== null && coerced === false,
    err ?? "parsed without throw",
  );
}

{
  const mystery = {
    source: "mystery-source",
    resolved: snapshotPanel(DEFAULT_PANEL),
    ran: ["grok", "gpt", "deepseek"],
    failed: [],
  };
  let coerced = false;
  const err = throws(() => {
    const parsed = parseJudgePanelTrace(mystery);
    coerced = parsed.source === "recorded-at-grade";
    return parsed;
  });
  check(
    "unknown source is not coerced to recorded-at-grade",
    err !== null && coerced === false,
    err ?? "parsed without throw",
  );
}

{
  const recorded = parseJudgePanelTrace({
    source: "recorded-at-grade",
    resolved: snapshotPanel(DEFAULT_PANEL),
    ran: ["grok", "gpt", "deepseek"],
    failed: [],
    selection: {
      receipt_id: "should-not-copy",
      confirmed_at: "2026-08-26T00:00:00.000Z",
      display: LOCK_DISPLAY,
    },
  });
  check(
    "recorded-at-grade does not copy selection and is not a lock",
    recorded.source === "recorded-at-grade"
      && recorded.selection === undefined
      && isSelectedPanelLock(recorded) === false,
  );
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${total - failures}/${total}`);
process.exit(failures === 0 ? 0 : 1);
