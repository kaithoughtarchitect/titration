// Pure experiment-brief contract shared by the baseline writer and any UI reader.
// A baseline still stores one immutable `goal` text column, but new callers provide
// named fields and the engine serializes them deterministically. Legacy goal prose is
// parsed fail-soft for display; it is never rewritten or used to change a verdict.

export interface BaselineGoalBrief {
  failure: string;
  desired_behavior: string;
  scope?: string;
}

export interface BaselineGoalStory extends BaselineGoalBrief {
  raw_goal: string;
  structured: boolean;
}

export const BASELINE_GOAL_LIMITS = { failure: 4_000, desired_behavior: 3_000, scope: 2_000 } as const;

function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, " ");
  return text || undefined;
}

// Presentation-only normalization for a readable summary. The immutable stored goal is
// never rewritten, and technical en-dash ranges remain untouched.
export function readableBaselineGoalText(value: unknown): string {
  return (clean(value) ?? "")
    .replace(/\s+\u2014\s+/g, ". ")
    .replace(/(^|[.!?]\s+)([a-z])/g, (_match, boundary: string, letter: string) => `${boundary}${letter.toUpperCase()}`);
}

function requireBaselineGoalBrief(value: unknown): BaselineGoalBrief {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("goal_brief must be an object");
  }
  const raw = value as Record<string, unknown>;
  const failure = clean(raw.failure);
  const desired_behavior = clean(raw.desired_behavior);
  const scope = clean(raw.scope);
  if (!failure || !desired_behavior) {
    throw new Error("goal_brief.failure and goal_brief.desired_behavior are required");
  }
  const fields = { failure, desired_behavior, ...(scope ? { scope } : {}) };
  for (const [key, text] of Object.entries(fields)) {
    const max = BASELINE_GOAL_LIMITS[key as keyof typeof BASELINE_GOAL_LIMITS];
    if (text.length > max) throw new Error(`goal_brief.${key} exceeds maxLength ${max}`);
  }
  return fields;
}

export function normalizeBaselineGoalBrief(value: unknown): BaselineGoalBrief | null {
  try {
    return requireBaselineGoalBrief(value);
  } catch {
    return null;
  }
}

export function formatBaselineGoalBrief(value: unknown): string | null {
  if (value == null) return null;
  const brief = requireBaselineGoalBrief(value);
  return [
    `Failure: ${brief.failure}`,
    `Wanted: ${brief.desired_behavior}`,
    ...(brief.scope ? [`Scope: ${brief.scope}`] : []),
  ].join("\n");
}

function section(text: string, label: string, following: string[]): string | null {
  const start = new RegExp(`^[ \\t]*${label}:[ \\t]*`, "im").exec(text);
  if (!start) return null;
  const from = start.index + start[0].length;
  let to = text.length;
  for (const next of following) {
    const match = new RegExp(`^[ \\t]*${next}:[ \\t]*`, "im").exec(text.slice(from));
    if (match) to = Math.min(to, from + match.index);
  }
  return clean(text.slice(from, to)) ?? null;
}

export function parseBaselineGoal(goal: unknown): BaselineGoalStory {
  const raw_goal = typeof goal === "string" ? goal.trim() : "";
  const explicitFailure = section(raw_goal, "Failure", ["Wanted", "Scope"]);
  const wanted = section(raw_goal, "Wanted", ["Scope"]);
  const scope = section(raw_goal, "Scope", []);
  if (explicitFailure && wanted) {
    return {
      failure: explicitFailure,
      desired_behavior: wanted,
      ...(scope ? { scope } : {}),
      raw_goal,
      structured: true,
    };
  }
  if (explicitFailure) {
    // A line-leading structured label opts into the line-oriented grammar. Do
    // not reinterpret an inline `Wanted:` inside malformed/incomplete failure
    // prose as a real desired-behavior field.
    return {
      failure: explicitFailure,
      desired_behavior: "",
      ...(scope ? { scope } : {}),
      raw_goal,
      structured: false,
    };
  }

  // Legacy records commonly used `<failure prose> Wanted: <desired prose>`.
  // Split that stable delimiter for presentation without mutating history.
  const wantedMatch = /(?:^|\s)Wanted:\s*/i.exec(raw_goal);
  if (wantedMatch) {
    const failure = clean(raw_goal.slice(0, wantedMatch.index)) ?? raw_goal;
    const desired_behavior = clean(raw_goal.slice(wantedMatch.index + wantedMatch[0].length)) ?? "";
    return { failure, desired_behavior, raw_goal, structured: false };
  }

  return { failure: raw_goal, desired_behavior: "", raw_goal, structured: false };
}
