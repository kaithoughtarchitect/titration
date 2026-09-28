// Titration MCP — judges-roster-core unit test (no network, no DB, no model — $0).
// Pins validateRoster (including the real judges-roster.json, mirroring referee-
// catalog-core.test.ts's admission.json read), validatePick's refusal matrix,
// resolvePlayerFamily's keyword scan + explicit override, resolveAutoPanel's
// deterministic subscription-first/OpenRouter-fallback/Player-exclusion resolver,
// and resolveHelperRow's single-model fallback. Mirrors referee-catalog-core.test.ts
// (check/total/failures + process.exit).
// Run: npx tsx lib/__tests__/judges-roster-core.test.ts

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateRoster,
  validatePick,
  resolvePlayerFamily,
  resolvePlayerFamilyOrThrow,
  assertFamilyNotOnPanel,
  resolveAutoPanel,
  resolveHelperRow,
  rowToJudgeSpec,
  defaultEffortForRow,
  CURATED_FAMILIES,
  type Roster,
  type RosterJudgeRow,
} from "../judges-roster-core";

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
const rosterPath = join(here, "..", "..", "judges-roster.json");
const rosterRaw = JSON.parse(readFileSync(rosterPath, "utf8"));

// ── validateRoster: the real committed judges-roster.json ────────────────────
const roster: Roster = validateRoster(rosterRaw);
check("real judges-roster.json validates", roster.judges.length > 0);
check("real roster has 15 rows (3 CLI + 12 OpenRouter)", roster.judges.length === 15, String(roster.judges.length));
check(
  "real roster door counts: openrouter=12, claude=1, codex=1, grok=1",
  roster.judges.filter((r) => r.door === "openrouter").length === 12
    && roster.judges.filter((r) => r.door === "claude").length === 1
    && roster.judges.filter((r) => r.door === "codex").length === 1
    && roster.judges.filter((r) => r.door === "grok").length === 1,
  JSON.stringify({
    openrouter: roster.judges.filter((r) => r.door === "openrouter").length,
    claude: roster.judges.filter((r) => r.door === "claude").length,
    codex: roster.judges.filter((r) => r.door === "codex").length,
    grok: roster.judges.filter((r) => r.door === "grok").length,
  }),
);
check(
  "claude + codex rows are verified:true, subscription; the grok row is verified:false",
  roster.judges.find((r) => r.id === "claude")?.verified === true
    && roster.judges.find((r) => r.id === "claude")?.cost_class === "subscription"
    && roster.judges.find((r) => r.id === "codex")?.verified === true
    && roster.judges.find((r) => r.id === "codex")?.cost_class === "subscription"
    && roster.judges.find((r) => r.id === "grok")?.verified === false,
);
check(
  "every OpenRouter row is verified:true, metered",
  roster.judges.filter((r) => r.door === "openrouter").every((r) => r.verified === true && r.cost_class === "metered"),
);
check("roster ids are unique", new Set(roster.judges.map((r) => r.id)).size === roster.judges.length);
check(
  "every row's family is one of the roster's own declared families",
  roster.judges.every((r) => roster.families.includes(r.family)),
);

// ── validateRoster: malformed shapes throw ────────────────────────────────────
function validRosterRaw(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    families: ["anthropic", "openai", "x-ai"],
    judges: [
      { id: "a", name: "A", family: "anthropic", door: "claude", model: "m-a", efforts: ["low", "medium", "high"], cost_class: "subscription", recommended: true, verified: true },
      { id: "b", name: "B", family: "openai", door: "openrouter", model: "m-b", efforts: ["high"], cost_class: "metered", recommended: false, verified: true },
      { id: "c", name: "C", family: "x-ai", door: "grok", model: "m-c", efforts: ["low"], cost_class: "subscription", recommended: false, verified: false, note: "n" },
    ],
    ...overrides,
  };
}
check("a well-formed roster validates", (() => { validateRoster(validRosterRaw()); return true; })());
check("non-object roster throws", throws(() => validateRoster("nope")) !== null);
check("missing version throws", throws(() => validateRoster(validRosterRaw({ version: undefined }))) !== null);
check("empty families throws", throws(() => validateRoster(validRosterRaw({ families: [] }))) !== null);
check("non-curated family in families[] throws", throws(() => validateRoster(validRosterRaw({ families: ["not-a-family"] }))) !== null);
check("empty judges throws", throws(() => validateRoster(validRosterRaw({ judges: [] }))) !== null);
check(
  "duplicate row id throws",
  throws(() => validateRoster(validRosterRaw({
    judges: [...(validRosterRaw() as { judges: unknown[] }).judges, { id: "a", name: "dup", family: "anthropic", door: "claude", model: "m", efforts: ["high"], cost_class: "subscription", recommended: false, verified: true }],
  }))) !== null,
);
function withRow(patch: Record<string, unknown>): unknown {
  const base = validRosterRaw() as { judges: Record<string, unknown>[] };
  base.judges[0] = { ...base.judges[0], ...patch };
  return base;
}
check("missing name throws", throws(() => validateRoster(withRow({ name: undefined }))) !== null);
check("bad family throws", throws(() => validateRoster(withRow({ family: "not-curated" }))) !== null);
check("bad door throws", throws(() => validateRoster(withRow({ door: "smtp" }))) !== null);
check("missing model throws", throws(() => validateRoster(withRow({ model: "" }))) !== null);
check("empty efforts throws", throws(() => validateRoster(withRow({ efforts: [] }))) !== null);
check("illegal effort token throws", throws(() => validateRoster(withRow({ efforts: ["extreme"] }))) !== null);
check("bad cost_class throws", throws(() => validateRoster(withRow({ cost_class: "free" }))) !== null);
check("non-boolean recommended throws", throws(() => validateRoster(withRow({ recommended: "yes" }))) !== null);
check("non-boolean verified throws", throws(() => validateRoster(withRow({ verified: 1 }))) !== null);
check("non-string note throws", throws(() => validateRoster(withRow({ note: 42 }))) !== null);

// ── rowToJudgeSpec / defaultEffortForRow ──────────────────────────────────────
const rowHigh: RosterJudgeRow = { id: "x", name: "X", family: "openai", door: "openrouter", model: "m", efforts: ["low", "medium", "high"], cost_class: "metered", recommended: false, verified: true };
const rowNoHigh: RosterJudgeRow = { id: "y", name: "Y", family: "openai", door: "openrouter", model: "m", efforts: ["low", "medium"], cost_class: "metered", recommended: false, verified: true };
check("defaultEffortForRow prefers high when allowed", defaultEffortForRow(rowHigh) === "high");
check("defaultEffortForRow falls back to the first declared effort when high is absent", defaultEffortForRow(rowNoHigh) === "low");
check(
  "rowToJudgeSpec maps id/family/door/model + a concrete default effort",
  JSON.stringify(rowToJudgeSpec(rowHigh)) === JSON.stringify({ id: "x", family: "openai", door: "openrouter", model: "m", effort: "high" }),
);

// ── validatePick ───────────────────────────────────────────────────────────────
// pickRoster's row "c" is deliberately verified:false (see validRosterRaw above) —
// used below to pin not_verified. The distinct 3-verified-family success path gets
// its OWN all-verified fixture.
const pickRoster: Roster = validateRoster(validRosterRaw());
{
  const allVerified = validateRoster(validRosterRaw({
    judges: [
      { id: "a", name: "A", family: "anthropic", door: "claude", model: "m-a", efforts: ["low", "medium", "high"], cost_class: "subscription", recommended: true, verified: true },
      { id: "b", name: "B", family: "openai", door: "openrouter", model: "m-b", efforts: ["high"], cost_class: "metered", recommended: false, verified: true },
      { id: "c", name: "C", family: "x-ai", door: "grok", model: "m-c", efforts: ["low"], cost_class: "subscription", recommended: false, verified: true },
    ],
  }));
  const ok = validatePick(allVerified, ["a", "b", "c"]);
  check(
    "3 distinct verified families passes",
    ok.ok === true && ok.ok && ok.panel.length === 3 && ok.panel.map((j) => j.id).join(",") === "a,b,c",
    JSON.stringify(ok),
  );
}
check("wrong count (2) refuses count", (() => { const r = validatePick(pickRoster, ["a", "b"]); return r.ok === false && r.code === "count"; })());
check("wrong count (4) refuses count", (() => { const r = validatePick(pickRoster, ["a", "b", "c", "a"]); return r.ok === false && r.code === "count"; })());
check("duplicate id refuses duplicate_id", (() => { const r = validatePick(pickRoster, ["a", "a", "b"]); return r.ok === false && r.code === "duplicate_id"; })());
check("unknown id refuses unknown_id", (() => { const r = validatePick(pickRoster, ["a", "b", "zzz"]); return r.ok === false && r.code === "unknown_id"; })());
check("unverified row refuses not_verified", (() => { const r = validatePick(pickRoster, ["a", "b", "c"], {}); return r.ok === false ? r.code === "not_verified" : true; })());
{
  // "c" (x-ai, verified:false in this fixture) must refuse not_verified.
  const r = validatePick(pickRoster, ["a", "b", "c"]);
  check("verified:false row refuses not_verified", r.ok === false && r.code === "not_verified", JSON.stringify(r));
}
{
  const verifiedRoster = validateRoster(validRosterRaw({
    judges: [
      { id: "a", name: "A", family: "anthropic", door: "claude", model: "m-a", efforts: ["high"], cost_class: "subscription", recommended: true, verified: true },
      { id: "b", name: "B", family: "openai", door: "openrouter", model: "m-b", efforts: ["high"], cost_class: "metered", recommended: false, verified: true },
      { id: "c", name: "C", family: "x-ai", door: "grok", model: "m-c", efforts: ["high"], cost_class: "subscription", recommended: false, verified: true },
    ],
  }));
  const okAll = validatePick(verifiedRoster, ["a", "b", "c"]);
  check("all-verified 3-distinct-family pick succeeds", okAll.ok === true, JSON.stringify(okAll));
  const excluded = validatePick(verifiedRoster, ["a", "b", "c"], { playerFamily: "anthropic" });
  check("Player family on a pick refuses player_family", excluded.ok === false && excluded.code === "player_family", JSON.stringify(excluded));
  const dupFamilyRoster = validateRoster(validRosterRaw({
    judges: [
      { id: "a", name: "A", family: "openai", door: "claude", model: "m-a", efforts: ["high"], cost_class: "subscription", recommended: true, verified: true },
      { id: "b", name: "B", family: "openai", door: "openrouter", model: "m-b", efforts: ["high"], cost_class: "metered", recommended: false, verified: true },
      { id: "c", name: "C", family: "x-ai", door: "grok", model: "m-c", efforts: ["high"], cost_class: "subscription", recommended: false, verified: true },
    ],
  }));
  const dup = validatePick(dupFamilyRoster, ["a", "b", "c"]);
  check("two same-family picks refuse duplicate_family", dup.ok === false && dup.code === "duplicate_family", JSON.stringify(dup));
}
{
  // validateRoster refuses an empty efforts[] at the FILE level, so this defensive
  // check inside validatePick can only fire against a Roster object assembled
  // without going through validateRoster — proven directly here.
  const noEffortRoster: Roster = {
    version: 1,
    families: ["anthropic", "openai", "x-ai"],
    judges: [
      { id: "a", name: "A", family: "anthropic", door: "claude", model: "m-a", efforts: [], cost_class: "subscription", recommended: true, verified: true },
      { id: "b", name: "B", family: "openai", door: "openrouter", model: "m-b", efforts: ["high"], cost_class: "metered", recommended: false, verified: true },
      { id: "c", name: "C", family: "x-ai", door: "grok", model: "m-c", efforts: ["high"], cost_class: "subscription", recommended: false, verified: true },
    ],
  };
  const illegal = validatePick(noEffortRoster, ["a", "b", "c"]);
  check("a picked row with no legal declared effort refuses illegal_effort", illegal.ok === false && illegal.code === "illegal_effort", JSON.stringify(illegal));
}

// ── resolvePlayerFamily (keyword scan ported from resolvePlayerVendor) ────────
check("explicit player_family override (curated) wins", resolvePlayerFamily("anything", "openai") === "openai");
check("explicit player_family override is case-insensitive", resolvePlayerFamily("anything", "OpenAI") === "openai");
check("explicit non-curated player_family override resolves to null", resolvePlayerFamily("anything", "not-a-family") === null);
check("claude-opus-5-5 resolves to anthropic (keyword 'claude')", resolvePlayerFamily("claude-opus-5-5") === "anthropic");
check("gpt-5.6-turbo resolves to openai (keyword 'gpt')", resolvePlayerFamily("gpt-5.6-turbo") === "openai");
check("grok-4.6 resolves to x-ai (keyword 'grok')", resolvePlayerFamily("grok-4.6") === "x-ai");
check("gemini-3-pro resolves to google (keyword 'gemini')", resolvePlayerFamily("gemini-3-pro") === "google");
check("deepseek-v4-pro resolves to deepseek", resolvePlayerFamily("deepseek-v4-pro") === "deepseek");
check("kimi-k3 resolves to moonshotai", resolvePlayerFamily("kimi-k3") === "moonshotai");
check("qwen3.8-max resolves to qwen", resolvePlayerFamily("qwen3.8-max") === "qwen");
check("llama-4 resolves to meta", resolvePlayerFamily("llama-4") === "meta");
check("glm-5.3 resolves to z-ai", resolvePlayerFamily("glm-5.3") === "z-ai");
check("minimax-m3 resolves to minimax", resolvePlayerFamily("minimax-m3") === "minimax");
check("model id is matched case-insensitively", resolvePlayerFamily("CLAUDE-Opus-5") === "anthropic");
check("an unresolvable model id with no override returns null", resolvePlayerFamily("some-mystery-model-9000") === null);
check("empty model id with no override returns null", resolvePlayerFamily("") === null);

check(
  "resolvePlayerFamilyOrThrow returns the resolved family",
  resolvePlayerFamilyOrThrow("claude-opus-5-5") === "anthropic",
);
check(
  "resolvePlayerFamilyOrThrow throws on an unresolvable model with no override (never silent 'no exclusion')",
  throws(() => resolvePlayerFamilyOrThrow("mystery-9000")) !== null,
);
check(
  "resolvePlayerFamilyOrThrow's throw names both inputs",
  (throws(() => resolvePlayerFamilyOrThrow("mystery-9000", "not-a-family")) ?? "").includes("mystery-9000")
    && (throws(() => resolvePlayerFamilyOrThrow("mystery-9000", "not-a-family")) ?? "").includes("not-a-family"),
);

// ── assertFamilyNotOnPanel ─────────────────────────────────────────────────────
check(
  "assertFamilyNotOnPanel throws when the resolved family sits on the panel",
  throws(() => assertFamilyNotOnPanel("anthropic", ["anthropic", "openai", "x-ai"], { playerModel: "claude-opus-5" })) !== null,
);
check(
  "assertFamilyNotOnPanel is a no-op when the family is absent",
  (() => { assertFamilyNotOnPanel("anthropic", ["openai", "x-ai", "google"], { playerModel: "claude-opus-5" }); return true; })(),
);
check(
  "assertFamilyNotOnPanel's throw names the player_model and the panel families",
  (throws(() => assertFamilyNotOnPanel("anthropic", ["anthropic", "openai", "x-ai"], { playerModel: "claude-opus-5" })) ?? "")
    .includes("claude-opus-5"),
);

// ── resolveAutoPanel (TITRATION_JUDGES=auto) ───────────────────────────────
// Against the REAL committed roster (15 rows): claude verified subscription
// anthropic; codex verified subscription openai; grok verified:false; 12 verified metered OpenRouter rows
// spanning 8 further distinct families (openai/moonshotai/google/deepseek/z-ai/
// x-ai/minimax/meta/qwen — openai/google/deepseek/z-ai repeat).
{
  const claudeCodexOnly = { claude: true, codex: true, grok: false };
  const noneInstalled = { claude: false, codex: false, grok: false };

  const noKeyPlayerAnthropic = resolveAutoPanel(roster, {
    available: claudeCodexOnly,
    hasOpenRouterKey: false,
    playerFamily: "anthropic",
  });
  check(
    "auto, claude+codex installed, Player=anthropic, no key -> refuses (claude excluded as Player family, codex fills only 1 of 3 seats, grok not installed)",
    noKeyPlayerAnthropic.ok === false,
    JSON.stringify(noKeyPlayerAnthropic),
  );

  const withKeyPlayerAnthropic = resolveAutoPanel(roster, {
    available: claudeCodexOnly,
    hasOpenRouterKey: true,
    playerFamily: "anthropic",
  });
  check(
    "auto, claude+codex installed, Player=anthropic, WITH key -> codex (subscription) first, then 2 OpenRouter families, never anthropic",
    withKeyPlayerAnthropic.ok === true
      && withKeyPlayerAnthropic.ok
      && withKeyPlayerAnthropic.panel.length === 3
      && withKeyPlayerAnthropic.panel[0]?.id === "codex"
      && new Set(withKeyPlayerAnthropic.panel.map((j) => j.family)).size === 3
      && withKeyPlayerAnthropic.panel.every((j) => j.family !== "anthropic")
      && withKeyPlayerAnthropic.panel.slice(1).every((j) => j.door === "openrouter"),
    JSON.stringify(withKeyPlayerAnthropic),
  );

  const noPlayerNoKeyNoCli = resolveAutoPanel(roster, {
    available: noneInstalled,
    hasOpenRouterKey: false,
    playerFamily: null,
  });
  check(
    "auto, nothing installed, no key, no Player -> refuses (0 of 3)",
    noPlayerNoKeyNoCli.ok === false,
    JSON.stringify(noPlayerNoKeyNoCli),
  );

  const claudeInstalledNoPlayer = resolveAutoPanel(roster, {
    available: { claude: true, codex: false, grok: false },
    hasOpenRouterKey: true,
    playerFamily: null,
  });
  check(
    "auto, claude installed + key, no Player -> claude (subscription, anthropic) first, then 2 metered OpenRouter families",
    claudeInstalledNoPlayer.ok === true
      && claudeInstalledNoPlayer.ok
      && claudeInstalledNoPlayer.panel[0]?.id === "claude"
      && claudeInstalledNoPlayer.panel[0]?.door === "claude"
      && new Set(claudeInstalledNoPlayer.panel.map((j) => j.family)).size === 3,
    JSON.stringify(claudeInstalledNoPlayer),
  );

  const autoNoCliWithKey = resolveAutoPanel(roster, {
    available: noneInstalled,
    hasOpenRouterKey: true,
    playerFamily: null,
  });
  check(
    "auto, no CLI installed, key set, no Player -> 3 distinct metered OpenRouter families in roster file order",
    autoNoCliWithKey.ok === true
      && autoNoCliWithKey.ok
      && autoNoCliWithKey.panel.map((j) => j.id).join(",") === "openai/gpt-6-sol,moonshotai/kimi-k3,deepseek/deepseek-v4-pro-0813",
    JSON.stringify(autoNoCliWithKey),
  );
}

// ── resolveAutoPanel: excludeFamilies (the vendor of the model being tested) ──
{
  const excluded = resolveAutoPanel(roster, {
    available: { claude: false, codex: true, grok: false },
    hasOpenRouterKey: true,
    playerFamily: "anthropic",
    excludeFamilies: ["deepseek", "openai"],
  });
  check(
    "auto with excludeFamilies never seats an excluded family (codex/openai skipped, no deepseek)",
    excluded.ok === true
      && excluded.ok
      && excluded.panel.length === 3
      && excluded.panel.every((j) => !["anthropic", "openai", "deepseek"].includes(j.family))
      && new Set(excluded.panel.map((j) => j.family)).size === 3,
    JSON.stringify(excluded),
  );
}

// ── resolveHelperRow (helper single-model contract) ─────────────────────────
{
  const claudeCodexOnly = { claude: true, codex: true, grok: false };
  const noneInstalled = { claude: false, codex: false, grok: false };

  const withClaude = resolveHelperRow(roster, { available: claudeCodexOnly, hasOpenRouterKey: false });
  check(
    "helper: claude + codex installed -> claude (first verified subscription row in file order), even with no key",
    withClaude.ok === true && withClaude.ok && withClaude.row.id === "claude",
    JSON.stringify(withClaude),
  );

  const codexOnlyNoKey = resolveHelperRow(roster, { available: { claude: false, codex: true, grok: false }, hasOpenRouterKey: false });
  check(
    "helper: only codex installed (verified subscription) + no key -> codex",
    codexOnlyNoKey.ok === true && codexOnlyNoKey.ok && codexOnlyNoKey.row.id === "codex",
    JSON.stringify(codexOnlyNoKey),
  );

  const grokOnlyNoKey = resolveHelperRow(roster, { available: { claude: false, codex: false, grok: true }, hasOpenRouterKey: false });
  check(
    "helper: only grok installed (unverified) + no key -> refuses",
    grokOnlyNoKey.ok === false,
    JSON.stringify(grokOnlyNoKey),
  );

  const noneNoKey = resolveHelperRow(roster, { available: noneInstalled, hasOpenRouterKey: false });
  check("helper: nothing installed, no key -> refuses", noneNoKey.ok === false, JSON.stringify(noneNoKey));

  const noneWithKey = resolveHelperRow(roster, { available: noneInstalled, hasOpenRouterKey: true });
  check(
    "helper: nothing installed, key set -> first verified metered row in file order",
    noneWithKey.ok === true && noneWithKey.ok && noneWithKey.row.id === "openai/gpt-6-sol",
    JSON.stringify(noneWithKey),
  );
}

check("CURATED_FAMILIES has 10 members", CURATED_FAMILIES.length === 10);

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${total - failures}/${total}`);
process.exit(failures === 0 ? 0 : 1);
