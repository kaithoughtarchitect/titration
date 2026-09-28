// Titration MCP — selected-panel-lock parse (no network, no DB, no model — $0).
// Pins throwing parseSelectedPanelLock (never DEFAULT_PANEL substitute), curated
// family uniqueness, jsonb parseJudgePanelTrace source union, and legacy panel identity.
// Mirrors referee-catalog-core.test.ts (check/total/failures + process.exit).
// Run: npx tsx lib/__tests__/judge-selected-panel-lock.test.ts

import {
  DEFAULT_PANEL,
  isSelectedPanelLock,
  parseJudgePanelTrace,
  parseSelectedPanelLock,
  snapshotJudge,
  snapshotPanel,
  type JudgeSpec,
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

const reconstructed = {
  source: "reconstructed-from-engine-config" as const,
  resolved: snapshotPanel(DEFAULT_PANEL),
  ran: DEFAULT_PANEL.map((judge) => judge.id),
  failed: [] as { id: string; error: string; count?: number }[],
};

// ── DEFAULT_PANEL identity (legacy regime) ──────────────────────
check(
  "DEFAULT_PANEL is still grok/gpt/deepseek",
  DEFAULT_PANEL.map((judge) => judge.id).join(",") === "grok,gpt,deepseek",
);
check(
  "DEFAULT_PANEL models stay grok-4.3 / gpt-5.5 / deepseek-v4-pro",
  DEFAULT_PANEL[0]?.model === "x-ai/grok-4.3"
    && DEFAULT_PANEL[1]?.model === "openai/gpt-5.5"
    && DEFAULT_PANEL[2]?.model === "deepseek/deepseek-v4-pro",
);
check(
  // DEFAULT_PANEL's family values are curated catalog
  // families (grok -> x-ai, gpt -> openai, deepseek -> deepseek) so the
  // distinct-family gate reads real vendor identity off the default panel too.
  "DEFAULT_PANEL families are curated (x-ai/openai/deepseek)",
  DEFAULT_PANEL[0]?.family === "x-ai"
    && DEFAULT_PANEL[1]?.family === "openai"
    && DEFAULT_PANEL[2]?.family === "deepseek",
);

const defaultSnaps = snapshotPanel(DEFAULT_PANEL);
check(
  "snapshotPanel(DEFAULT_PANEL) keeps grok/gpt/deepseek ids",
  defaultSnaps.map((snap) => snap.id).join(",") === "grok,gpt,deepseek",
);
check(
  "snapshotJudge preserves optional effort (gpt high, grok null)",
  snapshotJudge(DEFAULT_PANEL[1]!).effort === "high"
    && snapshotJudge(DEFAULT_PANEL[0]!).effort === null,
);

const selectedSpec: JudgeSpec = {
  id: "openai/gpt-5.6-sol",
  family: "openai",
  door: "openrouter",
  model: "openai/gpt-5.6-sol",
  effort: "medium",
};
const selectedSnap = snapshotJudge(selectedSpec);
check(
  "snapshotJudge preserves selected-panel slug id + family + effort",
  selectedSnap.id === "openai/gpt-5.6-sol"
    && selectedSnap.family === "openai"
    && selectedSnap.model === "openai/gpt-5.6-sol"
    && selectedSnap.door === "openrouter"
    && selectedSnap.effort === "medium",
);

// ── valid lock ────────────────────────────────────────────────────────────────
const parsedLock = parseSelectedPanelLock(validLock());
check("valid lock source is selected-panel-lock", parsedLock.source === "selected-panel-lock");
check(
  "valid lock returns slug ids",
  parsedLock.resolved.map((snap) => snap.id).join(",")
    === "anthropic/claude-opus-5,openai/gpt-5.6-sol,x-ai/grok-4.6",
);
check(
  "valid lock vendors are curated families",
  parsedLock.resolved.map((snap) => snap.family).join(",") === "anthropic,openai,x-ai",
);
check(
  "valid lock path is openrouter",
  parsedLock.resolved.every((snap) => snap.door === "openrouter"),
);
check(
  "valid lock model equals slug id",
  parsedLock.resolved.every((snap) => snap.model === snap.id),
);
check(
  "valid lock effort is confirmed L/M/H",
  parsedLock.resolved.map((snap) => snap.effort).join(",") === "low,medium,high",
);
check(
  "valid lock copies selection",
  parsedLock.selection.receipt_id === "receipt-1"
    && parsedLock.selection.confirmed_at === "2026-08-26T00:00:00.000Z"
    && parsedLock.selection.display.length === 3,
);
check("valid lock isSelectedPanelLock", isSelectedPanelLock(parsedLock));
check(
  "valid lock ids are not grok/gpt/deepseek",
  parsedLock.resolved.every((snap) => snap.id !== "grok" && snap.id !== "gpt" && snap.id !== "deepseek"),
);

const lockTrace = parseJudgePanelTrace(validLock());
check(
  "parseJudgePanelTrace copies selection iff lock",
  lockTrace.source === "selected-panel-lock"
    && lockTrace.selection?.receipt_id === "receipt-1"
    && lockTrace.resolved.length === 3,
);

// ── throws: lock-shaped garbage ───────────────────────────────────────────────
check(
  "parseSelectedPanelLock throws on lock-shaped garbage (resolved not array)",
  throws(() => parseSelectedPanelLock(validLock({ resolved: "nope" }))) !== null,
);
check(
  "parseSelectedPanelLock throws on lock-shaped garbage (display empty)",
  throws(() => parseSelectedPanelLock(validLock({
    selection: {
      receipt_id: "receipt-1",
      confirmed_at: "2026-08-26T00:00:00.000Z",
      display: [],
    },
  }))) !== null,
);
check(
  "parseJudgePanelTrace fail-loud on lock-shaped garbage",
  throws(() => parseJudgePanelTrace(validLock({ resolved: null }))) !== null,
);
check(
  "lock-shaped DEFAULT_PANEL identity throws (no grok/gpt/deepseek mapping)",
  throws(() => parseSelectedPanelLock({
    source: "selected-panel-lock",
    resolved: snapshotPanel(DEFAULT_PANEL),
    ran: ["grok", "gpt", "deepseek"],
    failed: [],
    selection: {
      receipt_id: "receipt-1",
      confirmed_at: "2026-08-26T00:00:00.000Z",
      display: DEFAULT_PANEL.map((judge) => ({
        id: judge.id,
        family: judge.family,
        effort: "high",
      })),
    },
  })) !== null,
);

// ── throws: source-lock with <3 ───────────────────────────────────────────────
{
  const two = LOCK_RESOLVED.slice(0, 2);
  const err = throws(() => parseSelectedPanelLock(validLock({
    resolved: two,
    ran: two.map((item) => item.id),
    selection: {
      receipt_id: "receipt-1",
      confirmed_at: "2026-08-26T00:00:00.000Z",
      display: LOCK_DISPLAY.slice(0, 2),
    },
  })));
  check("source-lock with <3 resolved throws", err !== null, err ?? "no throw");
}

// ── throws: duplicate family (curated field, not vendor-string distinctness) ──
{
  const dupResolved = [
    { ...LOCK_RESOLVED[0] },
    { ...LOCK_RESOLVED[1] },
    {
      id: "openai/gpt-5.6-luna",
      family: "openai",
      door: "openrouter" as const,
      model: "openai/gpt-5.6-luna",
      effort: "high" as const,
    },
  ];
  const dupDisplay = [
    { ...LOCK_DISPLAY[0] },
    { ...LOCK_DISPLAY[1] },
    { id: "openai/gpt-5.6-luna", family: "openai", effort: "high" as const },
  ];
  const err = throws(() => parseSelectedPanelLock(validLock({
    resolved: dupResolved,
    ran: dupResolved.map((item) => item.id),
    selection: {
      receipt_id: "receipt-1",
      confirmed_at: "2026-08-26T00:00:00.000Z",
      display: dupDisplay,
    },
  })));
  check(
    "duplicate curated family throws (openai sol + luna)",
    err !== null && (err.includes("family") || err.includes("distinct")),
    err ?? "no throw",
  );
}

check(
  "distinct free-string vendors that are not catalog families throw",
  throws(() => parseSelectedPanelLock(validLock({
    resolved: [
      { id: "anthropic/claude-opus-5", family: "Anthropic", door: "openrouter", model: "anthropic/claude-opus-5", effort: "low" },
      { id: "openai/gpt-5.6-sol", family: "OpenAI", door: "openrouter", model: "openai/gpt-5.6-sol", effort: "medium" },
      { id: "x-ai/grok-4.6", family: "xAI", door: "openrouter", model: "x-ai/grok-4.6", effort: "high" },
    ],
  }))) !== null,
);

// ── throws: missing selection ─────────────────────────────────────────────────
{
  const missing = validLock();
  delete missing.selection;
  const err = throws(() => parseSelectedPanelLock(missing));
  check("missing selection throws", err !== null && err.includes("selection"), err ?? "no throw");
}

check(
  "source-lock with selection null throws",
  throws(() => parseSelectedPanelLock(validLock({ selection: null }))) !== null,
);

// ── reconstructed cannot satisfy lock ─────────────────────────────────────────
check("reconstructed isSelectedPanelLock is false", isSelectedPanelLock(reconstructed) === false);
check(
  "parseSelectedPanelLock throws on reconstructed",
  throws(() => parseSelectedPanelLock(reconstructed)) !== null,
);
const parsedReconstructed = parseJudgePanelTrace(reconstructed);
check(
  "parseJudgePanelTrace keeps reconstructed source (not a lock)",
  parsedReconstructed.source === "reconstructed-from-engine-config"
    && parsedReconstructed.selection === undefined,
);
check(
  "reconstructed DEFAULT_PANEL ids cannot satisfy lock",
  parsedReconstructed.resolved.map((snap) => snap.id).join(",") === "grok,gpt,deepseek"
    && isSelectedPanelLock(parsedReconstructed) === false,
);

// ── unknown source is not coerced to recorded-at-grade ────────────────────────
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
    "recorded-at-grade does not copy selection",
    recorded.source === "recorded-at-grade" && recorded.selection === undefined,
  );
}

check(
  "resolved ids that do not match display picks throw",
  throws(() => parseSelectedPanelLock(validLock({
    resolved: [
      { ...LOCK_RESOLVED[0] },
      { ...LOCK_RESOLVED[1] },
      {
        id: "moonshotai/kimi-k3",
        family: "moonshotai",
        door: "openrouter",
        model: "moonshotai/kimi-k3",
        effort: "high",
      },
    ],
  }))) !== null,
);

// The lock accepts all four judge
// doors, never just openrouter — a roster row can be a CLI door (claude/codex/
// grok) as well as an OpenRouter slug.
check(
  "codex (a CLI door) on a lock parses — door widening no longer restricted to openrouter",
  (() => {
    const parsed = parseSelectedPanelLock(validLock({
      resolved: [
        { ...LOCK_RESOLVED[0] },
        { ...LOCK_RESOLVED[1], door: "codex" },
        { ...LOCK_RESOLVED[2] },
      ],
    }));
    return parsed.resolved[1]?.door === "codex";
  })(),
);
check(
  "an illegal (non-judge-door) door value on a lock still throws",
  throws(() => parseSelectedPanelLock(validLock({
    resolved: [
      { ...LOCK_RESOLVED[0] },
      { ...LOCK_RESOLVED[1], door: "smtp" },
      { ...LOCK_RESOLVED[2] },
    ],
  }))) !== null,
);

// ── acceptance: a lock built entirely from CLI doors (claude/codex/grok),
// non-catalog ids, model !== id ─────────────────────────────────────────────────
{
  const cliResolved = [
    { id: "claude", family: "anthropic", door: "claude" as const, model: "claude-opus-5", effort: "high" as const },
    { id: "codex", family: "openai", door: "codex" as const, model: "gpt-6-astra", effort: "medium" as const },
    { id: "grok", family: "x-ai", door: "grok" as const, model: "grok-4.6", effort: "low" as const },
  ];
  const cliDisplay = [
    { id: "claude", family: "anthropic" as const, effort: "high" as const },
    { id: "codex", family: "openai" as const, effort: "medium" as const },
    { id: "grok", family: "x-ai" as const, effort: "low" as const },
  ];
  const cliLock = {
    source: "selected-panel-lock" as const,
    resolved: cliResolved,
    ran: cliResolved.map((item) => item.id),
    failed: [] as { id: string; error: string; count?: number }[],
    selection: {
      receipt_id: "env",
      confirmed_at: "2026-09-26T00:00:00.000Z",
      player_family: null,
      display: cliDisplay,
    },
  };
  const parsedCli = parseSelectedPanelLock(cliLock);
  check(
    "a lock with claude/codex/grok CLI doors parses (non-catalog ids, model !== id)",
    parsedCli.resolved.map((snap) => `${snap.id}:${snap.door}:${snap.model}`).join(",")
      === "claude:claude:claude-opus-5,codex:codex:gpt-6-astra,grok:grok:grok-4.6"
      && parsedCli.resolved.map((snap) => snap.family).join(",") === "anthropic,openai,x-ai",
    JSON.stringify(parsedCli.resolved),
  );
  check(
    "the env lock's selection.player_family round-trips (null when no Player was named)",
    parsedCli.selection.player_family === null && parsedCli.selection.receipt_id === "env",
  );

  // A lock with only 2 distinct families among CLI doors is refused.
  const twoFamilyLock = {
    ...cliLock,
    resolved: [cliResolved[0]!, { ...cliResolved[1]!, family: "anthropic" }, cliResolved[2]!],
    selection: {
      ...cliLock.selection,
      display: [cliDisplay[0]!, { ...cliDisplay[1]!, family: "anthropic" as const }, cliDisplay[2]!],
    },
  };
  check(
    "a lock with only 2 distinct families among CLI doors is refused",
    throws(() => parseSelectedPanelLock(twoFamilyLock)) !== null,
  );
}

// ── selection.player_family round-trips when a Player WAS named ────────
check(
  "a lock's selection.player_family round-trips a named Player family",
  parseSelectedPanelLock(validLock({
    selection: {
      receipt_id: "receipt-1",
      confirmed_at: "2026-08-26T00:00:00.000Z",
      player_family: "openai",
      display: LOCK_DISPLAY.map((item) => ({ ...item })),
    },
  })).selection.player_family === "openai",
);
check(
  "a non-curated player_family on a lock throws",
  throws(() => parseSelectedPanelLock(validLock({
    selection: {
      receipt_id: "receipt-1",
      confirmed_at: "2026-08-26T00:00:00.000Z",
      player_family: "not-a-family",
      display: LOCK_DISPLAY.map((item) => ({ ...item })),
    },
  }))) !== null,
);

check(
  "null effort on a lock throws",
  throws(() => parseSelectedPanelLock(validLock({
    resolved: [
      { ...LOCK_RESOLVED[0] },
      { ...LOCK_RESOLVED[1], effort: null },
      { ...LOCK_RESOLVED[2] },
    ],
  }))) !== null,
);

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${total - failures}/${total}`);
process.exit(failures === 0 ? 0 : 1);
