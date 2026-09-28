// Titration MCP — adaptive-judging decision unit test (no network, no judges).
// Pins the pure B3b margin-lever logic (decideEscalation + pickProbe) that
// classifyFailure runs in mode="adaptive": when one calibrated probe judge is
// enough, and when the verdict must widen to the full panel. The judge I/O is
// separated out (classify.ts), so this is fully deterministic.
// Run: npx tsx lib/__tests__/adaptive.test.ts

import { decideEscalation, pickProbe } from "../classify";
import type { JudgeSpec } from "../judge";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}

// ── decideEscalation ──────────────────────────────────────────────────────────
// ACCEPT-single ONLY on a high-confidence, canonical, non-system-under-test verdict
// (a confident "route elsewhere — don't touch the prompt"). Everything else widens.

{
  const d = decideEscalation({ failure_origin: "formatter", confidence: "high" });
  check("high-conf formatter → accept single", d.escalate === false, JSON.stringify(d));
}
{
  const d = decideEscalation({ failure_origin: "corpus-gap", confidence: "high" });
  check("high-conf corpus-gap → accept single", d.escalate === false, JSON.stringify(d));
}
{
  // The load-bearing case: a prompt-edit greenlight must never rest on one judge.
  const d = decideEscalation({ failure_origin: "system-under-test", confidence: "high" });
  check("high-conf system-under-test → ESCALATE (high false-positive cost)", d.escalate === true, JSON.stringify(d));
}
{
  const d = decideEscalation({ failure_origin: "formatter", confidence: "medium" });
  check("medium-conf → ESCALATE (ambiguous)", d.escalate === true, JSON.stringify(d));
}
{
  const d = decideEscalation({ failure_origin: "corpus-gap", confidence: "low" });
  check("low-conf → ESCALATE (ambiguous)", d.escalate === true, JSON.stringify(d));
}
{
  const d = decideEscalation({ failure_origin: "formatter" }); // no confidence field
  check("missing confidence → ESCALATE", d.escalate === true, JSON.stringify(d));
}
{
  const d = decideEscalation({ failure_origin: "banana", confidence: "high" });
  check("high-conf NON-canonical origin → ESCALATE", d.escalate === true, JSON.stringify(d));
}
{
  const d = decideEscalation({ failure_origin: "", confidence: "high" });
  check("empty origin → ESCALATE", d.escalate === true, JSON.stringify(d));
}

// ── pickProbe ─────────────────────────────────────────────────────────────────
// Preference grok → gpt → deepseek, chosen from the already-resolved panel (so a
// `judges` subset / env knobs are honored); falls back to the first judge.

const spec = (id: string): JudgeSpec => ({ id, family: "x", door: "openrouter", model: "m" });
{
  const p = pickProbe([spec("grok"), spec("gpt"), spec("deepseek")]);
  check("full panel → probe is grok (calibration baseline)", p.id === "grok", p.id);
}
{
  const p = pickProbe([spec("deepseek"), spec("gpt")]); // grok absent
  check("no grok → probe is gpt (next preference)", p.id === "gpt", p.id);
}
{
  const p = pickProbe([spec("deepseek")]);
  check("only deepseek → probe is deepseek", p.id === "deepseek", p.id);
}
{
  const p = pickProbe([spec("mystery")]); // unknown id
  check("unknown-only panel → probe is the first judge", p.id === "mystery", p.id);
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
