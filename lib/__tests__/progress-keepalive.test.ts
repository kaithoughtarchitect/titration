// Titration MCP — keepalive: throttled MCP progress during long grading (no network, $0).
//
// Sync verdict calls landed 6 of 13 attempts: the timeouts were fixed
// client-side, but long calls still risked an idle client giving up mid-grade
// with no traffic while the panel runs. buildProgressKeepalive is the fix's core: when
// the client supplied a progressToken, every runPanel row-call ticks it and it emits a
// notifications/progress at most once per interval, keeping the response stream warm.
//
// Run: npx tsx lib/__tests__/progress-keepalive.test.ts

export {}; // top-level await needs module scope; this file has only dynamic imports

process.env.TITRATION_DATABASE_URL ??= "postgres://127.0.0.1:1/titration-offline-import-only";
const { buildProgressKeepalive, withGradingKeepalive } = await import("../../server/mcp-server");

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail = "") {
  total++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}

type Sent = { method: string; params: { progressToken: string | number; progress: number } };

{
  check("no progressToken → no keepalive (spec: progress only when the client asked)", buildProgressKeepalive(undefined, async () => {}) === undefined);
  check("no sendNotification port → no keepalive", buildProgressKeepalive("tok", undefined) === undefined);
}

{
  let clock = 0;
  const sent: Sent[] = [];
  const tick = buildProgressKeepalive("tok-1", async (n) => { sent.push(n); }, 10_000, () => clock)!;
  check("keepalive exists when token + port are present", typeof tick === "function");

  await tick(); // t=0 — first provider call sends immediately
  check("first tick notifies immediately", sent.length === 1 && sent[0]!.params.progress === 1 && sent[0]!.params.progressToken === "tok-1", JSON.stringify(sent));

  clock = 4_000; await tick();
  clock = 8_000; await tick();
  check("ticks inside the interval are suppressed (keepalive, not a firehose)", sent.length === 1, String(sent.length));

  clock = 10_001; await tick();
  check("a tick after the interval notifies with the CUMULATIVE progress", sent.length === 2 && sent[1]!.params.progress === 4, JSON.stringify(sent[1]));

  clock = 25_000; await tick();
  check("progress is monotonically increasing across notifications", sent[2]!.params.progress === 5 && sent[2]!.params.progress > sent[1]!.params.progress, JSON.stringify(sent));
  check("every notification uses the MCP progress method", sent.every((n) => n.method === "notifications/progress"));
}

{
  let clock = 0;
  const tick = buildProgressKeepalive(42, async () => { throw new Error("stream gone"); }, 10_000, () => clock)!;
  let threw = false;
  try {
    await tick();
  } catch {
    threw = true;
  }
  check("a failed notification never fails the grade (best-effort by contract)", threw === false);
}

// withGradingKeepalive: beforeProviderCall fires only at row START, so a small corpus
// would emit one burst and go silent for the whole grade — the timer covers the gap.
{
  let ticks = 0;
  const result = await withGradingKeepalive(
    async () => { ticks++; },
    () => new Promise<string>((resolveDone) => setTimeout(() => resolveDone("graded"), 130)),
    25,
  );
  check("the timer ticks the keepalive while the grade runs", result === "graded" && ticks >= 3, String(ticks));
  const before = ticks;
  await new Promise((r) => setTimeout(r, 80));
  check("the timer is cleared when the grade returns", ticks === before, `${before} -> ${ticks}`);
}
{
  let ticks = 0;
  let threw = false;
  try {
    await withGradingKeepalive(
      async () => { ticks++; },
      () => new Promise((_r, reject) => setTimeout(() => reject(new Error("grade failed")), 60)),
      25,
    );
  } catch {
    threw = true;
  }
  const at = ticks;
  await new Promise((r) => setTimeout(r, 80));
  check("a throwing grade still clears the timer and rethrows", threw && ticks === at, `${at} -> ${ticks}`);
}
{
  const untouched = await withGradingKeepalive(undefined, async () => "no-keepalive");
  check("no keepalive → fn runs untouched", untouched === "no-keepalive");
}

console.log(`\n${failures === 0 ? `ALL PASS (${total})` : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
