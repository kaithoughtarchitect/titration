// Titration MCP — harness_validate I/O (single validation call).
//
// The single-strong-model brain that runs the 9-check validation as a
// SINGLE strong-model call over the design + the local-supplied codebase facts, then
// scores it DETERMINISTICALLY. This is the I/O layer; the report schema, the discipline
// prompt (VALIDATE_SYSTEM, the 9 checks), and the pure weighted-/100 scoring +
// Critical→Revise/Reject promotion live in harness-validate-core.ts (offline-tested).
// The split mirrors harness-design.ts ↔ harness-design-core.ts.
//
// One reuse, NOT re-authored (do NOT rebuild):
//   • judge.ts callJudge — a SINGLE strong-model call (NOT a 3-judge consensus panel).
//     A validation REPORT is advisory + human/local-agent-actioned, not a numeric
//     verdict; the ≥2-cross-vendor-judge rule (verdict surfaces only — gotcha #8a)
//     deliberately does NOT apply, exactly like harness_design.
//
// STATELESS: no card-store read (contrast harness_design, which pulls precedent) and no DB write — the
// 9 checks are analysis over facts the LOCAL agent gathers and passes. ADVISORY-NOT-
// BLOCKING: the report RETURNS the recommendation + Criticals (advisory:true); the
// LOCAL agent owns the block. The tool never hard-stops a capture run.

import { callJudge, HELPER_TIMEOUT_MS, type JudgeSpec } from "./judge";
import { familyForOpenRouterSlug } from "./referee-catalog-core";
import { resolveHelperJudgeSpec } from "./judges-roster";
import { VALIDATE_SYSTEM, buildValidateUserPrompt, assembleReport, type ValidationReport, type ValidateMode } from "./harness-validate-core";

// Bound each stringified input so a pathological dump can't blow the judge's context.
// A complete harness_design package runs ~30-40k characters; the old 24k cap cut the
// design's later sections off and the validator then reported them "missing" (Codex
// final check, 2026-09-27). 120k keeps a whole design with a wide margin.
const INPUT_CAP = 120_000;

export interface HarnessValidateInput {
  design_or_manifest: string | object; // the PROPOSED design package OR a scaffolded file manifest/description
  codebase_facts: string | object; // SPEC §6: resolved IDs, cited baselines+source, pipeline entry point, isolation state, false-clean traps
  mode?: ValidateMode; // "thorough" (all 9, default) | "quick" (checks 1,2,3,8)
  validate_model?: string; // override the single strong model (default: TITRATION_HELPER_MODEL else the first available verified door)
}

// Accept either a string or an object (the local agent may pass the harness_design design package
// JSON directly, or a free-form description). Objects are pretty-printed; everything is
// trimmed + capped.
function asText(v: unknown, cap: number): string {
  if (v == null) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  const t = s.trim();
  if (t.length <= cap) return t;
  // Say so, so the validator never reports something in the cut part as absent.
  return t.slice(0, cap) +
    `\n\n[TRUNCATED: ${t.length - cap} further characters were not included. Do NOT report anything as missing ` +
    `that could appear in the omitted part; say instead that the input was truncated.]`;
}

export async function harnessValidate(input: HarnessValidateInput): Promise<ValidationReport> {
  const design = asText(input?.design_or_manifest, INPUT_CAP);
  if (!design) throw new Error("design_or_manifest is required");
  const facts = asText(input?.codebase_facts, INPUT_CAP);
  if (!facts) {
    throw new Error(
      "codebase_facts is required — the server cannot see the repo, so the LOCAL agent must supply the grounding (resolved IDs, cited baselines + source, the pipeline entry point, isolation state, and the false-clean traps). Without it every grounded check is uncertifiable.",
    );
  }
  const mode: ValidateMode = input?.mode === "quick" ? "quick" : "thorough";

  const userPrompt = buildValidateUserPrompt(design, facts, mode);

  // SINGLE strong-model call (callJudge handles temp-0 + one reproducible retry +
  // loose-JSON parsing). Not a panel — a validation report is advisory, not a
  // verdict. An explicit validate_model override wins; otherwise
  // TITRATION_HELPER_MODEL else the first available verified door (subscription
  // CLIs first), typed refusal if none.
  const spec: JudgeSpec = input.validate_model
    ? { id: "validate", family: familyForOpenRouterSlug(input.validate_model), door: "openrouter", model: input.validate_model }
    : await resolveHelperJudgeSpec();
  const raw = await callJudge(spec, VALIDATE_SYSTEM, userPrompt, { timeoutMs: HELPER_TIMEOUT_MS });

  // Pure, invariant-checked assembly + deterministic scoring (throws on a malformed /
  // incomplete report — better than certifying a harness on a partial analysis). The
  // weighted /100, the Critical→Revise/Reject promotion, and the verdict mapping are
  // host-computed here, never model arithmetic (no drift).
  return assembleReport(raw, mode);
}
