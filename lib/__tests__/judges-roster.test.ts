// Titration MCP — judges-roster I/O unit test (no network, no real CLI probing,
// no real model call — $0). Pins loadRoster (default path + TITRATION_JUDGES_ROSTER
// override + malformed-file handling), detectCliAvailability's mapping over an
// injected resolveCliDoor, and the two async resolvers (resolveEnvJudgePanel /
// resolveHelperJudgeSpec) end to end, via injected ports so none of it touches the
// real filesystem beyond the roster file itself, real PATH, or a real API key.
// Mirrors lib/__tests__/cli-resolve-core.test.ts's mkdtemp fixture style.
// Run: npx tsx lib/__tests__/judges-roster.test.ts

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliDoor, ResolvedCli } from "../cli-resolve-core";
import { validateRoster, type Roster } from "../judges-roster-core";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail = ""): void {
  total++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}

async function throwsAsync(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e: unknown) {
    return String(e instanceof Error ? e.message : e);
  }
}

const {
  loadRoster,
  detectCliAvailability,
  hasOpenRouterKey,
  resolveEnvJudgePanel,
  resolveHelperJudgeSpec,
} = await import("../judges-roster");

// ── loadRoster: default path resolves the real committed judges-roster.json ───
{
  const roster = await loadRoster();
  check("loadRoster() (default path) resolves the real committed judges-roster.json", roster.judges.length === 15, String(roster.judges.length));
}

// ── loadRoster: TITRATION_JUDGES_ROSTER override ──────────────────────────────
const FIXTURE_ROSTER: unknown = {
  version: 1,
  families: ["anthropic", "openai", "x-ai", "google"],
  judges: [
    { id: "a", name: "A", family: "anthropic", door: "claude", model: "m-a", efforts: ["low", "medium", "high"], cost_class: "subscription", recommended: true, verified: true },
    { id: "b", name: "B", family: "openai", door: "codex", model: "m-b", efforts: ["low", "medium", "high"], cost_class: "subscription", recommended: false, verified: false, note: "unverified" },
    { id: "c", name: "C", family: "x-ai", door: "openrouter", model: "x-ai/m-c", efforts: ["low", "medium", "high"], cost_class: "metered", recommended: false, verified: true },
    { id: "d", name: "D", family: "openai", door: "openrouter", model: "openai/m-d", efforts: ["low", "medium", "high"], cost_class: "metered", recommended: false, verified: true },
    { id: "e", name: "E", family: "google", door: "openrouter", model: "google/m-e", efforts: ["low", "medium", "high"], cost_class: "metered", recommended: false, verified: true },
  ],
};
{
  const dir = await mkdtemp(join(tmpdir(), "titration-judges-roster-test-"));
  const fixturePath = join(dir, "roster.json");
  await writeFile(fixturePath, JSON.stringify(FIXTURE_ROSTER, null, 2), "utf8");
  const prior = process.env.TITRATION_JUDGES_ROSTER;
  try {
    process.env.TITRATION_JUDGES_ROSTER = fixturePath;
    const roster = await loadRoster();
    check("TITRATION_JUDGES_ROSTER overrides the roster path", roster.judges.length === 5, String(roster.judges.length));

    process.env.TITRATION_JUDGES_ROSTER = join(dir, "does-not-exist.json");
    const missingErr = await throwsAsync(() => loadRoster());
    check("an unreadable override path throws, naming the path", missingErr !== null && missingErr.includes("does-not-exist.json"), missingErr ?? "no throw");

    const malformedPath = join(dir, "malformed.json");
    await writeFile(malformedPath, "{not json", "utf8");
    process.env.TITRATION_JUDGES_ROSTER = malformedPath;
    const malformedErr = await throwsAsync(() => loadRoster());
    check("malformed JSON at the override path throws", malformedErr !== null, malformedErr ?? "no throw");

    const invalidShapePath = join(dir, "invalid-shape.json");
    await writeFile(invalidShapePath, JSON.stringify({ version: 1, families: [], judges: [] }), "utf8");
    process.env.TITRATION_JUDGES_ROSTER = invalidShapePath;
    const invalidErr = await throwsAsync(() => loadRoster());
    check("a structurally invalid roster at the override path throws (validateRoster)", invalidErr !== null, invalidErr ?? "no throw");
  } finally {
    process.env.TITRATION_JUDGES_ROSTER = prior;
    await rm(dir, { recursive: true, force: true });
  }
}

// ── detectCliAvailability: injected resolveCliDoor ────────────────────────────
{
  const fakeResolve = async (door: CliDoor): Promise<ResolvedCli | null> =>
    door === "claude" || door === "grok" ? { door, executable: `/bin/${door}`, prefixArgs: [], owner: "npm-verified" } : null;
  const available = await detectCliAvailability(fakeResolve);
  check(
    "detectCliAvailability maps a resolved door to true and null to false",
    available.claude === true && available.grok === true && available.codex === false,
    JSON.stringify(available),
  );
}

// ── hasOpenRouterKey ───────────────────────────────────────────────────────────
{
  const prior = process.env.OPENROUTER_API_KEY;
  try {
    process.env.OPENROUTER_API_KEY = "";
    check("hasOpenRouterKey() is false on an empty string", hasOpenRouterKey() === false);
    delete process.env.OPENROUTER_API_KEY;
    check("hasOpenRouterKey() is false when unset", hasOpenRouterKey() === false);
    process.env.OPENROUTER_API_KEY = "sk-or-v1-fake-test-key";
    check("hasOpenRouterKey() is true when set to a non-empty string", hasOpenRouterKey() === true);
  } finally {
    if (prior === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prior;
  }
}

// ── resolveEnvJudgePanel (fully injected — the acceptance matrix) ─────────
const FIXTURE: Roster = validateRoster(FIXTURE_ROSTER);
function portsFor(available: { claude: boolean; codex: boolean; grok: boolean }, key: boolean) {
  return {
    loadRoster: async () => FIXTURE,
    detectCliAvailability: async () => available,
    hasOpenRouterKey: () => key,
  };
}

{
  const err = await throwsAsync(() => resolveEnvJudgePanel({ judgesEnv: undefined }, portsFor({ claude: false, codex: false, grok: false }, false)));
  check("unset TITRATION_JUDGES refuses naming referee_panel_mint", err !== null && err.includes("referee_panel_mint"), err ?? "no throw");
}
{
  const err = await throwsAsync(() => resolveEnvJudgePanel({ judgesEnv: "   " }, portsFor({ claude: false, codex: false, grok: false }, false)));
  check("a blank TITRATION_JUDGES is treated as unset", err !== null && err.includes("referee_panel_mint"), err ?? "no throw");
}
{
  const panel = await resolveEnvJudgePanel({ judgesEnv: "a,c,d" }, portsFor({ claude: false, codex: false, grok: false }, false));
  check(
    "a comma list of valid, verified, distinct-family roster ids resolves that exact panel",
    panel.map((j) => j.id).join(",") === "a,c,d",
    JSON.stringify(panel),
  );
}
{
  const err = await throwsAsync(() => resolveEnvJudgePanel({ judgesEnv: "a,b,c" }, portsFor({ claude: false, codex: false, grok: false }, false)));
  check(
    "a comma list naming an unverified row (b) refuses with validatePick's message",
    err !== null && err.includes("not verified"),
    err ?? "no throw",
  );
}
{
  const err = await throwsAsync(() => resolveEnvJudgePanel({ judgesEnv: "a,c,zzz" }, portsFor({ claude: false, codex: false, grok: false }, false)));
  check("a comma list naming an unknown id refuses", err !== null, err ?? "no throw");
}

// The task's own acceptance scenario: only claude+codex installed, Player=anthropic.
{
  const noKey = await throwsAsync(() => resolveEnvJudgePanel(
    { judgesEnv: "auto", playerFamily: "anthropic" },
    portsFor({ claude: true, codex: true, grok: false }, false),
  ));
  check(
    "auto, only claude+codex installed, Player=anthropic, NO key -> typed refusal " +
    "(claude excluded as the Player's own family, codex excluded as unverified, grok not installed)",
    noKey !== null && noKey.includes("auto could not resolve a panel"),
    noKey ?? "no throw",
  );

  const withKey = await resolveEnvJudgePanel(
    { judgesEnv: "auto", playerFamily: "anthropic" },
    portsFor({ claude: true, codex: true, grok: false }, true),
  );
  check(
    "auto, only claude+codex installed, Player=anthropic, WITH key -> codex excluded (unverified), " +
    "3 distinct OpenRouter families chosen, never anthropic",
    withKey.length === 3
      && withKey.every((j) => j.door === "openrouter" && j.family !== "anthropic")
      && new Set(withKey.map((j) => j.family)).size === 3,
    JSON.stringify(withKey),
  );
}

// ── resolveHelperJudgeSpec (helper contract) ────────────────────────────────
{
  const spec = await resolveHelperJudgeSpec({ helperModelId: "c" }, portsFor({ claude: false, codex: false, grok: false }, false));
  check("an explicit, known, verified TITRATION_HELPER_MODEL id resolves that row", spec.id === "c", JSON.stringify(spec));
}
{
  const err = await throwsAsync(() => resolveHelperJudgeSpec({ helperModelId: "zzz" }, portsFor({ claude: false, codex: false, grok: false }, false)));
  check("an unknown TITRATION_HELPER_MODEL id throws", err !== null, err ?? "no throw");
}
{
  const err = await throwsAsync(() => resolveHelperJudgeSpec({ helperModelId: "b" }, portsFor({ claude: false, codex: false, grok: false }, false)));
  check("an unverified TITRATION_HELPER_MODEL id throws", err !== null && err.includes("not verified"), err ?? "no throw");
}
{
  const spec = await resolveHelperJudgeSpec({}, portsFor({ claude: true, codex: true, grok: false }, false));
  check(
    "no explicit id, TITRATION_HELPER_MODEL unset -> first available verified door, subscription first (claude, not unverified codex)",
    spec.id === "a" && spec.door === "claude",
    JSON.stringify(spec),
  );
}
{
  const err = await throwsAsync(() => resolveHelperJudgeSpec({}, portsFor({ claude: false, codex: false, grok: false }, false)));
  check("no explicit id, nothing installed, no key -> typed refusal", err !== null, err ?? "no throw");
}
{
  const spec = await resolveHelperJudgeSpec({}, portsFor({ claude: false, codex: false, grok: false }, true));
  check(
    "no explicit id, nothing installed, key set -> first verified metered row",
    spec.id === "c" && spec.door === "openrouter",
    JSON.stringify(spec),
  );
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${total - failures}/${total}`);
process.exit(failures === 0 ? 0 : 1);
