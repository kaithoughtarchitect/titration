// Titration MCP — the PURE flywheel decision (no I/O, no imports).
//
// The verdict engine READS the tenant ledger before a verdict (advisory — failed-edit
// memory / domain-calibrated origins) and WRITES durable learnings back after a
// completed run (cardCreate → runCapture). This module is that DECISION extracted
// PURE — what query a read uses, and what card a completed verdict promotes (type /
// title / body / tags / confidence) — the same discipline as jobs-core / goal-titrate-core /
// applyReconsideration: offline-testable without a DB or a judge. The cardSearch /
// cardCreate / runCapture I/O + the fail-open wrappers live in flywheel.ts. It has
// NO imports on purpose (store.ts throws at import without TITRATION_DATABASE_URL),
// so the slices of a VerifyResult / GoalTitrateResult the decision needs are
// re-declared here rather than imported.
//
// SETTLED FLYWHEEL DECISIONS:
//   • ADVISORY-ONLY: the ledger ANNOTATES a verdict, it NEVER influences it. The
//     numeric verdict (passed / failure_origin / confidence) is computed
//     independently of the ledger; cards never enter the judge/grader prompt.
//     Protects the frozen measuring stick + the uncontaminated judge (the
//     epistemic product).
//   • READS always-on (advisory, fail-open) + a kill-switch; WRITES opt-in (default
//     off) so the ledger only grows with runs the caller marks durable.
//   • classify_failure is READ-ONLY in the flywheel; the write fires only on a
//     completed verify / goal_titrate run.
//   • Auto-promoted cards carry the AUTO_TAG so they are filterable from hand-curated
//     cards (ledger hygiene + a future dedup pass).
//   • Per-tenant judge calibration is a deferred future read — it would need a
//     migration to persist per-judge baseline rates; this module is migration-free.

export const AUTO_TAG = "auto-capture"; // marks a flywheel-promoted card (vs hand-curated)

export type Confidence = "low" | "medium" | "high" | "critical";

// ── reads ─────────────────────────────────────────────────────────────────────
// The read fires BEFORE the verdict, so only the call's stable inputs are known
// (the baseline goal for verify/goal_titrate, the observation for classify). An
// optional per_mode_regression refiner lets a caller that reads POST-verdict sharpen
// the query toward the modes that actually regressed — harmless + pure either way.
export type ReadInput =
  | { kind: "verify"; goal: string; per_mode_regression?: string[] }
  | { kind: "classify"; observation: string }
  | { kind: "goal_titrate"; goal: string };

export const MAX_QUERY = 500; // bound the embedded query (cardSearch embeds it on every read)

export function buildReadQuery(input: ReadInput): string {
  let q: string;
  if (input.kind === "classify") {
    q = String(input.observation ?? "").trim();
  } else {
    q = String(input.goal ?? "").trim();
    if (input.kind === "verify" && input.per_mode_regression?.length) {
      q += ` (regressed modes: ${input.per_mode_regression.join(", ")})`;
    }
  }
  return q.slice(0, MAX_QUERY);
}

// ── writes (the durable-learning promotion) ─────────────────────────────────────

// The minimal slice of a VerifyResult the capture decision needs (re-declared, not
// imported — keeps this module DB-free). The I/O layer maps a real VerifyResult on.
export interface VerifySlice {
  passed: boolean;
  inconclusive: boolean;
  metric_delta: number; // candidate − baseline failure rate (negative = improvement)
  baseline_rate: number;
  candidate_rate: number;
  floor_intact: boolean;
  per_mode_regression: string[];
  failure_origin: string | null;
  confidence: Confidence | null;
}

// The minimal slice of a terminal GoalTitrateResult the capture decision needs.
export interface GoalSlice {
  converged: boolean;
  decision: string; // TurnDecision: continue | converged | critical-stall | budget-exhausted
  failure_origin: string | null;
  turns: number;
  overall_progress: number; // 0..1 fraction of sub-objectives met
}

export interface CaptureCandidateProvenance {
  name: string;
  version?: string;
  summary?: string;
  deferred_scope?: string;
}

export type CaptureInput =
  | { kind: "verify"; goal: string; baseline_id: string; system_ref?: string | null; result: VerifySlice }
  | {
      kind: "goal_titrate";
      goal: string;
      baseline_id: string;
      job_id: string;
      candidate?: CaptureCandidateProvenance | null;
      result: GoalSlice;
    };

// What a completed verdict promotes. `type` is constrained to the two flywheel-
// relevant card types (FINDING for a confirmed win, REGRESSION for failed-edit
// memory) — the values store.ts's cardCreate accepts.
export interface CardSpec {
  type: "FINDING" | "REGRESSION";
  title: string;
  body: string;
  sections: Array<{ key: string; label: string; content: string }>;
  tags: string[];
  confidence: Confidence;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const pp = (x: number) => `${(x * 100).toFixed(1)}pp`;

// Durable card content is never silently clipped. A compact identity may be used in the title only
// when it is already concise; otherwise the title falls back to its semantic event label. The full
// goal and candidate provenance remain verbatim in the card Evidence section.
function text(value: unknown): string {
  return String(value ?? "").trim();
}

function conciseIdentity(value: unknown): string | null {
  const compact = text(value).replace(/\s+/g, " ");
  return compact && compact.length <= 80 ? compact : null;
}

function eventTitle(event: string, identity: unknown): string {
  const compact = conciseIdentity(identity);
  return compact ? `${event}: ${compact}` : event;
}

function measuredGoal(goal: string): string {
  return text(goal) || "Not recorded.";
}

function turnCount(turns: number): string {
  return `${turns} turn${turns === 1 ? "" : "s"}`;
}

function candidateEvidence(candidate?: CaptureCandidateProvenance | null): string {
  if (!candidate) return "";
  const lines = [
    text(candidate.name) ? `- Name: ${text(candidate.name)}` : "",
    text(candidate.version) ? `- Version: ${text(candidate.version)}` : "",
    text(candidate.summary) ? `- Change: ${text(candidate.summary)}` : "",
    text(candidate.deferred_scope) ? `- Deferred scope: ${text(candidate.deferred_scope)}` : "",
  ].filter(Boolean);
  return lines.length ? `\n\nCandidate tested:\n${lines.join("\n")}` : "";
}

function cardContent(sections: CardSpec["sections"]): Pick<CardSpec, "body" | "sections"> {
  return {
    sections,
    body: sections.map((section) => `## ${section.label}\n\n${section.content}`).join("\n\n"),
  };
}

// The pure capture decision: given a COMPLETED verdict, what durable card (if any)
// does it promote? Returns null when there is no durable learning (an inconclusive
// verify is a delta you can't distinguish from noise — it is not knowledge). Pure:
// no DB, no judge, no clock.
export function verdictToCard(input: CaptureInput): CardSpec | null {
  if (input.kind === "verify") {
    const r = input.result;
    if (r.inconclusive) return null; // not durable — a verdict you can't trust isn't knowledge
    const conf: Confidence = r.confidence ?? "low";
    const baseTags = [AUTO_TAG, "verify", `baseline:${input.baseline_id.slice(0, 8)}`];
    const system = conciseIdentity(input.system_ref);
    const sys = input.system_ref ? `\n- System: ${text(input.system_ref)}` : "";
    if (r.passed) {
      return {
        type: "FINDING",
        title: eventTitle("Verified improvement", system),
        ...cardContent([
          {
            key: "summary",
            label: "Summary",
            content: `${system ? `${system} produced` : "The candidate produced"} a verified improvement against the frozen baseline.`,
          },
          {
            key: "evidence",
            label: "Evidence",
            content:
              `Goal measured:\n${measuredGoal(input.goal)}\n\n` +
              `- Failure rate: ${pct(r.baseline_rate)} → ${pct(r.candidate_rate)} (Δ ${pp(r.metric_delta)})\n` +
              `- Floor intact: ${r.floor_intact}\n` +
              `- Confidence: ${conf}` + sys,
          },
          {
            key: "implication",
            label: "Implication",
            content: "This change reduced the failure rate beyond the noise floor with the per-mode floor intact.",
          },
        ]),
        tags: baseTags,
        confidence: conf,
      };
    }
    // passed:false — a regression or a non-improvement: the FAILED-EDIT MEMORY the
    // read side later surfaces ("you tried this, it didn't clear the floor").
    const modes = r.per_mode_regression ?? [];
    return {
      type: "REGRESSION",
      title: eventTitle("Failed edit", system),
      ...cardContent([
        {
          key: "summary",
          label: "Summary",
          content: `${system ? `${system}'s candidate` : "The candidate"} did not pass against the frozen baseline.`,
        },
        {
          key: "reproduction",
          label: "Reproduction",
          content:
            `Goal measured:\n${measuredGoal(input.goal)}\n\n` +
            `- Failure rate: ${pct(r.baseline_rate)} → ${pct(r.candidate_rate)} (Δ ${pp(r.metric_delta)})\n` +
            `- Floor intact: ${r.floor_intact}` +
            (modes.length ? ` (per-mode regression on [${modes.join(", ")}])` : "") +
            `\n- Confidence: ${conf}` + sys,
        },
        { key: "workaround", label: "Workaround", content: "Do not repeat this approach without new signal." },
        { key: "fixed-in", label: "Fixed-in", content: "Not recorded." },
      ]),
      tags: [...baseTags, ...modes.map((m) => `mode:${m}`)],
      confidence: conf,
    };
  }
  // goal_titrate — a TERMINAL run (the I/O layer only calls this on outcome.terminal).
  const r = input.result;
  const baseTags = [AUTO_TAG, "goal_titrate", `job:${input.job_id.slice(0, 8)}`];
  const candidateName = text(input.candidate?.name);
  const summarySubject = candidateName || "The candidate";
  if (r.converged) {
    return {
      type: "FINDING",
      title: eventTitle("Goal converged", candidateName),
      ...cardContent([
        {
          key: "summary",
          label: "Summary",
          content: `${summarySubject} converged against the frozen baseline in ${turnCount(r.turns)} and reached ${pct(r.overall_progress)} overall progress.`,
        },
        {
          key: "evidence",
          label: "Evidence",
          content:
            `Goal measured:\n${measuredGoal(input.goal)}\n\n` +
            `- Turns: ${r.turns}\n` +
            `- Overall progress: ${pct(r.overall_progress)}\n` +
            `- Origin: ${r.failure_origin ?? "goal-complete"}` +
            candidateEvidence(input.candidate),
        },
        {
          key: "implication",
          label: "Implication",
          content: "This measured goal is reachable against the frozen baseline with the tested candidate.",
        },
      ]),
      tags: baseTags,
      confidence: "high",
    };
  }
  return {
    type: "REGRESSION",
    title: eventTitle("Goal did not converge", candidateName),
    ...cardContent([
      {
        key: "summary",
        label: "Summary",
        content: `${summarySubject} stopped without convergence after ${turnCount(r.turns)} at ${pct(r.overall_progress)} overall progress.`,
      },
      {
        key: "reproduction",
        label: "Reproduction",
        content:
          `Goal measured:\n${measuredGoal(input.goal)}\n\n` +
          `- Decision: ${r.decision}\n` +
          `- Turns: ${r.turns}\n` +
          `- Overall progress: ${pct(r.overall_progress)}\n` +
          `- Origin: ${r.failure_origin ?? "unknown"}` +
          candidateEvidence(input.candidate),
      },
      {
        key: "workaround",
        label: "Workaround",
        content: "Do not repeat this approach without addressing the recorded stop condition.",
      },
      { key: "fixed-in", label: "Fixed-in", content: "Not recorded." },
    ]),
    tags: [...baseTags, ...(r.failure_origin ? [`origin:${r.failure_origin}`] : [])],
    confidence: "medium",
  };
}

// The run ref a promoted card is anchored to (runCapture's idempotency key, unique
// per run). goal_titrate has a natural per-run id (the job_id); a sync verify has
// none, so the I/O layer supplies a short nonce — kept as an INPUT so this stays
// pure + deterministic (no randomness/clock here).
export function runRefFor(
  input: { kind: "verify"; baseline_id: string; nonce: string } | { kind: "goal_titrate"; job_id: string },
): string {
  if (input.kind === "goal_titrate") return `RUN-goaltitrate-${input.job_id}`;
  return `RUN-verify-${input.baseline_id.slice(0, 8)}-${input.nonce}`;
}
