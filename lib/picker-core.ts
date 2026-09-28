// Titration MCP — local referee-panel picker (PURE, import-clean, offline-tested).
//
// Everything about the picker that does NOT touch a socket, a
// port, the filesystem, the OS browser opener, or the ticket table lives here —
// request validation (content-type / origin / constant-time token compare / TTL /
// one-shot), the page-data model (roster rows + computed availability/disabled
// state + the pre-filled recommendation), and the standalone HTML/CSS/JS the
// picker server serves. server/picker/server.ts is the thin I/O wrapper: it owns
// the http.Server, the port bind, the OS browser-open call, and the ticket-table
// write (lib/referee-panel-ticket.ts's `confirm`) — every DECISION about whether
// a request is accepted is made here and returned as a plain result the I/O layer
// maps to an HTTP status code.
//
// No Date.now() / Math.random() — callers inject `nowMs`. node:crypto is used
// only for its two deterministic primitives (createHash, timingSafeEqual), never
// for randomness (the 16-byte CSPRNG token itself is minted by the I/O layer,
// server/picker/server.ts, via node:crypto.randomBytes — a real RNG belongs in
// the I/O shell, not this pure core).

import { createHash, timingSafeEqual } from "node:crypto";

import {
  resolveAutoPanel,
  validatePick,
  type CliAvailability,
  type CuratedFamily,
  type JudgeReasoningEffort,
  type Roster,
  type RosterCostClass,
  type RosterDoor,
  type RosterJudgeRow,
} from "./judges-roster-core";
import type { ConfirmedPanelJudge } from "./referee-panel-ticket-core";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// ── constant-time token compare ───────────────────────────────────────────────
//
// Hashing both sides first sidesteps node:crypto's timingSafeEqual throwing on
// unequal-length buffers (which would itself leak length via a thrown-vs-not
// branch) — the standard "compare digests, not the raw strings" technique.
export function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}

export function isJsonContentType(contentType: string | null | undefined): boolean {
  return typeof contentType === "string" && contentType.trim().toLowerCase().startsWith("application/json");
}

export function buildAllowedOrigins(port: number): readonly string[] {
  return [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ];
}

export function isAllowedOrigin(originHeader: string | null | undefined, allowed: readonly string[]): boolean {
  if (typeof originHeader !== "string" || originHeader.length === 0) return false;
  return allowed.includes(originHeader);
}

export function isPastExpiry(expiresAtIso: string, nowMs: number): boolean {
  const expiresMs = Date.parse(expiresAtIso);
  return !Number.isFinite(expiresMs) || nowMs >= expiresMs;
}

// ── page model (roster rows -> availability/disabled + the recommendation) ────

export interface PickerRowView {
  readonly id: string;
  readonly name: string;
  readonly family: CuratedFamily;
  readonly door: RosterDoor;
  readonly model: string;
  readonly efforts: readonly JudgeReasoningEffort[];
  readonly cost_class: RosterCostClass;
  readonly recommended: boolean;
  readonly verified: boolean;
  readonly available: boolean;
  readonly disabled: boolean;
  readonly disabled_reason: string | null;
}

export interface PickerPageModel {
  readonly ticket_id: string;
  readonly token: string;
  readonly expires_at: string;
  readonly player_model: string;
  readonly player_family: CuratedFamily;
  /** The model the system under test calls, when the agent said; its vendor may not judge it. */
  readonly sut_model: string | null;
  readonly sut_family: CuratedFamily | null;
  readonly rows: readonly PickerRowView[];
  readonly recommended_ids: readonly string[];
  readonly recommendation_refusal: string | null;
}

export interface BuildPickerPageModelInput {
  readonly ticketId: string;
  readonly token: string;
  readonly expiresAt: string;
  readonly playerModel: string;
  readonly playerFamily: CuratedFamily;
  readonly sutModel?: string | null;
  readonly sutFamily?: CuratedFamily | null;
  readonly roster: Roster;
  readonly available: CliAvailability;
  readonly hasOpenRouterKey: boolean;
}

// Shown on a disabled row and returned on a refused confirm.
export function sutFamilyReason(sutModel: string | null | undefined): string {
  return `same vendor as the model being tested${sutModel ? ` (${sutModel})` : ""} — a judge may favour its own vendor`;
}

function doorIsAvailable(door: RosterDoor, available: CliAvailability, hasOpenRouterKey: boolean): boolean {
  if (door === "openrouter") return hasOpenRouterKey;
  return available[door];
}

function doorUnavailableReason(door: RosterDoor): string {
  if (door === "openrouter") return "unavailable — OPENROUTER_API_KEY is not set";
  return `unavailable — the ${door} CLI is not installed (or not resolvable on PATH)`;
}

function rowView(
  row: RosterJudgeRow,
  playerFamily: CuratedFamily,
  sut: { model: string | null; family: CuratedFamily | null },
  available: CliAvailability,
  hasOpenRouterKey: boolean,
): PickerRowView {
  const isAvailable = doorIsAvailable(row.door, available, hasOpenRouterKey);
  let disabled = false;
  let disabledReason: string | null = null;
  if (row.family === playerFamily) {
    disabled = true;
    disabledReason = "your agent's family — can't judge its own work";
  } else if (sut.family && row.family === sut.family) {
    disabled = true;
    disabledReason = sutFamilyReason(sut.model);
  } else if (!row.verified) {
    disabled = true;
    disabledReason = row.note ?? "unverified — help wanted";
  } else if (!isAvailable) {
    disabled = true;
    disabledReason = doorUnavailableReason(row.door);
  }
  return {
    id: row.id,
    name: row.name,
    family: row.family,
    door: row.door,
    model: row.model,
    efforts: row.efforts,
    cost_class: row.cost_class,
    recommended: row.recommended,
    verified: row.verified,
    available: isAvailable,
    disabled,
    disabled_reason: disabledReason,
  };
}

// Pre-filled recommendation: the SAME deterministic resolver TITRATION_JUDGES=auto
// uses (subscription CLIs first, OpenRouter only with a key, the Player's family
// excluded, verified rows only). Empty (never invented) when it refuses — the page
// then just starts with nothing pre-checked and shows why.
export function buildPickerPageModel(input: BuildPickerPageModelInput): PickerPageModel {
  const sut = { model: input.sutModel ?? null, family: input.sutFamily ?? null };
  const rows = input.roster.judges.map((row) =>
    rowView(row, input.playerFamily, sut, input.available, input.hasOpenRouterKey));

  const auto = resolveAutoPanel(input.roster, {
    available: input.available,
    hasOpenRouterKey: input.hasOpenRouterKey,
    playerFamily: input.playerFamily,
    excludeFamilies: sut.family ? [sut.family] : [],
  });

  return {
    ticket_id: input.ticketId,
    token: input.token,
    expires_at: input.expiresAt,
    player_model: input.playerModel,
    player_family: input.playerFamily,
    sut_model: sut.model,
    sut_family: sut.family,
    rows,
    recommended_ids: auto.ok ? auto.panel.map((judge) => judge.id) : [],
    recommendation_refusal: auto.ok ? null : auto.reason,
  };
}

// ── POST /confirm body ────────────────────────────────────────────────────────

export interface ConfirmRequestPick {
  readonly id: string;
  readonly effort: string | null;
}

export type ParseConfirmBodyResult =
  | { ok: true; token: string; picks: readonly ConfirmRequestPick[] }
  | { ok: false; message: string };

export function parseConfirmRequestBody(raw: unknown): ParseConfirmBodyResult {
  if (!isPlainObject(raw)) {
    return { ok: false, message: "confirm body must be a JSON object" };
  }
  const { token, judges } = raw;
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, message: "confirm body.token must be a non-empty string" };
  }
  if (!Array.isArray(judges) || judges.length === 0) {
    return { ok: false, message: "confirm body.judges must be a non-empty array" };
  }
  const picks: ConfirmRequestPick[] = [];
  for (const item of judges) {
    if (!isPlainObject(item) || typeof item.id !== "string" || item.id.trim().length === 0) {
      return { ok: false, message: "confirm body.judges[].id must be a non-empty string" };
    }
    const rawEffort = item.effort;
    if (rawEffort !== undefined && rawEffort !== null && (typeof rawEffort !== "string" || rawEffort.trim().length === 0)) {
      return { ok: false, message: "confirm body.judges[].effort must be a non-empty string when present" };
    }
    picks.push({
      id: item.id.trim(),
      effort: typeof rawEffort === "string" ? rawEffort.trim() : null,
    });
  }
  return { ok: true, token, picks };
}

// ── pick -> ConfirmedPanelJudge[] (server-side re-validation) ─────────────
//
// The client-side disabled/greyed hints are a UX convenience only — this is the
// gate that actually matters. Reuses judges-roster-core's validatePick (count,
// duplicate id, unknown id, not-verified, Player-family, distinct-family) and
// then applies the human's chosen per-judge effort (limited to that row's own
// declared efforts — a row never gets an effort it doesn't advertise); an
// omitted effort keeps validatePick's row default.
export type ResolveConfirmedJudgesResult =
  | { ok: true; judges: readonly [ConfirmedPanelJudge, ConfirmedPanelJudge, ConfirmedPanelJudge] }
  | { ok: false; message: string };

export function resolveConfirmedJudges(
  roster: Roster,
  picks: readonly ConfirmRequestPick[],
  opts: { playerFamily: string; sutFamily?: string | null; sutModel?: string | null },
): ResolveConfirmedJudgesResult {
  const ids = picks.map((pick) => pick.id);
  if (opts.sutFamily) {
    const clash = roster.judges.find((row) => ids.includes(row.id) && row.family === opts.sutFamily);
    if (clash) {
      return { ok: false, message: `'${clash.id}' is family '${clash.family}': ${sutFamilyReason(opts.sutModel)}` };
    }
  }
  const validated = validatePick(roster, ids, { playerFamily: opts.playerFamily });
  if (!validated.ok) {
    return { ok: false, message: validated.message };
  }
  const byId = new Map(roster.judges.map((row) => [row.id, row] as const));
  const judges: ConfirmedPanelJudge[] = [];
  for (let i = 0; i < validated.panel.length; i++) {
    const spec = validated.panel[i]!;
    const row = byId.get(spec.id);
    if (!row) {
      // Defensive tripwire: validatePick already resolved every id against this
      // same roster, so this can only fire if the roster mutated mid-request.
      return { ok: false, message: `'${spec.id}' is no longer a judges-roster.json id` };
    }
    const requested = picks[i]?.effort ?? null;
    let effort: JudgeReasoningEffort = spec.effort ?? row.efforts[0]!;
    if (requested != null) {
      const legal = row.efforts.includes(requested as JudgeReasoningEffort);
      if (!legal) {
        return {
          ok: false,
          message: `'${spec.id}' does not offer reasoning effort '${requested}' (offers ${row.efforts.join("/")})`,
        };
      }
      effort = requested as JudgeReasoningEffort;
    }
    judges.push({ id: row.id, family: row.family, door: row.door, model: row.model, effort });
  }
  return { ok: true, judges: [judges[0]!, judges[1]!, judges[2]!] };
}

// ── the full server-side confirm decision (exact refusal order) ──────────

export type ConfirmOutcome =
  | { readonly status: 200; readonly judges: readonly [ConfirmedPanelJudge, ConfirmedPanelJudge, ConfirmedPanelJudge] }
  | { readonly status: 400; readonly message: string }
  | { readonly status: 403; readonly message: string }
  | { readonly status: 409; readonly message: string }
  | { readonly status: 410; readonly message: string }
  | { readonly status: 415; readonly message: string };

export interface EvaluateConfirmInput {
  readonly contentType: string | null | undefined;
  readonly origin: string | null | undefined;
  readonly allowedOrigins: readonly string[];
  /** Already JSON.parse'd by the I/O layer; `null` + bodyParseError:true on a parse failure. */
  readonly rawBody: unknown;
  readonly bodyParseError: boolean;
  readonly expectedToken: string;
  readonly alreadyAccepted: boolean;
  readonly nowMs: number;
  readonly expiresAtIso: string;
  readonly roster: Roster;
  readonly playerFamily: string;
  readonly sutFamily?: string | null;
  readonly sutModel?: string | null;
}

// Exact order: 415 non-JSON -> 403 foreign Origin -> 400 malformed body ->
// 403 missing/wrong token (constant-time) -> 409 already accepted -> 410 past
// the 12-minute TTL -> 400 an invalid pick (count/duplicate/unknown/unverified/
// Player-family/distinct-family/illegal-effort) -> 200 the resolved judges.
export function evaluateConfirmRequest(input: EvaluateConfirmInput): ConfirmOutcome {
  if (!isJsonContentType(input.contentType)) {
    return { status: 415, message: "content-type must be application/json" };
  }
  if (!isAllowedOrigin(input.origin, input.allowedOrigins)) {
    return { status: 403, message: "cross-origin confirm refused" };
  }
  if (input.bodyParseError) {
    return { status: 400, message: "invalid JSON body" };
  }
  const parsed = parseConfirmRequestBody(input.rawBody);
  if (!parsed.ok) {
    return { status: 400, message: parsed.message };
  }
  if (!constantTimeEqual(parsed.token, input.expectedToken)) {
    return { status: 403, message: "missing or invalid token" };
  }
  if (input.alreadyAccepted) {
    return { status: 409, message: "a pick was already recorded for this ticket" };
  }
  if (isPastExpiry(input.expiresAtIso, input.nowMs)) {
    return { status: 410, message: "picker ticket has expired" };
  }
  const resolved = resolveConfirmedJudges(input.roster, parsed.picks, {
    playerFamily: input.playerFamily,
    sutFamily: input.sutFamily ?? null,
    sutModel: input.sutModel ?? null,
  });
  if (!resolved.ok) {
    return { status: 400, message: resolved.message };
  }
  return { status: 200, judges: resolved.judges };
}

// ── GET / (serve the page, or a terse expired/not-found response) ────────────

export type EvaluateGetOutcome = "ok" | "not_found" | "expired";

export function evaluateGetRequest(input: {
  readonly token: string | null;
  readonly expectedToken: string;
  readonly nowMs: number;
  readonly expiresAtIso: string;
}): EvaluateGetOutcome {
  if (typeof input.token !== "string" || input.token.length === 0 || !constantTimeEqual(input.token, input.expectedToken)) {
    return "not_found";
  }
  if (isPastExpiry(input.expiresAtIso, input.nowMs)) {
    return "expired";
  }
  return "ok";
}

// ── standalone HTML (no framework, no external fetch) ───────────────────

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]!));
}

// `<` -> its JSON unicode escape so an embedded string containing `</script>`
// can never terminate the boot element early; JSON.parse recovers the exact
// string (the injectBoot trick).
function bootScript(model: PickerPageModel): string {
  const json = JSON.stringify(model).replace(/</g, "\\u003c");
  return `<script>window.__PICKER__=${json};</script>`;
}

// Shared look for every page the picker serves: an ink lab-notebook grid, one
// indicator colour (titration pink) that only ever means "selected", and each
// vendor family drawn as an element tile in its own colour. System fonts only —
// the page makes no external request.
const PICKER_CSS = `
:root{--bg:#0a0c11;--panel:#10131a;--panel-2:#151923;--line:#232834;--line-2:#333a48;--text:#eef0f4;
--muted:#9aa1b0;--dim:#5c6475;--pink:#ff4d8d;--gold:#e7c77a;--pink-glow:rgba(255,77,141,.38);--bad:#ff8a7a;
--sans:"Instrument Sans","Segoe UI Variable Text","Segoe UI",-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;
--mono:"JetBrains Mono","Cascadia Mono","SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace;
--serif:"Instrument Serif","Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;}
*{box-sizing:border-box;}
html,body{margin:0;min-height:100%;}
body{background:
radial-gradient(900px 600px at 85% -10%,rgba(255,77,141,.08),transparent 60%),
radial-gradient(800px 500px at -10% 110%,rgba(148,145,255,.07),transparent 60%),
linear-gradient(rgba(255,255,255,.03) 1px,transparent 1px) 0 0/32px 32px,
linear-gradient(90deg,rgba(255,255,255,.03) 1px,transparent 1px) 0 0/32px 32px,var(--bg);
color:var(--text);font-family:var(--sans);-webkit-font-smoothing:antialiased;}
.top{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:22px 32px 0;
font-family:var(--mono);font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim);}
.brand{display:flex;align-items:center;gap:10px;color:var(--muted);}
.brand b{color:var(--text);letter-spacing:.28em;font-weight:600;}
.brand svg{width:13px;height:18px;}
.clock{color:var(--muted);}
.clock b{color:var(--pink);font-weight:500;}
.clock.low b{animation:pulse 1s ease-in-out infinite;}
@keyframes pulse{50%{opacity:.35;}}
.wrap{max-width:1180px;margin:0 auto;padding:26px 32px 150px;}
.kicker{display:flex;align-items:center;gap:12px;font-family:var(--mono);font-size:12px;letter-spacing:.18em;
text-transform:uppercase;color:var(--pink);margin:0 0 12px;}
.kicker::before{content:"";width:24px;height:1px;background:var(--pink);}
h1{font-size:clamp(34px,5vw,54px);line-height:1.02;letter-spacing:-.012em;font-weight:650;margin:0;}
h1 em{font-family:var(--serif);font-style:italic;font-weight:400;color:var(--pink);letter-spacing:-.01em;}
.lede{font-size:17px;line-height:1.5;color:var(--muted);margin:12px 0 0;max-width:760px;}
.lede b{color:var(--text);font-weight:600;}
.chips{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0 0;}
.chip{display:flex;align-items:center;gap:10px;border:1px solid var(--line-2);border-radius:999px;
padding:6px 14px 6px 8px;font-size:13px;color:var(--muted);background:rgba(16,19,26,.8);}
.chip .el-mini{width:26px;height:26px;border-radius:5px;display:grid;place-items:center;font-weight:650;
font-size:12px;color:#0a0c11;background:var(--k);}
.chip code{font-family:var(--mono);font-size:12px;color:var(--text);}
.chip .no{font-family:var(--mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--bad);}
.bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px 24px;margin:28px 0 14px;}
.hint{margin:0;display:flex;align-items:center;gap:10px;font-size:14px;color:var(--muted);}
.hint .star{color:var(--gold);font-size:15px;line-height:1;}
.hint kbd{font-family:var(--mono);font-size:11px;letter-spacing:.06em;color:var(--text);background:var(--panel-2);
border:1px solid var(--line-2);border-bottom-width:2px;border-radius:5px;padding:2px 7px;}
.hint.warn{color:var(--bad);}
.legend{display:flex;flex-wrap:wrap;gap:18px;font-family:var(--mono);font-size:11.5px;
letter-spacing:.08em;text-transform:uppercase;color:var(--dim);}
.legend span{display:flex;align-items:center;gap:8px;}
.legend i{width:9px;height:9px;border-radius:2px;display:inline-block;}
.table{display:flex;flex-direction:column;gap:10px;}
.period{display:grid;grid-template-columns:168px 1fr;gap:10px;align-items:stretch;}
.fam{--k:#98a2b3;position:relative;border-radius:8px;padding:10px 12px;overflow:hidden;
background:linear-gradient(160deg,color-mix(in srgb,var(--k) 22%,#10131a),#0d1016 80%);
border:1px solid color-mix(in srgb,var(--k) 40%,transparent);display:flex;flex-direction:column;justify-content:space-between;min-height:92px;}
.fam::before{content:"";position:absolute;left:0;right:0;top:0;height:3px;background:var(--k);}
.fam .sym{font-size:32px;font-weight:650;letter-spacing:-.03em;line-height:1;}
.fam .nm{font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--k);}
.fam .why{font-size:11.5px;line-height:1.35;color:var(--pink);margin-top:6px;}
.fam.out{filter:saturate(.35);opacity:.8;}
.fam.out .sym{text-decoration:line-through;text-decoration-color:var(--pink);text-decoration-thickness:3px;}
.judges{display:flex;flex-wrap:wrap;gap:10px;}
.j{--k:#98a2b3;position:relative;flex:1 1 210px;max-width:320px;min-height:92px;border-radius:8px;padding:10px 12px;
background:var(--panel);border:1px solid var(--line-2);cursor:pointer;display:flex;flex-direction:column;gap:6px;
transition:transform .12s ease,border-color .12s ease,box-shadow .12s ease;text-align:left;color:inherit;font:inherit;}
.j:hover{border-color:color-mix(in srgb,var(--k) 70%,var(--line-2));transform:translateY(-1px);}
.j:focus-visible{outline:2px solid var(--pink);outline-offset:2px;}
.j .row1{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;}
.j .name{font-weight:600;font-size:15px;line-height:1.25;}
.j .model{font-family:var(--mono);font-size:11px;color:var(--dim);word-break:break-all;}
.j .tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:auto;align-items:center;}
.tag{font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;border-radius:4px;padding:3px 6px;
border:1px solid var(--line-2);color:var(--muted);}
.tag.sub{color:#7ee2b8;border-color:rgba(126,226,184,.4);}
.tag.rec{color:var(--gold);border-color:rgba(231,199,122,.4);}
.j .dot{width:18px;height:18px;border-radius:50%;border:1.5px solid var(--line-2);flex:none;display:grid;place-items:center;}
.j.on{border-color:var(--pink);background:linear-gradient(160deg,rgba(255,77,141,.18),var(--panel) 70%);
box-shadow:0 0 0 1px rgba(255,77,141,.5),0 0 34px rgba(255,77,141,.18);}
.j.on .dot{background:var(--pink);border-color:var(--pink);}
.j.on .dot::after{content:"";width:6px;height:6px;border-radius:50%;background:#fff;}
.j select{font-family:var(--mono);font-size:11px;background:var(--panel-2);color:var(--text);border:1px solid var(--line-2);
border-radius:4px;padding:3px 4px;}
.j.off{cursor:not-allowed;opacity:.45;background:repeating-linear-gradient(135deg,var(--panel) 0 8px,#0d1016 8px 16px);}
.j.off:hover{transform:none;border-color:var(--line-2);}
.j .reason{font-size:11.5px;line-height:1.35;color:var(--muted);font-style:italic;}
.j.blocked{cursor:not-allowed;opacity:.42;}
.j.blocked:hover{transform:none;}
.sr{position:absolute;opacity:0;pointer-events:none;width:1px;height:1px;}
.dock{position:fixed;left:0;right:0;bottom:0;z-index:5;background:rgba(10,12,17,.92);backdrop-filter:blur(10px);
border-top:1px solid var(--line-2);}
.dock-in{max-width:1180px;margin:0 auto;padding:14px 32px;display:flex;align-items:center;gap:22px;}
.slots{display:flex;gap:10px;}
.slot{--k:var(--line-2);width:74px;height:74px;border-radius:8px;border:1.5px dashed var(--line-2);display:flex;
flex-direction:column;justify-content:space-between;padding:6px 8px;position:relative;overflow:hidden;}
.slot .n{font-family:var(--mono);font-size:10px;color:var(--dim);}
.slot .s{font-size:26px;font-weight:650;letter-spacing:-.03em;line-height:1;}
.slot.full{border:1px solid color-mix(in srgb,var(--k) 55%,transparent);
background:linear-gradient(160deg,color-mix(in srgb,var(--k) 26%,#10131a),#0d1016 85%);}
.slot.full::before{content:"";position:absolute;left:0;right:0;top:0;height:3px;background:var(--k);}
.slot.full .n{color:var(--k);}
#msg{flex:1;font-size:14px;color:var(--muted);line-height:1.4;}
#msg b{color:var(--text);}
#msg.err{color:var(--bad);}
.btns{display:flex;gap:10px;}
button.ghost,button.go{font-family:var(--sans);font-size:14px;font-weight:600;border-radius:8px;padding:12px 18px;cursor:pointer;}
button.ghost{background:transparent;color:var(--text);border:1px solid var(--line-2);}
button.ghost:hover{border-color:var(--muted);}
button.go{background:var(--pink);color:#fff;border:none;box-shadow:0 0 30px var(--pink-glow);}
button.go:disabled{background:#2a2f3b;color:var(--dim);box-shadow:none;cursor:not-allowed;}
#sentOverlay{display:none;position:fixed;inset:0;z-index:10;background:rgba(10,12,17,.94);align-items:center;justify-content:center;padding:24px;}
body.sent #sentOverlay{display:flex;}
.done{max-width:560px;text-align:center;}
.done .flask{width:68px;height:68px;margin:0 auto 18px;border-radius:50%;background:var(--pink);display:grid;place-items:center;
box-shadow:0 0 60px var(--pink-glow);}
.done h2{font-size:36px;letter-spacing:-.02em;margin:0;}
.done h2 em{font-family:var(--serif);font-style:italic;font-weight:400;color:var(--pink);}
.done p{color:var(--muted);font-size:16px;line-height:1.5;margin:12px 0 22px;}
.done .slots{justify-content:center;}
.done .slot{width:120px;height:96px;}
.done .slot .m{font-family:var(--mono);font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
@media (max-width:760px){
.top,.wrap{padding-left:16px;padding-right:16px;}
.period{grid-template-columns:1fr;}
.fam{min-height:0;flex-direction:row;align-items:center;gap:12px;flex-wrap:wrap;}
.fam .sym{font-size:24px;}
.j{flex:1 1 100%;max-width:none;min-height:0;}
.chip{flex-wrap:wrap;border-radius:12px;}
.chip code{word-break:break-all;}
h1{font-size:34px;}
.dock-in{flex-wrap:wrap;padding:12px 16px;gap:12px;}
.slot{width:56px;height:56px;}
.slot .s{font-size:20px;}
#msg{flex-basis:100%;order:3;}
.btns{margin-left:auto;}
}`;

// The deck's three typefaces (SIL OFL 1.1, files and licences in server/picker/fonts),
// inlined as data URIs by the picker server so the page still makes no external
// request. Any font left out simply falls back to the system stacks above.
export interface PickerFontData {
  readonly sans?: string; // Instrument Sans: base64 woff2, Latin, variable weight
  readonly mono?: string; // JetBrains Mono
  readonly serifItalic?: string; // Instrument Serif italic
}

export function buildPickerFontCss(fonts: PickerFontData): string {
  const face = (family: string, b64: string | undefined, style: string, weight: string): string =>
    b64 && /^[A-Za-z0-9+/=]+$/.test(b64)
      ? `@font-face{font-family:"${family}";font-style:${style};font-weight:${weight};font-display:swap;` +
        `src:url(data:font/woff2;base64,${b64}) format("woff2");}`
      : "";
  return face("Instrument Sans", fonts.sans, "normal", "400 700") +
    face("JetBrains Mono", fonts.mono, "normal", "400 600") +
    face("Instrument Serif", fonts.serifItalic, "italic", "400");
}

export interface PickerRenderOptions {
  readonly fontCss?: string;
}

const DROP_SVG = `<svg viewBox="0 0 16 23" aria-hidden="true"><path d="M8 0C8 0 0 10 0 14.5a8 8 0 0 0 16 0C16 10 8 0 8 0Z" fill="#ff4d8d"/><path d="M4.5 14.5a3.5 3.5 0 0 0 3.5 3.5" stroke="#fff" stroke-opacity=".7" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>`;

export function renderExpiredHtml(options: PickerRenderOptions = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Judge picker expired · Titration</title>
<style>${options.fontCss ?? ""}${PICKER_CSS}
.gone{min-height:100vh;display:grid;place-items:center;padding:24px;text-align:center;}
.gone h1{font-size:40px;}
.gone p{color:var(--muted);font-size:16px;line-height:1.5;max-width:460px;margin:14px auto 0;}
.gone code{font-family:var(--mono);color:var(--text);}
</style>
</head>
<body>
<div class="gone"><div>
  <p class="kicker" style="justify-content:center">Judge picker</p>
  <h1>This link has <em>expired.</em></h1>
  <p>Picker links last 12 minutes and work once. Ask your agent to call <code>referee_panel_mint</code> again for a fresh one.</p>
</div></div>
</body>
</html>`;
}

export function renderPickerHtml(model: PickerPageModel, options: PickerRenderOptions = {}): string {
  const sutChip = model.sut_model
    ? `<span class="chip" data-testid="sut-chip"><span class="el-mini" data-fam="${escapeHtml(model.sut_family ?? "")}"></span>` +
      `Being tested: <code>${escapeHtml(model.sut_model)}</code><span class="no">can't judge</span></span>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pick your judges · Titration</title>
<style>${options.fontCss ?? ""}${PICKER_CSS}</style>
${bootScript(model)}
</head>
<body>
<div class="top">
  <span class="brand">${DROP_SVG}<b>Titration</b></span>
  <span class="clock" id="clock">link expires in <b id="clockValue">--:--</b></span>
</div>
<div class="wrap">
  <p class="kicker">Judge panel</p>
  <h1>Pick your <em>referees.</em></h1>
  <p class="lede">Three judges from <b>three different vendors</b> grade your agent's work. No vendor grades its own
    work, and this panel stays locked to the baseline, so every later result uses the same judges.</p>
  <div class="chips">
    <span class="chip" data-testid="player-chip"><span class="el-mini" data-fam="${escapeHtml(model.player_family)}"></span>
      Your agent: <code>${escapeHtml(model.player_model)}</code><span class="no">can't judge</span></span>
    ${sutChip}
  </div>
  <div class="bar">
    ${model.recommendation_refusal
      ? `<p class="hint warn" data-testid="prefill-hint">No panel could be pre-filled: ${escapeHtml(model.recommendation_refusal)}</p>`
      : `<p class="hint" data-testid="prefill-hint"><span class="star">★</span>Recommended panel pre-filled. Swap any judge, or press <kbd>Auto-fill</kbd> to reset.</p>`}
    <div class="legend">
      <span><i style="background:#7ee2b8"></i>subscription</span>
      <span><i style="background:#9aa1b0"></i>OpenRouter · per call</span>
      <span><i style="background:#e7c77a"></i>recommended</span>
      <span><i style="background:#ff4d8d"></i>selected</span>
    </div>
  </div>
  <div class="table" id="rows"></div>
</div>
<div class="dock">
  <div class="dock-in">
    <div class="slots" id="slots"></div>
    <div id="msg">Select 3 judges from 3 different vendors.</div>
    <div class="btns">
      <button type="button" class="ghost" id="autoFillBtn" data-testid="btn-autofill">Auto-fill</button>
      <button type="button" class="go" id="confirmBtn" data-testid="btn-confirm" disabled>Confirm panel</button>
    </div>
  </div>
</div>
<div id="sentOverlay" data-testid="sent-overlay">
  <div class="done">
    <div class="flask"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>
    <h2>Panel <em>locked.</em></h2>
    <p>Your agent already has it and is starting to grade. You can close this tab.</p>
    <div class="slots" id="doneSlots"></div>
  </div>
</div>
<script>
var MODEL = window.__PICKER__;
var FAMILIES = {
  anthropic: { sym: "An", name: "Anthropic", color: "#d97757" },
  openai: { sym: "Oa", name: "OpenAI", color: "#10b981" },
  google: { sym: "Go", name: "Google", color: "#4285f4" },
  deepseek: { sym: "Ds", name: "DeepSeek", color: "#6c7cff" },
  "z-ai": { sym: "Za", name: "Z.ai", color: "#2dd4bf" },
  "x-ai": { sym: "Xa", name: "xAI", color: "#c9ced8" },
  moonshotai: { sym: "Mo", name: "Moonshot AI", color: "#a78bfa" },
  qwen: { sym: "Qw", name: "Qwen", color: "#f59e0b" },
  meta: { sym: "Me", name: "Meta", color: "#38bdf8" },
  minimax: { sym: "Mm", name: "MiniMax", color: "#f97316" }
};
function fam(key) {
  return FAMILIES[key] || { sym: String(key || "?").slice(0, 2).replace(/^./, function (c) { return c.toUpperCase(); }), name: key, color: "#98a2b3" };
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function rowById(id) { return MODEL.rows.find(function (r) { return r.id === id; }); }
function defaultEffort(row) { return row.efforts.indexOf("high") >= 0 ? "high" : row.efforts[0]; }
function recommendedPicks() {
  return MODEL.recommended_ids.map(rowById)
    .filter(function (row) { return row && !row.disabled; })
    .map(function (row) { return { id: row.id, effort: defaultEffort(row) }; });
}
function displayName(row) {
  var n = String(row.name || row.id);
  if (n.indexOf(": ") >= 0) return n.split(": ").slice(1).join(": ");
  return n.split(" (")[0] + (row.door !== "openrouter" ? " CLI" : "");
}
var selected = recommendedPicks();
var expired = false;

document.querySelectorAll("[data-fam]").forEach(function (el) {
  var f = fam(el.getAttribute("data-fam"));
  el.style.setProperty("--k", f.color);
  el.textContent = f.sym;
});

function familyOut(key) {
  if (key === MODEL.player_family) return "your agent's vendor: it can't judge its own work";
  if (MODEL.sut_family && key === MODEL.sut_family) return "same vendor as the model being tested";
  return "";
}

function renderRows() {
  // Families you can pick from first; excluded ones (your agent's, the tested model's) last.
  var order = [];
  MODEL.rows.forEach(function (r) { if (order.indexOf(r.family) < 0) order.push(r.family); });
  order.sort(function (a, b) { return (familyOut(a) ? 1 : 0) - (familyOut(b) ? 1 : 0); });
  var used = {};
  selected.forEach(function (s) { used[rowById(s.id).family] = s.id; });
  var html = order.map(function (key) {
    var f = fam(key);
    var out = familyOut(key);
    var tiles = MODEL.rows.filter(function (r) { return r.family === key; }).map(function (row) {
      var pick = selected.find(function (s) { return s.id === row.id; });
      var on = !!pick;
      var clash = !on && !row.disabled && used[key];
      var full = !on && !row.disabled && !clash && selected.length >= 3;
      var cls = "j" + (on ? " on" : "") + (row.disabled ? " off" : "") + ((clash || full) ? " blocked" : "");
      // The family tile already explains an excluded family; a full panel or a
      // family already on it just dims the tile.
      var reason = row.disabled && !out ? row.disabled_reason : "";
      var tags = '<span class="tag' + (row.cost_class === "subscription" ? " sub" : "") + '">' +
        (row.door === "openrouter" ? "OpenRouter" : esc(row.door) + " CLI") + "</span>";
      if (row.recommended && !row.disabled) tags += '<span class="tag rec">★ recommended</span>';
      if (on) {
        tags += '<select aria-label="reasoning effort" data-testid="judge-effort-' + esc(row.id) + '">' +
          row.efforts.map(function (e) { return '<option value="' + e + '"' + (e === pick.effort ? " selected" : "") + ">" + e + " effort</option>"; }).join("") +
          "</select>";
      }
      return '<div class="' + cls + '" role="button" tabindex="' + (row.disabled ? "-1" : "0") + '" aria-pressed="' + on +
        '" data-testid="judge-row-' + esc(row.id) + '" data-id="' + esc(row.id) + '" data-disabled="' + row.disabled +
        '" style="--k:' + f.color + '">' +
        '<input class="sr" type="checkbox" tabindex="-1" data-testid="judge-check-' + esc(row.id) + '"' + (on ? " checked" : "") + (row.disabled ? " disabled" : "") + ">" +
        '<div class="row1"><span class="name">' + esc(displayName(row)) + '</span><span class="dot"></span></div>' +
        '<span class="model">' + esc(row.model) + "</span>" +
        (reason ? '<span class="reason">' + esc(reason) + "</span>" : "") +
        '<div class="tags">' + tags + "</div></div>";
    }).join("");
    return '<div class="period" data-family="' + esc(key) + '">' +
      '<div class="fam' + (out ? " out" : "") + '" style="--k:' + f.color + '">' +
      '<span class="sym">' + esc(f.sym) + "</span>" +
      '<span class="nm">' + esc(f.name) + "</span>" +
      (out ? '<span class="why">' + esc(out) + "</span>" : "") +
      "</div>" +
      '<div class="judges">' + tiles + "</div></div>";
  }).join("");
  document.getElementById("rows").innerHTML = html;
  renderSlots("slots", false);
  updateDock();
}

function renderSlots(targetId, withModel) {
  var out = "";
  for (var i = 0; i < 3; i++) {
    var pick = selected[i];
    if (!pick) { out += '<div class="slot"><span class="n">0' + (i + 1) + '</span><span class="s"></span></div>'; continue; }
    var row = rowById(pick.id);
    var f = fam(row.family);
    out += '<div class="slot full" style="--k:' + f.color + '" title="' + esc(displayName(row)) + '">' +
      '<span class="n">0' + (i + 1) + '</span><span class="s">' + esc(f.sym) + "</span>" +
      (withModel ? '<span class="m">' + esc(displayName(row)) + "</span>" : "") + "</div>";
  }
  document.getElementById(targetId).innerHTML = out;
}

function updateDock() {
  var msg = document.getElementById("msg");
  var btn = document.getElementById("confirmBtn");
  var families = {};
  selected.forEach(function (s) { families[rowById(s.id).family] = true; });
  var ready = !expired && selected.length === 3 && Object.keys(families).length === 3;
  btn.disabled = !ready;
  msg.className = "";
  if (expired) { msg.className = "err"; msg.textContent = "This link has expired. Ask your agent for a fresh one."; return; }
  msg.innerHTML = ready
    ? "<b>Ready.</b> " + selected.map(function (s) { return esc(displayName(rowById(s.id))); }).join(" · ")
    : "Pick <b>" + (3 - selected.length) + " more</b> from different vendors (" + selected.length + "/3).";
}

function toggle(id) {
  var row = rowById(id);
  if (!row || expired) return;
  var idx = selected.findIndex(function (s) { return s.id === id; });
  if (idx >= 0) { selected.splice(idx, 1); renderRows(); return; }
  if (row.disabled || selected.length >= 3) return;
  if (selected.some(function (s) { return rowById(s.id).family === row.family; })) return;
  selected.push({ id: id, effort: defaultEffort(row) });
  renderRows();
}

var rowsEl = document.getElementById("rows");
rowsEl.addEventListener("click", function (e) {
  if (e.target.tagName === "SELECT" || e.target.tagName === "OPTION") return;
  var tile = e.target.closest(".j");
  if (tile) toggle(tile.dataset.id);
});
rowsEl.addEventListener("keydown", function (e) {
  if (e.key !== "Enter" && e.key !== " ") return;
  var tile = e.target.closest(".j");
  if (!tile || e.target.tagName === "SELECT") return;
  e.preventDefault();
  toggle(tile.dataset.id);
});
rowsEl.addEventListener("change", function (e) {
  if (e.target.tagName !== "SELECT") return;
  var id = e.target.closest(".j").dataset.id;
  var pick = selected.find(function (s) { return s.id === id; });
  if (pick) pick.effort = e.target.value;
});

document.getElementById("autoFillBtn").addEventListener("click", function () {
  selected = recommendedPicks();
  renderRows();
});

document.getElementById("confirmBtn").addEventListener("click", async function () {
  var btn = document.getElementById("confirmBtn");
  var msg = document.getElementById("msg");
  btn.disabled = true;
  var original = btn.textContent;
  btn.textContent = "Confirming…";
  var res, text;
  try {
    res = await fetch("/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: MODEL.token, judges: selected })
    });
    text = await res.text();
  } catch (err) {
    msg.className = "err";
    msg.textContent = "Network error: the picker server is unreachable.";
    btn.disabled = false;
    btn.textContent = original;
    return;
  }
  if (!res.ok) {
    msg.className = "err";
    msg.textContent = text || "Confirm refused (" + res.status + ").";
    btn.disabled = false;
    btn.textContent = original;
    return;
  }
  renderSlots("doneSlots", true);
  document.body.classList.add("sent");
});

function tick() {
  var left = Math.max(0, Date.parse(MODEL.expires_at) - Date.now());
  var m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
  document.getElementById("clockValue").textContent = m + ":" + (s < 10 ? "0" : "") + s;
  document.getElementById("clock").className = "clock" + (left < 120000 ? " low" : "");
  if (left === 0 && !expired) { expired = true; updateDock(); }
}
tick();
setInterval(tick, 1000);
renderRows();
</script>
</body>
</html>`;
}
