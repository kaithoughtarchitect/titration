import {
  BASELINE_GOAL_LIMITS,
  formatBaselineGoalBrief,
  normalizeBaselineGoalBrief,
  parseBaselineGoal,
  readableBaselineGoalText,
} from "../experiment-brief-core";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}
function throwsMsg(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error: any) {
    return String(error?.message ?? error);
  }
}

const formatted = formatBaselineGoalBrief({
  failure: " duplicate   facts are promoted ",
  desired_behavior: " promote genuinely new information ",
  scope: " exact restatements only ",
});
check(
  "format: structured brief serializes deterministically",
  formatted === "Failure: duplicate facts are promoted\nWanted: promote genuinely new information\nScope: exact restatements only",
  String(formatted),
);
check("normalize: both core fields are required", normalizeBaselineGoalBrief({ failure: "x" }) === null);
check(
  "format: oversized fields are refused instead of silently truncated",
  (throwsMsg(() => formatBaselineGoalBrief({ failure: "x".repeat(BASELINE_GOAL_LIMITS.failure + 1), desired_behavior: "y" })) ?? "").includes("maxLength"),
);

const structured = parseBaselineGoal(formatted);
check("parse: structured failure recovered", structured.failure === "duplicate facts are promoted");
check("parse: structured desired behavior recovered", structured.desired_behavior === "promote genuinely new information");
check("parse: structured scope recovered", structured.scope === "exact restatements only" && structured.structured);

const embeddedLabel = parseBaselineGoal("Failure: The output literally says Wanted: more data\nWanted: Do not repeat that phrase");
check("parse: label words inside structured prose do not split a field", embeddedLabel.failure === "The output literally says Wanted: more data");
check("parse: only line-leading labels delimit structured fields", embeddedLabel.desired_behavior === "Do not repeat that phrase");

const incompleteStructured = parseBaselineGoal("Failure: The output says Wanted: more data");
check("parse: incomplete structured prose does not fall through to the inline legacy splitter", incompleteStructured.failure === "The output says Wanted: more data" && incompleteStructured.desired_behavior === "");

const legacy = parseBaselineGoal("Duplicates accumulate. Wanted: only new information is promoted.");
check("parse: legacy pre-Wanted prose becomes the failure", legacy.failure === "Duplicates accumulate.");
check("parse: legacy Wanted prose becomes desired behavior", legacy.desired_behavior === "only new information is promoted.");
check("parse: legacy record is labelled unstructured", legacy.structured === false);

const plain = parseBaselineGoal("Avoid duplicate promotion");
check("parse: unsplit legacy goal remains visible", plain.failure === "Avoid duplicate promotion" && plain.desired_behavior === "");

check(
  "reading: em dash becomes a sentence boundary",
  readableBaselineGoalText("wrong side of the gate — most commonly a transient fact")
    === "Wrong side of the gate. Most commonly a transient fact",
);
check(
  "reading: technical en-dash range is preserved",
  readableBaselineGoalText("scores in the 0.4 – 0.6 range") === "Scores in the 0.4 – 0.6 range",
);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
