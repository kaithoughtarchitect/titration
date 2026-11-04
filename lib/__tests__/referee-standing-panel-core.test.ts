// Titration MCP — standing referee panel core unit test (no network, no DB — $0).
//
// Pins the standing-panel lifecycle: the picker opt-in parse (bounded, refused
// rather than clamped), the agent's pre-tick suggestion, expiry arithmetic, the
// state order (revoked > exhausted > expired > active), the per-use Player/SUT
// family re-check, and the read-only status view.
// Run: npx tsx lib/__tests__/referee-standing-panel-core.test.ts

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  STANDING_PANEL_DEFAULT_HOURS,
  STANDING_PANEL_DEFAULT_USES,
  STANDING_PANEL_MAX_HOURS,
  STANDING_PANEL_MAX_USES,
  parseStandingPanelRecord,
  parseStandingPanelRequest,
  parseStandingUsesSuggestion,
  planStandingUse,
  standingExpiresAt,
  standingFamilyConflict,
  standingPanelView,
  standingStateAt,
  type StandingPanelRecord,
} from "../referee-standing-panel-core";
import type { ConfirmedPanelSnapshot } from "../referee-panel-ticket-core";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail = ""): void {
  total++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}

const SNAPSHOT: ConfirmedPanelSnapshot = {
  resolved: [
    { id: "claude", family: "anthropic", door: "claude", model: "claude-opus-5", effort: "high" },
    { id: "gemini", family: "google", door: "openrouter", model: "google/gemini-3", effort: "medium" },
    { id: "grok", family: "x-ai", door: "grok", model: "grok-5", effort: "low" },
  ],
  selection: { receipt_id: "ticket-1", confirmed_at: "2026-11-03T10:00:00.000Z", player_family: "openai" },
};

function record(overrides: Partial<StandingPanelRecord> = {}): StandingPanelRecord {
  return {
    id: "standing-1",
    tenant_id: "tenant-1",
    source_ticket_id: "ticket-1",
    confirmation_snapshot: SNAPSHOT,
    sut_family: "deepseek",
    max_uses: 3,
    uses: 0,
    created_at: "2026-11-03T10:00:00.000Z",
    expires_at: "2026-11-03T18:00:00.000Z",
    revoked_at: null,
    last_used_at: null,
    ...overrides,
  };
}
const NOW = "2026-11-03T12:00:00.000Z";

// ── defaults / bounds ─────────────────────────────────────────────────────────
check("defaults are 10 baselines / 8 hours", STANDING_PANEL_DEFAULT_USES === 10 && STANDING_PANEL_DEFAULT_HOURS === 8);
check("ceilings are 20 baselines / 24 hours", STANDING_PANEL_MAX_USES === 20 && STANDING_PANEL_MAX_HOURS === 24);

// ── picker opt-in parse ───────────────────────────────────────────────────────
for (const absent of [undefined, null, false]) {
  const r = parseStandingPanelRequest(absent);
  check(`opt-in ${String(absent)} means no standing panel`, r.ok && r.standing === null);
}
{
  const r = parseStandingPanelRequest({ uses: 7, hours: 8 });
  check("opt-in {7, 8} is accepted as given", r.ok && r.standing?.uses === 7 && r.standing?.hours === 8);
}
for (const bad of [true, "yes", [], { uses: 0, hours: 8 }, { uses: 21, hours: 8 }, { uses: 2.5, hours: 8 }, { uses: 5, hours: 0 }, { uses: 5, hours: 25 }, { uses: 5 }]) {
  check(`opt-in ${JSON.stringify(bad)} is refused, never clamped`, parseStandingPanelRequest(bad).ok === false);
}

// ── agent suggestion ──────────────────────────────────────────────────────────
check("no suggestion leaves the box unticked", parseStandingUsesSuggestion(undefined) === null);
check("suggestion 7 pre-ticks with 7", parseStandingUsesSuggestion(7) === 7);
check("suggestion 0 / 21 / 1.5 / '7' is invalid", [0, 21, 1.5, "7"].every((v) => parseStandingUsesSuggestion(v) === "invalid"));

// ── expiry ────────────────────────────────────────────────────────────────────
check("expires_at = created_at + hours", standingExpiresAt("2026-11-03T10:00:00.000Z", 8) === "2026-11-03T18:00:00.000Z");
let threw = false;
try { standingExpiresAt("2026-11-03T10:00:00.000Z", 25); } catch { threw = true; }
check("expiry beyond 24 hours throws", threw);

// ── state ─────────────────────────────────────────────────────────────────────
check("fresh record is active", standingStateAt(record(), NOW) === "active");
check("past expires_at is expired", standingStateAt(record(), "2026-11-03T18:00:00.000Z") === "expired");
check("uses == max_uses is exhausted", standingStateAt(record({ uses: 3 }), NOW) === "exhausted");
check("revoked wins over every other state", standingStateAt(record({ revoked_at: NOW, uses: 3 }), "2026-11-04T00:00:00.000Z") === "revoked");

// ── per-use family re-check ───────────────────────────────────────────────────
check("no clash for an openai Player and the stored deepseek SUT", standingFamilyConflict(record(), { playerFamily: "openai", sutFamily: null }) === null);
check(
  "a Player whose family sits on the panel clashes",
  standingFamilyConflict(record(), { playerFamily: "anthropic", sutFamily: null })?.reason === "player",
);
check(
  "a call-supplied SUT family on the panel clashes",
  standingFamilyConflict(record(), { playerFamily: "openai", sutFamily: "google" })?.reason === "sut",
);
check(
  "the stored SUT family is checked too (defense in depth)",
  standingFamilyConflict(record({ sut_family: "x-ai" }), { playerFamily: "openai", sutFamily: null })?.judge_id === "grok",
);

// ── planStandingUse ───────────────────────────────────────────────────────────
{
  const plan = planStandingUse(record({ uses: 1 }), { now: NOW, playerFamily: "openai", sutFamily: "deepseek" });
  check("an active, clash-free use increments uses", plan.ok && plan.uses === 2 && plan.used_at === NOW);
}
const refusals: [string, StandingPanelRecord, string | null, string][] = [
  ["revoked", record({ revoked_at: NOW }), "openai", "standing_revoked"],
  ["exhausted", record({ uses: 3 }), "openai", "standing_exhausted"],
  ["expired", record({ expires_at: "2026-11-03T11:00:00.000Z" }), "openai", "standing_expired"],
  ["Player family on panel", record(), "anthropic", "standing_family_conflict"],
];
for (const [name, rec, player, code] of refusals) {
  const plan = planStandingUse(rec, { now: NOW, playerFamily: player, sutFamily: null });
  check(`${name} refuses ${code} and names referee_panel_mint`, !plan.ok && plan.code === code && /referee_panel_mint/.test(plan.message));
}

// ── view + row parse ──────────────────────────────────────────────────────────
{
  const view = standingPanelView(record({ uses: 1 }), NOW);
  check(
    "status view reports state, uses_left, expiry and the panel, never a secret",
    view.state === "active" && view.uses_left === 2 && view.max_uses === 3 && view.panel.length === 3
      && view.confirmed_at === SNAPSHOT.selection.confirmed_at && !JSON.stringify(view).includes("digest"),
  );
}
{
  const parsed = parseStandingPanelRecord({
    ...record(),
    created_at: new Date("2026-11-03T10:00:00.000Z"),
    expires_at: new Date("2026-11-03T18:00:00.000Z"),
    max_uses: 3,
    uses: 0,
  });
  check("row parse accepts Date timestamps from postgres-js", parsed.expires_at === "2026-11-03T18:00:00.000Z");
  let bad = false;
  try { parseStandingPanelRecord({ ...record(), uses: 4 }); } catch { bad = true; }
  check("row parse refuses uses > max_uses", bad);
}

// ── import hygiene (pure core) ────────────────────────────────────────────────
{
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "referee-standing-panel-core.ts"), "utf8");
  const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  check("core imports only the ticket core", imports.every((spec) => spec === "./referee-panel-ticket-core"), imports.join(","));
  check("core has no Date.now / Math.random", !/Date\.now\(|Math\.random\(/.test(src));
}

console.log(`\n${total - failures}/${total} checks passed`);
process.exit(failures ? 1 : 0);
