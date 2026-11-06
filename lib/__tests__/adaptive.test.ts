// Titration MCP — adaptive-judging decision unit test (no network, no judges).
// Pins the pure B3b margin-lever logic (decideEscalation + pickProbe) that
// classifyFailure runs in mode="adaptive": when one calibrated probe judge is
// enough, and when the verdict must widen to the full panel. The judge I/O is
// separated out (classify.ts), so this is fully deterministic.
// Run: npx tsx lib/__tests__/adaptive.test.ts

import { readFileSync } from "node:fs";
import { CLASSIFY_SYSTEM, decideEscalation, ORIGINS, pickProbe } from "../classify";
import type { JudgeSpec } from "../judge";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}

// ── The boundary between the system and the instrument ──────────────────────
// A tool the agent acts through is part of the system. Without this line, judges
// given rerun evidence that the tool was the fix split between labels.
{
  const flat = CLASSIFY_SYSTEM.replace(/\s+/g, " ");
  check(
    "system-under-test covers skills and tools",
    flat.includes("system prompt, skills, tool descriptions and tool behaviour"),
  );
  check(
    "a tool the agent calls is not the instrument",
    flat.includes("A tool the agent sees or calls during the run is part of the system, not the instrument"),
  );
}

// The phrase checks above cannot tell whether judges still draw the line in the
// right place. scripts/classify-boundary-eval.ts runs these cases against live
// judges; this only guards the saved set, so it keeps both sides of the boundary.
{
  const cases: { id: string; expected: string; observation: string }[] = JSON.parse(
    readFileSync(new URL("./fixtures/classify-boundary-cases.json", import.meta.url), "utf8"),
  );
  const expected = cases.map((c) => c.expected);
  check(
    "boundary cases name only canonical origins",
    expected.every((e) => (ORIGINS as readonly string[]).includes(e)),
    expected.join(","),
  );
  check("boundary cases have unique ids", new Set(cases.map((c) => c.id)).size === cases.length);
  check("boundary cases all have an observation", cases.every((c) => c.observation.trim().length > 0));
  check(
    "boundary cases keep a tool failure on the system side",
    cases.some((c) => c.id === "tool-rerun-evidence" && c.expected === "system-under-test"),
  );
  check(
    "boundary cases keep a post-run scorer on the instrument side",
    cases.some((c) => c.id === "post-run-scorer-agent-never-sees" && c.expected === "instrument-failure"),
  );
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
