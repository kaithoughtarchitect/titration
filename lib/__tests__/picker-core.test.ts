// Titration MCP — picker-core unit test (no network, no DB, no model — $0).
//
// Pins the confirm-request decision matrix in its EXACT required order
// (415 non-JSON -> 403 foreign Origin -> 400 malformed body -> 403 missing/
// wrong token, constant-time -> 409 already-accepted -> 410 past TTL -> 400 an
// invalid pick, via judges-roster-core's validatePick -> 200 the resolved
// judges), plus buildPickerPageModel's disabled/available/recommended
// computation and the HTML renderer's no-external-fetch / embedded-data shape.
// Run: npx tsx lib/__tests__/picker-core.test.ts

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateRoster, type Roster } from "../judges-roster-core";
import {
  buildAllowedOrigins,
  buildPickerFontCss,
  buildPickerPageModel,
  constantTimeEqual,
  evaluateConfirmRequest,
  evaluateGetRequest,
  isAllowedOrigin,
  isJsonContentType,
  isPastExpiry,
  parseConfirmRequestBody,
  renderExpiredHtml,
  renderPickerHtml,
  resolveConfirmedJudges,
  type PickerPageModel,
} from "../picker-core";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail = ""): void {
  total++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}

const here = dirname(fileURLToPath(import.meta.url));
const rosterPath = join(here, "..", "..", "judges-roster.json");
const roster: Roster = validateRoster(JSON.parse(readFileSync(rosterPath, "utf8")));

const NOW_MS = Date.parse("2026-09-26T00:00:00.000Z");
const EXPIRES_AT = "2026-09-26T00:12:00.000Z"; // NOW_MS + 720s
const TOKEN = "a".repeat(32);
const ALLOWED = buildAllowedOrigins(51773);

const AVAILABLE_NONE = { claude: false, codex: false, grok: false };
const AVAILABLE_CLAUDE_ONLY = { claude: true, codex: false, grok: false };

function baseConfirmInput(overrides: Partial<Parameters<typeof evaluateConfirmRequest>[0]> = {}) {
  return {
    contentType: "application/json",
    origin: ALLOWED[0],
    allowedOrigins: ALLOWED,
    rawBody: { token: TOKEN, judges: [{ id: "x-ai/grok-4.7" }, { id: "openai/gpt-6-sol" }, { id: "google/gemini-3.8-flash" }] },
    bodyParseError: false,
    expectedToken: TOKEN,
    alreadyAccepted: false,
    nowMs: NOW_MS,
    expiresAtIso: EXPIRES_AT,
    roster,
    playerFamily: "anthropic",
    ...overrides,
  };
}

// ── constant-time token compare ───────────────────────────────────────────────
check("constantTimeEqual accepts identical strings", constantTimeEqual(TOKEN, TOKEN));
check("constantTimeEqual rejects a different string", !constantTimeEqual(TOKEN, "b".repeat(32)));
check("constantTimeEqual rejects a different-length string (no throw)", !constantTimeEqual(TOKEN, "short"));
check("constantTimeEqual rejects an empty string against a real token", !constantTimeEqual(TOKEN, ""));

// ── isJsonContentType / isAllowedOrigin / isPastExpiry ────────────────────────
check("isJsonContentType accepts application/json", isJsonContentType("application/json"));
check("isJsonContentType accepts a charset suffix", isJsonContentType("application/json; charset=utf-8"));
check("isJsonContentType rejects text/plain", !isJsonContentType("text/plain"));
check("isJsonContentType rejects undefined", !isJsonContentType(undefined));
check("isAllowedOrigin accepts the server's own 127.0.0.1 origin", isAllowedOrigin(ALLOWED[0], ALLOWED));
check("isAllowedOrigin accepts the server's own localhost origin", isAllowedOrigin(ALLOWED[1], ALLOWED));
check("isAllowedOrigin rejects a foreign origin", !isAllowedOrigin("https://evil.example", ALLOWED));
check("isAllowedOrigin rejects an absent origin", !isAllowedOrigin(null, ALLOWED));
check("isAllowedOrigin rejects an absent origin (undefined)", !isAllowedOrigin(undefined, ALLOWED));
check("isPastExpiry false before expiry", !isPastExpiry(EXPIRES_AT, NOW_MS));
check("isPastExpiry true at exactly expiry", isPastExpiry(EXPIRES_AT, Date.parse(EXPIRES_AT)));
check("isPastExpiry true after expiry", isPastExpiry(EXPIRES_AT, Date.parse(EXPIRES_AT) + 1000));

// ── parseConfirmRequestBody ────────────────────────────────────────────────────
check(
  "parseConfirmRequestBody accepts a well-formed body",
  (() => {
    const r = parseConfirmRequestBody({ token: TOKEN, judges: [{ id: "claude", effort: "high" }] });
    return r.ok === true && r.token === TOKEN && r.picks.length === 1 && r.picks[0]?.effort === "high";
  })(),
);
check(
  "parseConfirmRequestBody defaults a missing per-judge effort to null",
  (() => {
    const r = parseConfirmRequestBody({ token: TOKEN, judges: [{ id: "claude" }] });
    return r.ok === true && r.picks[0]?.effort === null;
  })(),
);
check("parseConfirmRequestBody rejects a non-object body", parseConfirmRequestBody("nope").ok === false);
check("parseConfirmRequestBody rejects a missing token", parseConfirmRequestBody({ judges: [{ id: "claude" }] }).ok === false);
check("parseConfirmRequestBody rejects an empty judges array", parseConfirmRequestBody({ token: TOKEN, judges: [] }).ok === false);
check("parseConfirmRequestBody rejects a non-array judges", parseConfirmRequestBody({ token: TOKEN, judges: "claude" }).ok === false);
check(
  "parseConfirmRequestBody rejects a judges[] item with no id",
  parseConfirmRequestBody({ token: TOKEN, judges: [{ effort: "high" }] }).ok === false,
);

// ── resolveConfirmedJudges (server-side re-validation) ────────────────────
{
  const r = resolveConfirmedJudges(
    roster,
    [{ id: "x-ai/grok-4.7", effort: null }, { id: "openai/gpt-6-sol", effort: "low" }, { id: "google/gemini-3.8-flash", effort: null }],
    { playerFamily: "anthropic" },
  );
  check(
    "resolveConfirmedJudges accepts a legal 3-family pick and honors a chosen effort",
    r.ok === true && r.judges.length === 3 && r.judges[1]?.effort === "low" && r.judges[0]?.family === "x-ai",
    JSON.stringify(r),
  );
}
check(
  "resolveConfirmedJudges refuses a pick spanning fewer than 3 distinct families",
  resolveConfirmedJudges(
    roster,
    [{ id: "openai/gpt-6-sol", effort: null }, { id: "openai/gpt-6-luna", effort: null }, { id: "x-ai/grok-4.7", effort: null }],
    { playerFamily: "anthropic" },
  ).ok === false,
);
check(
  "resolveConfirmedJudges refuses an unknown roster id",
  resolveConfirmedJudges(
    roster,
    [{ id: "not-a-real-id", effort: null }, { id: "openai/gpt-6-sol", effort: null }, { id: "x-ai/grok-4.7", effort: null }],
    { playerFamily: "anthropic" },
  ).ok === false,
);
check(
  "resolveConfirmedJudges refuses the Player's own family",
  resolveConfirmedJudges(
    roster,
    [{ id: "claude", effort: null }, { id: "openai/gpt-6-sol", effort: null }, { id: "x-ai/grok-4.7", effort: null }],
    { playerFamily: "anthropic" },
  ).ok === false,
);
check(
  "resolveConfirmedJudges refuses an unverified door",
  resolveConfirmedJudges(
    roster,
    [{ id: "grok", effort: null }, { id: "openai/gpt-6-sol", effort: null }, { id: "x-ai/grok-4.7", effort: null }],
    { playerFamily: "anthropic" },
  ).ok === false,
);
check(
  "resolveConfirmedJudges refuses an effort the row does not declare",
  resolveConfirmedJudges(
    roster,
    [{ id: "x-ai/grok-4.7", effort: "extreme" }, { id: "openai/gpt-6-sol", effort: null }, { id: "google/gemini-3.8-flash", effort: null }],
    { playerFamily: "anthropic" },
  ).ok === false,
);

// ── evaluateConfirmRequest: exact refusal order ──────────────────────────
check(
  "a well-formed confirm returns 200 with 3 resolved judges",
  (() => {
    const r = evaluateConfirmRequest(baseConfirmInput());
    return r.status === 200 && r.status === 200 && r.judges.length === 3;
  })(),
);
check(
  "non-JSON content-type is refused 415, before every other check",
  evaluateConfirmRequest(baseConfirmInput({
    contentType: "text/plain",
    origin: "https://evil.example", // would also fail origin — 415 must still win
  })).status === 415,
);
check(
  "a foreign Origin is refused 403",
  evaluateConfirmRequest(baseConfirmInput({ origin: "https://evil.example" })).status === 403,
);
check(
  "an absent Origin is refused 403 (never treated as a trusted non-browser client)",
  evaluateConfirmRequest(baseConfirmInput({ origin: null })).status === 403,
);
check(
  "a JSON parse failure is refused 400",
  evaluateConfirmRequest(baseConfirmInput({ bodyParseError: true, rawBody: null })).status === 400,
);
check(
  "a malformed body (schema) is refused 400",
  evaluateConfirmRequest(baseConfirmInput({ rawBody: { token: TOKEN, judges: "nope" } })).status === 400,
);
check(
  // A body missing `token` entirely fails shape validation (parseConfirmRequestBody)
  // before a token comparison is even attempted — 400, not 403. A body that HAS a
  // token field that simply does not match the expected one is the 403 case (next
  // check) — that is the "compared in constant time (403 otherwise)" contract.
  "a body with no token field at all is refused 400 (shape), not 403",
  evaluateConfirmRequest(baseConfirmInput({ rawBody: { judges: [{ id: "claude" }, { id: "openai/gpt-6-sol" }, { id: "x-ai/grok-4.7" }] } })).status === 400,
);
check(
  "a wrong token is refused 403 (constant-time, not thrown)",
  evaluateConfirmRequest(baseConfirmInput({
    rawBody: { token: "wrong-token-wrong-token-wrong-tk", judges: [{ id: "claude" }, { id: "openai/gpt-6-sol" }, { id: "x-ai/grok-4.7" }] },
  })).status === 403,
);
check(
  "already-accepted is refused 409, checked AFTER the token (a wrong token on a used ticket still 403s)",
  evaluateConfirmRequest(baseConfirmInput({ alreadyAccepted: true })).status === 409,
);
check(
  "past the TTL is refused 410, checked after the one-shot gate",
  evaluateConfirmRequest(baseConfirmInput({ nowMs: Date.parse(EXPIRES_AT) + 1000 })).status === 410,
);
check(
  "an invalid pick (Player family) is refused 400 with validatePick's message",
  (() => {
    const r = evaluateConfirmRequest(baseConfirmInput({
      rawBody: { token: TOKEN, judges: [{ id: "claude" }, { id: "openai/gpt-6-sol" }, { id: "x-ai/grok-4.7" }] },
    }));
    return r.status === 400 && r.message.includes("Player's own vendor family");
  })(),
);
check(
  "an invalid pick (duplicate family) is refused 400 with validatePick's message",
  (() => {
    const r = evaluateConfirmRequest(baseConfirmInput({
      rawBody: { token: TOKEN, judges: [{ id: "openai/gpt-6-sol" }, { id: "openai/gpt-6-luna" }, { id: "x-ai/grok-4.7" }] },
    }));
    return r.status === 400 && r.message.includes("distinct families");
  })(),
);
check(
  "an unverified door in the pick is refused 400 with validatePick's message",
  (() => {
    const r = evaluateConfirmRequest(baseConfirmInput({
      rawBody: { token: TOKEN, judges: [{ id: "grok" }, { id: "openai/gpt-6-sol" }, { id: "google/gemini-3.8-flash" }] },
    }));
    return r.status === 400 && r.message.includes("not verified");
  })(),
);

// ── evaluateGetRequest ─────────────────────────────────────────────────────────
check(
  "GET with the right token, before expiry, is ok",
  evaluateGetRequest({ token: TOKEN, expectedToken: TOKEN, nowMs: NOW_MS, expiresAtIso: EXPIRES_AT }) === "ok",
);
check(
  "GET with a wrong token is not_found (never leaks whether a ticket exists)",
  evaluateGetRequest({ token: "wrong", expectedToken: TOKEN, nowMs: NOW_MS, expiresAtIso: EXPIRES_AT }) === "not_found",
);
check(
  "GET with no token is not_found",
  evaluateGetRequest({ token: null, expectedToken: TOKEN, nowMs: NOW_MS, expiresAtIso: EXPIRES_AT }) === "not_found",
);
check(
  "GET with the right token past expiry is expired",
  evaluateGetRequest({ token: TOKEN, expectedToken: TOKEN, nowMs: Date.parse(EXPIRES_AT) + 1, expiresAtIso: EXPIRES_AT }) === "expired",
);

// ── buildPickerPageModel ───────────────────────────────────────────────────────
{
  const model: PickerPageModel = buildPickerPageModel({
    ticketId: "ticket-1",
    token: TOKEN,
    expiresAt: EXPIRES_AT,
    playerModel: "claude-opus-5-5",
    playerFamily: "anthropic",
    roster,
    available: AVAILABLE_NONE,
    hasOpenRouterKey: true,
  });
  check("buildPickerPageModel returns one row per roster judge", model.rows.length === roster.judges.length);
  const claudeRow = model.rows.find((r) => r.id === "claude");
  check(
    "the Player's own family row is disabled with the self-review reason",
    claudeRow?.disabled === true && claudeRow.disabled_reason === "your agent's family — can't judge its own work",
    JSON.stringify(claudeRow),
  );
  const grokCliRow = model.rows.find((r) => r.id === "grok");
  check(
    "an unverified row is disabled with 'unverified — help wanted' (or the roster's own note)",
    grokCliRow?.disabled === true && !!grokCliRow.disabled_reason?.toLowerCase().includes("unverified"),
    JSON.stringify(grokCliRow),
  );
  const codexRow = model.rows.find((r) => r.id === "codex");
  check(
    "codex (unavailable CLI + unverified) is disabled",
    codexRow?.disabled === true && codexRow.available === false,
    JSON.stringify(codexRow),
  );
  const orRow = model.rows.find((r) => r.id === "x-ai/grok-4.7");
  check(
    "a verified OpenRouter row with a key present is enabled",
    orRow?.disabled === false && orRow.available === true,
    JSON.stringify(orRow),
  );
}
{
  const noKeyModel = buildPickerPageModel({
    ticketId: "ticket-1",
    token: TOKEN,
    expiresAt: EXPIRES_AT,
    playerModel: "claude-opus-5-5",
    playerFamily: "anthropic",
    roster,
    available: AVAILABLE_NONE,
    hasOpenRouterKey: false,
  });
  const orRow = noKeyModel.rows.find((r) => r.id === "x-ai/grok-4.7");
  check(
    "an OpenRouter row with no key is disabled naming OPENROUTER_API_KEY",
    orRow?.disabled === true && !!orRow.disabled_reason?.includes("OPENROUTER_API_KEY"),
    JSON.stringify(orRow),
  );
  check(
    "no OpenRouter key and no CLI available refuses the auto-recommendation (never invents one)",
    noKeyModel.recommended_ids.length === 0 && typeof noKeyModel.recommendation_refusal === "string",
    JSON.stringify(noKeyModel.recommendation_refusal),
  );
}
{
  const claudeOnlyModel = buildPickerPageModel({
    ticketId: "ticket-1",
    token: TOKEN,
    expiresAt: EXPIRES_AT,
    playerModel: "gpt-6-astra",
    playerFamily: "openai",
    roster,
    available: AVAILABLE_CLAUDE_ONLY,
    hasOpenRouterKey: true,
  });
  check(
    "the pre-filled recommendation seats the installed subscription CLI first",
    claudeOnlyModel.recommended_ids.includes("claude"),
    JSON.stringify(claudeOnlyModel.recommended_ids),
  );
  check(
    "the pre-filled recommendation never seats the Player's own family (openai excluded)",
    claudeOnlyModel.recommended_ids.every((id) => roster.judges.find((r) => r.id === id)?.family !== "openai"),
    JSON.stringify(claudeOnlyModel.recommended_ids),
  );
}

// ── the model being tested: its vendor is kept off the panel ──────────────────
{
  const sutModel = buildPickerPageModel({
    ticketId: "ticket-1",
    token: TOKEN,
    expiresAt: EXPIRES_AT,
    playerModel: "claude-opus-5-5",
    playerFamily: "anthropic",
    sutModel: "deepseek/deepseek-v4.1-flash",
    sutFamily: "deepseek",
    roster,
    available: AVAILABLE_NONE,
    hasOpenRouterKey: true,
  });
  const deepseekRows = sutModel.rows.filter((r) => r.family === "deepseek");
  check(
    "every row from the tested model's vendor is disabled, naming the tested model",
    deepseekRows.length > 0
      && deepseekRows.every((r) => r.disabled && !!r.disabled_reason?.includes("same vendor as the model being tested (deepseek/deepseek-v4.1-flash)")),
    JSON.stringify(deepseekRows.map((r) => r.disabled_reason)),
  );
  check(
    "the pre-filled recommendation never seats the tested model's vendor",
    sutModel.recommended_ids.length === 3
      && sutModel.recommended_ids.every((id) => roster.judges.find((r) => r.id === id)?.family !== "deepseek"),
    JSON.stringify(sutModel.recommended_ids),
  );
  check("the page model carries the tested model and family", sutModel.sut_model === "deepseek/deepseek-v4.1-flash" && sutModel.sut_family === "deepseek");
  const refused = evaluateConfirmRequest(baseConfirmInput({
    sutFamily: "deepseek",
    sutModel: "deepseek/deepseek-v4.1-flash",
    rawBody: { token: TOKEN, judges: [{ id: "openai/gpt-6-sol" }, { id: "deepseek/deepseek-v4-pro-0813" }, { id: "x-ai/grok-4.7" }] },
  }));
  check(
    "a pick that includes the tested model's vendor is refused 400 server-side",
    refused.status === 400 && refused.message.includes("same vendor as the model being tested"),
    JSON.stringify(refused),
  );
  const allowed = evaluateConfirmRequest(baseConfirmInput({
    sutFamily: "deepseek",
    rawBody: { token: TOKEN, judges: [{ id: "openai/gpt-6-sol" }, { id: "google/gemini-3.8-flash" }, { id: "x-ai/grok-4.7" }] },
  }));
  check("a pick without the tested model's vendor is accepted", allowed.status === 200, JSON.stringify(allowed));
  const noSut = buildPickerPageModel({
    ticketId: "ticket-1", token: TOKEN, expiresAt: EXPIRES_AT,
    playerModel: "claude-opus-5-5", playerFamily: "anthropic",
    roster, available: AVAILABLE_NONE, hasOpenRouterKey: true,
  });
  check(
    "without a tested model nothing extra is disabled (deepseek rows enabled)",
    noSut.sut_family === null && noSut.rows.filter((r) => r.family === "deepseek").every((r) => !r.disabled),
  );
}

// ── the deck's typefaces, inlined ─────────────────────────────────────────────
{
  const css = buildPickerFontCss({ sans: "d09GMgABAAAA", mono: "d09GMgABAAAB", serifItalic: "d09GMgABAAAC" });
  check(
    "buildPickerFontCss emits one @font-face per supplied font, as woff2 data URIs",
    (css.match(/@font-face/g) ?? []).length === 3
      && css.includes('font-family:"Instrument Sans"') && css.includes('font-family:"JetBrains Mono"')
      && css.includes('font-family:"Instrument Serif";font-style:italic')
      && (css.match(/url\(data:font\/woff2;base64,/g) ?? []).length === 3,
    css,
  );
  check("a missing font is simply left out", (buildPickerFontCss({ sans: "d09GMgABAAAA" }).match(/@font-face/g) ?? []).length === 1);
  check(
    "font data that is not plain base64 is refused (it could break out of the CSS)",
    buildPickerFontCss({ sans: 'abc");}body{background:red' }) === "",
  );
  const model = buildPickerPageModel({
    ticketId: "ticket-1", token: TOKEN, expiresAt: EXPIRES_AT,
    playerModel: "claude-opus-5-5", playerFamily: "anthropic",
    roster, available: AVAILABLE_NONE, hasOpenRouterKey: true,
  });
  const html = renderPickerHtml(model, { fontCss: css });
  check("the page carries the inlined fonts", html.includes("@font-face") && html.includes("data:font/woff2;base64,"));
  check("a page with fonts still makes no external request", !/https?:\/\/(?!127\.0\.0\.1|localhost)/i.test(html));
  check("the expired page carries the fonts too", renderExpiredHtml({ fontCss: css }).includes("@font-face"));
}

// ── HTML rendering: standalone, no external fetch ─────────────────────────────
{
  const model = buildPickerPageModel({
    ticketId: "ticket-1",
    token: TOKEN,
    expiresAt: EXPIRES_AT,
    playerModel: "claude-opus-5-5",
    playerFamily: "anthropic",
    roster,
    available: AVAILABLE_NONE,
    hasOpenRouterKey: true,
  });
  const html = renderPickerHtml(model);
  check("rendered HTML is a full document", html.startsWith("<!doctype html>"));
  check("rendered HTML embeds the page model as window.__PICKER__", html.includes("window.__PICKER__="));
  check("rendered HTML contains no external fetch/link/script src", !/https?:\/\/(?!127\.0\.0\.1|localhost)/i.test(html));
  check("rendered HTML has no <link rel=\"stylesheet\" href=\"http", !/<link[^>]+href=["']https?:/i.test(html));
  check("rendered HTML's only same-origin call is POST /confirm", html.includes('fetch("/confirm"'));
  check("rendered HTML escapes the player_model into the page", html.includes("claude-opus-5-5"));
  const expiredHtml = renderExpiredHtml();
  check("the expired page names referee_panel_mint", expiredHtml.includes("referee_panel_mint"));
}

console.log(`${failures === 0 ? "PASS" : "FAIL"} ${total - failures}/${total}`);
process.exit(failures === 0 ? 0 : 1);
