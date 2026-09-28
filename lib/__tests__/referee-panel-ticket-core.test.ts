// Titration MCP — referee-panel-ticket-core unit test (no network, no DB, no model — $0).
// Pins mint plan, 720s expiry, no-revive of pending, confirmed-outlives-TTL,
// same-panel idempotent confirm, different-panel conflict, illegal ClaimPlan
// refuse, and parseConfirmedPanelSnapshot fail-loud. Injected now only.
// Mirrors referee-catalog-core.test.ts (check/total/failures + process.exit).
//
// The confirmed snapshot shape — 3
// `resolved` judges ({id, family, door, model, effort}) + `selection`
// {receipt_id, confirmed_at, player_family}, no catalog `picks`/`display`
// cards, no buildPickerUrl (the local picker builds its own
// http://127.0.0.1:<port>/?token=<token> URL in server/picker/server.ts).
// Run: npx tsx lib/__tests__/referee-panel-ticket-core.test.ts

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { REFEREE_TICKET_TTL_SECONDS } from "../referee-catalog-core";
import type { RefereeRunBudget } from "../referee-run-budget-core";
import {
  digestSecretHex,
  expiresAtFrom,
  parseConfirmedPanelSnapshot,
  planClaim,
  planConfirm,
  planMint,
  REFEREE_STATUS_WAIT_MAX_SECONDS,
  refereeStatusWaitMs,
  statusAt,
  type ConfirmedPanelJudge,
  type ConfirmedPanelSnapshot,
  type RefereePanelTicketRecord,
} from "../referee-panel-ticket-core";

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
const corePath = join(here, "..", "referee-panel-ticket-core.ts");
const coreSource = readFileSync(corePath, "utf8");

const CREATED = "2026-08-26T00:00:00.000Z";
const AT_60S = "2026-08-26T00:01:00.000Z";
const AT_90S = "2026-08-26T00:01:30.000Z";
const AT_719S = "2026-08-26T00:11:59.000Z";
const AT_720S = "2026-08-26T00:12:00.000Z";
const AT_800S = "2026-08-26T00:13:20.000Z";
const SECRET_A = "picker-secret-alpha";
const SECRET_B = "picker-secret-bravo";

function confirmedJudge(
  id: string,
  family: ConfirmedPanelJudge["family"],
  effort: ConfirmedPanelJudge["effort"],
  door: ConfirmedPanelJudge["door"] = "openrouter",
  model?: string,
): ConfirmedPanelJudge {
  return { id, family, door, model: model ?? id, effort };
}

function snapshot(overrides?: {
  confirmed_at?: string;
  secondId?: string;
  secondFamily?: ConfirmedPanelJudge["family"];
  secondEffort?: ConfirmedPanelJudge["effort"];
  run_budget?: RefereeRunBudget;
  player_family?: ConfirmedPanelJudge["family"] | null;
}): ConfirmedPanelSnapshot {
  const secondId = overrides?.secondId ?? "openai/gpt-5.6-sol";
  const secondFamily = overrides?.secondFamily ?? "openai";
  const secondEffort = overrides?.secondEffort ?? "medium";
  return {
    resolved: [
      confirmedJudge("anthropic/claude-opus-5", "anthropic", "low"),
      confirmedJudge(secondId, secondFamily, secondEffort),
      confirmedJudge("x-ai/grok-4.6", "x-ai", "high"),
    ],
    selection: {
      receipt_id: "receipt-1",
      confirmed_at: overrides?.confirmed_at ?? AT_60S,
      player_family: overrides?.player_family ?? null,
    },
    ...(overrides?.run_budget != null ? { run_budget: overrides.run_budget } : {}),
  };
}

function pendingA(): RefereePanelTicketRecord {
  return planMint({ secret: SECRET_A, created_at: CREATED });
}

function pendingB(): RefereePanelTicketRecord {
  return planMint({ secret: SECRET_B, created_at: CREATED });
}

function confirmedAt(ticket: RefereePanelTicketRecord, now: string): RefereePanelTicketRecord {
  const plan = planConfirm(ticket, snapshot({ confirmed_at: now }), now);
  if (!plan.ok || plan.kind !== "apply") {
    throw new Error(`expected apply confirm, got ${JSON.stringify(plan)}`);
  }
  return plan.ticket;
}

check("REFEREE_TICKET_TTL_SECONDS imported from catalog-core is 720", REFEREE_TICKET_TTL_SECONDS === 720);

const minted = planMint({ secret: SECRET_A, created_at: CREATED });
const expectedDigest = createHash("sha256").update(SECRET_A, "utf8").digest("hex");
check("mint plan status is pending", minted.status === "pending");
check("mint plan digest is SHA-256 hex of the secret", minted.digest_hex === expectedDigest);
check("digestSecretHex matches mint digest", digestSecretHex(SECRET_A) === expectedDigest);
check("mint plan does not carry the plaintext secret", !("secret" in minted));
check("mint plan digest is not the plaintext secret", minted.digest_hex !== SECRET_A);
check(
  "mint plan expires_at is created_at + 720s",
  minted.expires_at === "2026-08-26T00:12:00.000Z"
    && minted.created_at === CREATED,
);
check(
  "mint plan pending row is clean",
  minted.consumed_at === null
    && minted.confirmation_snapshot === null
    && minted.establish_claimed_at === null
    && minted.used_for_baseline_id === null,
);
check(
  "expiresAtFrom default ttl is 720s",
  expiresAtFrom(CREATED) === "2026-08-26T00:12:00.000Z",
);
check(
  "expiresAtFrom honors injected ttlSeconds",
  expiresAtFrom(CREATED, 60) === "2026-08-26T00:01:00.000Z",
);

check(
  "statusAt pending just before 720s stays pending",
  statusAt(pendingA(), AT_719S) === "pending",
);
check(
  "statusAt pending at exactly 720s is expired",
  statusAt(pendingA(), AT_720S) === "expired",
);
check(
  "statusAt pending after 720s is expired",
  statusAt(pendingA(), AT_800S) === "expired",
);

const confirmExpired = planConfirm(pendingA(), snapshot(), AT_720S);
check(
  "planConfirm refuses pending at 720s (no revive)",
  confirmExpired.ok === false && confirmExpired.kind === "refuse" && confirmExpired.code === "expired",
);
const storedExpired: RefereePanelTicketRecord = {
  ...pendingA(),
  status: "expired",
};
check("statusAt stored expired does not revive before ttl", statusAt(storedExpired, AT_60S) === "expired");
const reviveStored = planConfirm(storedExpired, snapshot(), AT_60S);
check(
  "planConfirm refuses stored expired even before ttl (no revive)",
  reviveStored.ok === false && reviveStored.kind === "refuse" && reviveStored.code === "expired",
);
const claimExpiredPending = planClaim(pendingA(), AT_720S);
check(
  "planClaim refuses pending past ttl",
  claimExpiredPending.ok === false && claimExpiredPending.code === "expired",
);

const confirmed = confirmedAt(pendingA(), AT_60S);
check("planConfirm apply sets status confirmed", confirmed.status === "confirmed");
check("planConfirm apply stamps consumed_at to injected now", confirmed.consumed_at === AT_60S);
check("statusAt confirmed at 800s still confirmed (outlives ttl)", statusAt(confirmed, AT_800S) === "confirmed");
const claimAfterTtl = planClaim(confirmed, AT_800S);
check(
  "planClaim of confirmed after ttl succeeds",
  claimAfterTtl.ok === true && claimAfterTtl.ok && claimAfterTtl.ticket.establish_claimed_at === AT_800S,
);
const confirmAfterTtl = planConfirm(confirmed, snapshot({ confirmed_at: AT_60S }), AT_800S);
check(
  "same-panel confirm after ttl is idempotent (confirmed outlives)",
  confirmAfterTtl.ok === true && confirmAfterTtl.kind === "idempotent",
);

const firstConfirm = planConfirm(pendingA(), snapshot({ confirmed_at: AT_60S }), AT_60S);
if (!firstConfirm.ok || firstConfirm.kind !== "apply") {
  throw new Error("expected first confirm apply");
}
const samePanel = planConfirm(firstConfirm.ticket, snapshot({ confirmed_at: AT_90S }), AT_90S);
check(
  "same-panel confirm is idempotent 200",
  samePanel.ok === true && samePanel.kind === "idempotent",
);
check(
  "idempotent confirm does not change consumed_at or snapshot confirmed_at",
  samePanel.ok === true
    && samePanel.kind === "idempotent"
    && samePanel.ticket.consumed_at === AT_60S
    && samePanel.ticket.confirmation_snapshot?.selection.confirmed_at === AT_60S,
);
const differentPanel = planConfirm(
  firstConfirm.ticket,
  snapshot({
    confirmed_at: AT_90S,
    secondId: "google/gemini-3.7-flash",
    secondFamily: "google",
    secondEffort: "high",
  }),
  AT_90S,
);
check(
  "different-panel confirm conflicts and does not mutate",
  differentPanel.ok === false && differentPanel.kind === "conflict" && differentPanel.code === "different_panel",
);
check(
  "conflict leaves the original confirmed panel in place",
  firstConfirm.ticket.confirmation_snapshot?.resolved[1]?.id === "openai/gpt-5.6-sol",
);

const firstBudget = planConfirm(
  pendingA(),
  snapshot({ confirmed_at: AT_60S, run_budget: 2 }),
  AT_60S,
);
if (!firstBudget.ok || firstBudget.kind !== "apply") {
  throw new Error("expected first budget confirm apply");
}
const budgetResend = planConfirm(
  firstBudget.ticket,
  snapshot({ confirmed_at: AT_90S, run_budget: 10 }),
  AT_90S,
);
check(
  "planConfirm same picks run_budget 2 then 10 is idempotent",
  budgetResend.ok === true && budgetResend.kind === "idempotent",
  JSON.stringify(budgetResend),
);
check(
  "idempotent re-confirm keeps stored run_budget 2 (not 10)",
  firstBudget.ticket.confirmation_snapshot?.run_budget === 2
    && budgetResend.ok === true
    && budgetResend.kind === "idempotent"
    && budgetResend.ticket.confirmation_snapshot?.run_budget === 2,
);
check(
  "budget-only re-confirm is not different_panel",
  !(budgetResend.ok === false && "kind" in budgetResend && budgetResend.kind === "conflict"),
);

const claimPending = planClaim(pendingA(), AT_60S);
check(
  "planClaim refuses pending (not_confirmed)",
  claimPending.ok === false && claimPending.code === "not_confirmed",
);
const claimOnce = planClaim(firstConfirm.ticket, AT_90S);
check("planClaim of confirmed unclaimed succeeds", claimOnce.ok === true);
const claimTwice = planClaim(
  claimOnce.ok ? claimOnce.ticket : firstConfirm.ticket,
  AT_90S,
);
check(
  "planClaim of already-claimed ticket refuses used",
  claimTwice.ok === false && claimTwice.code === "used",
);
const frozen: RefereePanelTicketRecord = claimOnce.ok
  ? { ...claimOnce.ticket, used_for_baseline_id: "11111111-1111-4111-8111-111111111111" }
  : firstConfirm.ticket;
const claimFrozen = planClaim(frozen, AT_90S);
check(
  "planClaim of frozen ticket refuses used",
  claimFrozen.ok === false && claimFrozen.code === "used",
);

const ticketA = pendingA();
const ticketB = pendingB();
const confirmA = planConfirm(ticketA, snapshot({ confirmed_at: AT_60S }), AT_60S);
check(
  "confirm A does not consume independent ticket B",
  confirmA.ok === true
    && confirmA.kind === "apply"
    && statusAt(ticketB, AT_60S) === "pending"
    && ticketB.confirmation_snapshot === null
    && ticketA.digest_hex !== ticketB.digest_hex,
);

const parsed = parseConfirmedPanelSnapshot(snapshot());
check(
  "parseConfirmedPanelSnapshot accepts a valid snapshot",
  parsed.resolved.length === 3
    && parsed.selection.receipt_id === "receipt-1"
    && parsed.selection.player_family === null,
);
check(
  "legacy snapshot without run_budget still parses",
  parsed.run_budget === undefined && !("run_budget" in parsed),
);
check(
  "legacy snapshot carries no corrupt marker",
  !("run_budget_corrupt" in parsed),
);
check(
  "snapshot with run_budget 5 keeps 5",
  parseConfirmedPanelSnapshot(snapshot({ run_budget: 5 })).run_budget === 5,
);
check(
  "snapshot with run_budget 10 keeps 10",
  parseConfirmedPanelSnapshot({ ...snapshot(), run_budget: 10 }).run_budget === 10,
);
check(
  "snapshot with run_budget 7 keeps 7",
  parseConfirmedPanelSnapshot({ ...snapshot(), run_budget: 7 }).run_budget === 7,
);
check(
  "snapshot with invalid run_budget 11 still parses and omits the field",
  (() => {
    const err = throws(() => parseConfirmedPanelSnapshot({ ...snapshot(), run_budget: 11 }));
    if (err !== null) return false;
    const row = parseConfirmedPanelSnapshot({ ...snapshot(), run_budget: 11 });
    return row.run_budget === undefined && !("run_budget" in row);
  })(),
);
check(
  "invalid stored run_budget is marked corrupt, distinguishable from legacy",
  (() => {
    const row = parseConfirmedPanelSnapshot({ ...snapshot(), run_budget: 20 });
    return row.run_budget_corrupt === true && !("run_budget" in row);
  })(),
);
check(
  "corrupt marker survives re-parse of an already-parsed snapshot",
  (() => {
    const once = parseConfirmedPanelSnapshot({ ...snapshot(), run_budget: "5" });
    const twice = parseConfirmedPanelSnapshot(once);
    return once.run_budget_corrupt === true && twice.run_budget_corrupt === true;
  })(),
);
check(
  "valid run_budget never carries the corrupt marker",
  !("run_budget_corrupt" in parseConfirmedPanelSnapshot({ ...snapshot(), run_budget: 5 })),
);
check("parseConfirmedPanelSnapshot rejects null", throws(() => parseConfirmedPanelSnapshot(null)) !== null);
check("parseConfirmedPanelSnapshot rejects a string", throws(() => parseConfirmedPanelSnapshot("nope")) !== null);
check("parseConfirmedPanelSnapshot rejects an array", throws(() => parseConfirmedPanelSnapshot([])) !== null);
check("parseConfirmedPanelSnapshot rejects empty object", throws(() => parseConfirmedPanelSnapshot({})) !== null);
check(
  "parseConfirmedPanelSnapshot rejects a two-judge panel",
  (throws(() => parseConfirmedPanelSnapshot({
    ...snapshot(),
    resolved: snapshot().resolved.slice(0, 2),
  })) ?? "").includes("triple"),
);
check(
  "parseConfirmedPanelSnapshot accepts a claude-door judge with its own model id",
  parseConfirmedPanelSnapshot({
    ...snapshot(),
    resolved: [
      confirmedJudge("claude", "anthropic", "high", "claude", "claude-opus-5"),
      snapshot().resolved[1],
      snapshot().resolved[2],
    ],
  }).resolved[0]?.door === "claude",
);
check(
  "parseConfirmedPanelSnapshot rejects an unknown door",
  throws(() => parseConfirmedPanelSnapshot({
    ...snapshot(),
    resolved: [
      { ...snapshot().resolved[0], door: "bedrock" },
      snapshot().resolved[1],
      snapshot().resolved[2],
    ],
  })) !== null,
);
check(
  "parseConfirmedPanelSnapshot rejects duplicate resolved ids",
  throws(() => parseConfirmedPanelSnapshot({
    ...snapshot(),
    resolved: [
      snapshot().resolved[0],
      snapshot().resolved[0],
      snapshot().resolved[2],
    ],
  })) !== null,
);
check(
  "parseConfirmedPanelSnapshot rejects a non-curated family",
  throws(() => parseConfirmedPanelSnapshot({
    ...snapshot(),
    resolved: [
      { ...snapshot().resolved[0], family: "not-a-family" },
      snapshot().resolved[1],
      snapshot().resolved[2],
    ],
  })) !== null,
);
check(
  "parseConfirmedPanelSnapshot accepts a curated player_family",
  parseConfirmedPanelSnapshot({
    ...snapshot(),
    selection: { ...snapshot().selection, player_family: "openai" },
  }).selection.player_family === "openai",
);
check(
  "parseConfirmedPanelSnapshot rejects a garbage player_family",
  throws(() => parseConfirmedPanelSnapshot({
    ...snapshot(),
    selection: { ...snapshot().selection, player_family: "not-a-family" },
  })) !== null,
);
check(
  "parseConfirmedPanelSnapshot rejects a missing selection.receipt_id",
  throws(() => parseConfirmedPanelSnapshot({
    ...snapshot(),
    selection: { confirmed_at: AT_60S, player_family: null },
  })) !== null,
);

check("digestSecretHex refuses an empty secret", throws(() => digestSecretHex("")) !== null);
check("planMint refuses an empty secret", throws(() => planMint({ secret: "", created_at: CREATED })) !== null);
check("expiresAtFrom refuses Date.parse garbage", throws(() => expiresAtFrom("not-a-date")) !== null);
check("expiresAtFrom refuses non-positive ttl", throws(() => expiresAtFrom(CREATED, 0)) !== null);

check(
  "core has no Date.now()",
  !/\bDate\.now\s*\(/.test(coreSource),
);
check(
  "core has no Math.random()",
  !/\bMath\.random\s*\(/.test(coreSource),
);
check(
  "core hashes via node:crypto createHash (not an injected digest-only seam)",
  /from\s+["']node:crypto["']/.test(coreSource) && /createHash/.test(coreSource),
);
check(
  "core imports REFEREE_TICKET_TTL_SECONDS from catalog-core",
  coreSource.includes("REFEREE_TICKET_TTL_SECONDS")
    && /from\s+["']\.\/referee-catalog-core["']/.test(coreSource),
);
const recordInterface = coreSource.slice(
  coreSource.indexOf("export interface RefereePanelTicketRecord"),
  coreSource.indexOf("export type PendingTicketRecord"),
);
check(
  "RefereePanelTicketRecord has digest_hex and no secret property",
  recordInterface.includes("digest_hex:")
    && !recordInterface.includes("secret:")
    && recordInterface.includes("expires_at:")
    && recordInterface.includes("consumed_at:")
    && recordInterface.includes("confirmation_snapshot:")
    && recordInterface.includes("establish_claimed_at:")
    && recordInterface.includes("used_for_baseline_id:"),
);
check(
  "core does not import prompt/corpus/provider-key/judge modules",
  !/from\s+["'][^"']*(verify|judge|provider-credentials|provider-credential-core|goal-titrate)["']/.test(coreSource)
    && !/PromptText|CorpusCase|OpenRouterApiKey|ProviderApiKey/.test(coreSource),
);
check(
  "core has no fs / fetch / network imports",
  !/from\s+["']node:(fs|http|https|net|dgram|dns)["']/.test(coreSource)
    && !/\bfetch\s*\(/.test(coreSource),
);
const samePanelSrc = coreSource.slice(
  coreSource.indexOf("function samePanel("),
  coreSource.indexOf("function assertTicketRecord"),
);
check(
  "samePanel compares resolved id/family/door/model/effort (ignores run_budget)",
  samePanelSrc.includes("a.id !== b.id")
    && samePanelSrc.includes("a.family !== b.family")
    && samePanelSrc.includes("a.door !== b.door")
    && samePanelSrc.includes("a.model !== b.model")
    && samePanelSrc.includes("a.effort !== b.effort")
    && !samePanelSrc.includes("run_budget"),
);

// ── referee_panel_status long-poll budget ──
check(
  "omitted wait_seconds answers now; numbers clamp to the 50s ceiling; fractions keep ms",
  REFEREE_STATUS_WAIT_MAX_SECONDS === 50
    && refereeStatusWaitMs(undefined) === 0
    && refereeStatusWaitMs(0) === 0
    && refereeStatusWaitMs(25) === 25_000
    && refereeStatusWaitMs(50) === 50_000
    && refereeStatusWaitMs(60) === REFEREE_STATUS_WAIT_MAX_SECONDS * 1000
    && refereeStatusWaitMs(2.5) === 2_500,
);
check(
  "wait_seconds that is not a non-negative finite number is refused, not guessed",
  refereeStatusWaitMs(-1) === null
    && refereeStatusWaitMs("25") === null
    && refereeStatusWaitMs(Number.NaN) === null
    && refereeStatusWaitMs(Number.POSITIVE_INFINITY) === null
    && refereeStatusWaitMs(null) === null
    && refereeStatusWaitMs(true) === null,
);

console.log(`${failures === 0 ? "PASS" : "FAIL"} ${total - failures}/${total}`);
process.exit(failures === 0 ? 0 : 1);
