// Titration MCP — local referee-panel picker server (I/O only).
//
// A one-shot HTTP server on 127.0.0.1, bound BEFORE the picker URL is ever
// minted (no probe race). Every DECISION (415/403/409/410/400/200) is made by
// the pure lib/picker-core.ts; this module owns the socket, the port bind, the
// OS browser-open call, and the ticket-table write (lib/referee-panel-ticket.ts's
// `confirm`). A second `mintPicker` call while a previous ticket's picker is
// still open REUSES the already-bound port/server (swaps in the new session)
// instead of binding a second one; the server shuts itself down after an
// accepted confirm or the ticket's own 12-minute TTL, whichever comes first.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildAllowedOrigins,
  buildPickerFontCss,
  buildPickerPageModel,
  evaluateConfirmRequest,
  evaluateGetRequest,
  isJsonContentType,
  renderExpiredHtml,
  renderPickerHtml,
  type PickerPageModel,
} from "../../lib/picker-core";
import type { CliAvailability, CuratedFamily, Roster } from "../../lib/judges-roster-core";
import { confirm as confirmTicketIO, type RefereePanelTicketRow } from "../../lib/referee-panel-ticket";
import type { ConfirmedPanelSnapshot } from "../../lib/referee-panel-ticket-core";

const PORT_RANGE_START = 51773;
const PORT_RANGE_TRIES = 25;
const MAX_BODY_BYTES = 1_000_000;
/** The server shuts down shortly after an accepted confirm, so the 200 response has time to flush. */
const POST_CONFIRM_SHUTDOWN_DELAY_MS = 200;

// The deck's typefaces, read once from ./fonts and inlined into every page the
// picker serves. Fail-open: an unreadable file just leaves that face on the
// system fallback stack; the picker never fails for want of a font.
let fontCssCache: string | null = null;
function pickerFontCss(): string {
  if (fontCssCache !== null) return fontCssCache;
  const read = (name: string): string | undefined => {
    try {
      return readFileSync(fileURLToPath(new URL(`./fonts/${name}`, import.meta.url))).toString("base64");
    } catch (err) {
      console.error(`[picker] font ${name} unavailable, using the system fallback: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  };
  fontCssCache = buildPickerFontCss({
    sans: read("instrument-sans-latin.woff2"),
    mono: read("jetbrains-mono-latin.woff2"),
    serifItalic: read("instrument-serif-italic-latin.woff2"),
  });
  return fontCssCache;
}

export type PickerBrowserOpener = (url: string) => void;

export type ConfirmTicketPort = (input: {
  tenantSlug: string;
  id: string;
  snapshot: ConfirmedPanelSnapshot;
  now: string;
}) => Promise<RefereePanelTicketRow>;

export interface MintPickerInput {
  readonly tenantSlug: string;
  readonly ticketId: string;
  /**
   * The SAME secret already minted into the DB ticket (mintPending's `secret`)
   * — dual-purpose by design: one random value is both the ticket's digest
   * source and this picker's local HTTP auth token, so there is only one
   * secret to keep out of logs, not two.
   */
  readonly token: string;
  readonly expiresAt: string;
  readonly playerModel: string;
  readonly playerFamily: CuratedFamily;
  /** The model the system under test calls, if known; its vendor is kept off the panel. */
  readonly sutModel?: string | null;
  readonly sutFamily?: CuratedFamily | null;
  readonly roster: Roster;
  readonly available: CliAvailability;
  readonly hasOpenRouterKey: boolean;
}

export interface MintPickerPorts {
  readonly confirmTicket?: ConfirmTicketPort;
  readonly openBrowser?: PickerBrowserOpener;
  readonly now?: () => number;
}

export interface MintPickerResult {
  readonly url: string;
  readonly port: number;
}

interface PickerSession {
  token: string;
  tenantSlug: string;
  ticketId: string;
  expiresAtIso: string;
  playerFamily: string;
  sutModel: string | null;
  sutFamily: string | null;
  roster: Roster;
  pageModel: PickerPageModel;
  confirmTicket: ConfirmTicketPort;
  now: () => number;
  accepted: boolean;
  inFlight: boolean;
  ttlTimer: ReturnType<typeof setTimeout> | null;
}

interface ActivePickerServer {
  server: Server;
  port: number;
  allowedOrigins: readonly string[];
  session: PickerSession;
}

// Module-level singleton: one desktop tool, one picker session at a time. A
// mint while a previous session is still open reuses this same server.
let active: ActivePickerServer | null = null;

function buildUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/?token=${token}`;
}

// Windows: `cmd /c start "" "<url>"` — the empty "" is the window-title arg
// `start` expects before the URL; both are quoted so a URL with an `&` (a
// bare 16-byte hex token never has one, but this stays correct regardless)
// can't be split by cmd's own argument parsing. macOS: `open <url>`.
// Linux: `xdg-open <url>`. Best-effort only — a failed/missing opener
// only warns; the caller still gets picker_url back and can open it by hand.
function defaultOpenBrowser(url: string): void {
  try {
    const child = process.platform === "win32"
      ? spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true })
      : process.platform === "darwin"
        ? spawn("open", [url], { detached: true, stdio: "ignore" })
        : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    child.on("error", (err) => {
      console.error(`[titration-picker] browser open failed (open the URL manually): ${err instanceof Error ? err.message : String(err)}`);
    });
    child.unref();
  } catch (err) {
    console.error(`[titration-picker] browser open failed (open the URL manually): ${err instanceof Error ? err.message : String(err)}`);
  }
}

function closeActiveServer(): Promise<void> {
  if (!active) return Promise.resolve();
  const current = active;
  active = null;
  if (current.session.ttlTimer) clearTimeout(current.session.ttlTimer);
  return new Promise((resolve) => {
    current.server.close(() => resolve());
    // http.Server#close waits for in-flight connections to end; a picker
    // client that leaves its tab open with a keep-alive connection must never
    // block shutdown indefinitely.
    current.server.closeAllConnections?.();
  });
}

/** Test/shutdown helper: closes whatever picker server is currently listening, if any. Idempotent. */
export async function closeActivePicker(): Promise<void> {
  await closeActiveServer();
}

function scheduleTtlShutdown(session: PickerSession): void {
  const ms = Math.max(0, Date.parse(session.expiresAtIso) - session.now());
  session.ttlTimer = setTimeout(() => {
    if (!session.accepted) void closeActiveServer();
  }, ms);
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    let tooBig = false;
    req.on("data", (chunk: Buffer) => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on("end", () => {
      if (tooBig) reject(new Error("body too large"));
      else resolve(raw);
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  res.end(body);
}

function headerString(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

async function handleConfirm(current: ActivePickerServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { session } = current;
  // First gate: cheap rejection before spending time reading the body.
  if (session.accepted || session.inFlight) {
    send(res, 409, "text/plain", "a pick was already recorded for this ticket");
    return;
  }
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    send(res, 413, "text/plain", "request body too large");
    return;
  }
  // Second gate + claim, in one synchronous step (no `await` between the check
  // and the set) — closes the race between two POSTs that both passed the
  // first gate while their bodies were still in flight.
  if (session.accepted || session.inFlight) {
    send(res, 409, "text/plain", "a pick was already recorded for this ticket");
    return;
  }
  session.inFlight = true;

  const contentType = headerString(req.headers["content-type"]);
  let parsedBody: unknown = null;
  let bodyParseError = false;
  if (isJsonContentType(contentType)) {
    try {
      parsedBody = raw.length ? JSON.parse(raw) : {};
    } catch {
      bodyParseError = true;
    }
  }

  const outcome = evaluateConfirmRequest({
    contentType,
    origin: headerString(req.headers.origin),
    allowedOrigins: current.allowedOrigins,
    rawBody: parsedBody,
    bodyParseError,
    expectedToken: session.token,
    alreadyAccepted: false,
    nowMs: session.now(),
    expiresAtIso: session.expiresAtIso,
    roster: session.roster,
    playerFamily: session.playerFamily,
    sutFamily: session.sutFamily,
    sutModel: session.sutModel,
  });

  if (outcome.status !== 200) {
    session.inFlight = false; // refused, not accepted — release the gate
    send(res, outcome.status, "text/plain", outcome.message);
    return;
  }

  try {
    const nowIso = new Date(session.now()).toISOString();
    const snapshot: ConfirmedPanelSnapshot = {
      resolved: outcome.judges,
      selection: {
        receipt_id: session.ticketId,
        confirmed_at: nowIso,
        player_family: session.playerFamily as CuratedFamily,
      },
    };
    await session.confirmTicket({
      tenantSlug: session.tenantSlug,
      id: session.ticketId,
      snapshot,
      now: nowIso,
    });
  } catch (err) {
    session.inFlight = false;
    send(res, 500, "text/plain", `could not record the pick: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  session.accepted = true;
  send(res, 200, "application/json", JSON.stringify({ ok: true }));
  setTimeout(() => { void closeActiveServer(); }, POST_CONFIRM_SHUTDOWN_DELAY_MS);
}

function makeRequestHandler(getActive: () => ActivePickerServer | null) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const current = getActive();
    if (!current) {
      send(res, 404, "text/plain", "not found");
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/") {
      const outcome = evaluateGetRequest({
        token: url.searchParams.get("token"),
        expectedToken: current.session.token,
        nowMs: current.session.now(),
        expiresAtIso: current.session.expiresAtIso,
      });
      if (outcome === "not_found") {
        send(res, 404, "text/plain", "not found");
        return;
      }
      if (outcome === "expired") {
        send(res, 200, "text/html; charset=utf-8", renderExpiredHtml({ fontCss: pickerFontCss() }));
        return;
      }
      send(res, 200, "text/html; charset=utf-8", renderPickerHtml(current.session.pageModel, { fontCss: pickerFontCss() }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/confirm") {
      await handleConfirm(current, req, res);
      return;
    }

    send(res, 404, "text/plain", "not found");
  };
}

function bindServer(getActive: () => ActivePickerServer | null): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const handler = makeRequestHandler(getActive);
    const server = createServer((req, res) => {
      void handler(req, res);
    });
    let attempt = 0;
    function tryListen(port: number): void {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && attempt < PORT_RANGE_TRIES) {
          attempt++;
          tryListen(port + 1);
        } else {
          reject(err);
        }
      };
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", onError);
        const addr = server.address();
        const boundPort = addr && typeof addr === "object" ? addr.port : port;
        resolve({ server, port: boundPort });
      });
    }
    tryListen(PORT_RANGE_START);
  });
}

// Bind BEFORE the URL is ever minted — the port assignment below happens only
// after bindServer's listen callback has already fired, so the returned URL
// always names a port that is genuinely already accepting connections (no
// probe race).
export async function mintPicker(input: MintPickerInput, ports: MintPickerPorts = {}): Promise<MintPickerResult> {
  const now = ports.now ?? Date.now;
  const confirmTicket = ports.confirmTicket ?? confirmTicketIO;
  const openBrowser = ports.openBrowser ?? defaultOpenBrowser;
  const token = input.token;
  const pageModel = buildPickerPageModel({
    ticketId: input.ticketId,
    token,
    expiresAt: input.expiresAt,
    playerModel: input.playerModel,
    playerFamily: input.playerFamily,
    sutModel: input.sutModel ?? null,
    sutFamily: input.sutFamily ?? null,
    roster: input.roster,
    available: input.available,
    hasOpenRouterKey: input.hasOpenRouterKey,
  });
  const session: PickerSession = {
    token,
    tenantSlug: input.tenantSlug,
    ticketId: input.ticketId,
    expiresAtIso: input.expiresAt,
    playerFamily: input.playerFamily,
    sutModel: input.sutModel ?? null,
    sutFamily: input.sutFamily ?? null,
    roster: input.roster,
    pageModel,
    confirmTicket,
    now,
    accepted: false,
    inFlight: false,
    ttlTimer: null,
  };

  if (active) {
    // Reuse: a previous ticket's picker is still open and unconfirmed — swap
    // in the new session on the already-bound port instead of a second bind.
    if (active.session.ttlTimer) clearTimeout(active.session.ttlTimer);
    active.session = session;
    scheduleTtlShutdown(session);
    const url = buildUrl(active.port, token);
    openBrowser(url);
    return { url, port: active.port };
  }

  const { server, port } = await bindServer(() => active);
  active = { server, port, allowedOrigins: buildAllowedOrigins(port), session };
  scheduleTtlShutdown(session);
  const url = buildUrl(port, token);
  openBrowser(url);
  return { url, port };
}
