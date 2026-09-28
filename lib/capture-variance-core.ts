// Titration MCP — capture-variance band (PURE, import-free, offline-tested).
//
// THE BLIND SPOT THIS CLOSES: the engine's noise_floor is computed from inter-judge agreement, so it
// measures how much the JUDGES disagree about fixed rows. It cannot see how much the
// CAPTURE moves when nothing changes — and that variance was measured at roughly THREE
// TIMES the printed noise floor (judge-only re-grade: one row of 16-17; byte-identical
// re-capture on a fully pinned rig: 12.5pp overall / 14.2pp no_tool / 7.0pp tool_ran).
// Two captures of one unchanged configuration were both returned as "Improvement
// confirmed, outside the noise floor, high confidence", 12.5pp apart.
//
// THE FIX (B1.3, first-class repeat-capture): a caller ships candidate_outputs as N
// labelled replicates of ONE configuration — each row carries `capture: "<label>"`
// naming which capture run produced it. With ≥2 distinct labels among scorable rows,
// the engine computes per-capture rates and reports the observed between-capture BAND
// (max − min); the verdict then requires |delta| to clear the WIDER of the judge noise
// floor and this band. One capture (or no labels) → null → behavior byte-identical to
// before, so every existing caller is untouched.
//
// Deliberately conservative asymmetry: the band widens only the IMPROVEMENT claim, never
// the per-mode regression gate — capture variance does not excuse a regression (the
// floor's whole job is to prefer a false alarm over a missed collapse).
//
// NO imports ON PURPOSE (offline gate law). Row shape is structural.

export interface CaptureRowLike {
  capture?: string | null; // replicate-capture label the row shipped with (absent → unlabeled)
  mode: string; // bucket (per-mode bands)
  verdict: string | null; // per-row consensus (scorable iff "pass" | "fail")
}

export interface CaptureStats {
  rate: number; // failure rate over this capture's scorable rows
  n: number; // scorable rows in this capture
}

export interface CaptureVariance {
  captures: Record<string, CaptureStats>; // per replicate label, overall
  band: number; // max − min of per-capture overall rates — the observed capture-to-capture spread
  per_mode: Record<string, { band: number; captures: Record<string, CaptureStats> }>;
  labeled_rows: number; // scorable rows carrying a capture label
  unlabeled_rows: number; // scorable rows without one. The ENGINE refuses a partially labeled corpus upfront (checkCaptureLabeling below), so on the verify/establish path this is 0 whenever a band exists; the field stays as defense-in-depth for direct callers of this pure fn
}

const round4 = (x: number) => Number(x.toFixed(4));

// Partial labeling is a POPULATION MISMATCH, not a smell: the pooled candidate rate is
// computed over every scorable row while the band only sees labeled rows, so the
// significance floor would gate a delta measured on a different population (flagged in
// automated PR review, PR #74). Refused upfront — BEFORE any judge spend — by verify/establish via this
// helper: either label every row with its capture, or label none.
export interface CaptureLabelingCheck {
  labeled: number;
  unlabeled: number;
  partial: boolean; // some rows labeled, some not → refuse before grading
  unlabeled_indices: number[]; // 0-based indices of the offending rows (first 20)
}

export function checkCaptureLabeling(rows: { capture?: string | null }[]): CaptureLabelingCheck {
  const list = rows ?? [];
  const unlabeled_indices: number[] = [];
  let labeled = 0;
  list.forEach((r, i) => {
    if (typeof r?.capture === "string" && r.capture.trim() !== "") labeled++;
    else if (unlabeled_indices.length < 20) unlabeled_indices.push(i);
  });
  const unlabeled = list.length - labeled;
  return { labeled, unlabeled, partial: labeled > 0 && unlabeled > 0, unlabeled_indices };
}

// Returns null when fewer than 2 distinct capture labels exist among scorable rows —
// a single capture has no between-capture spread to report, and null keeps every
// existing single-capture caller's result shape and verdict unchanged.
export function computeCaptureVariance(rows: CaptureRowLike[]): CaptureVariance | null {
  const scorable = (rows ?? []).filter((r) => r?.verdict === "pass" || r?.verdict === "fail");
  const labeled = scorable.filter((r) => typeof r.capture === "string" && r.capture.trim() !== "");
  const labels = [...new Set(labeled.map((r) => (r.capture as string).trim()))];
  if (labels.length < 2) return null;

  const stats = (rs: CaptureRowLike[]): CaptureStats => ({
    rate: round4(rs.filter((r) => r.verdict === "fail").length / rs.length),
    n: rs.length,
  });
  const bandOf = (byLabel: Record<string, CaptureStats>): number => {
    const rates = Object.values(byLabel).map((s) => s.rate);
    return round4(Math.max(...rates) - Math.min(...rates));
  };

  const captures: Record<string, CaptureStats> = {};
  for (const label of labels) {
    captures[label] = stats(labeled.filter((r) => (r.capture as string).trim() === label));
  }

  const per_mode: CaptureVariance["per_mode"] = {};
  for (const mode of [...new Set(labeled.map((r) => r.mode))]) {
    const modeRows = labeled.filter((r) => r.mode === mode);
    const byLabel: Record<string, CaptureStats> = {};
    for (const label of labels) {
      const rs = modeRows.filter((r) => (r.capture as string).trim() === label);
      if (rs.length > 0) byLabel[label] = stats(rs);
    }
    // A mode present in only one capture has no spread to report for that mode.
    if (Object.keys(byLabel).length >= 2) per_mode[mode] = { band: bandOf(byLabel), captures: byLabel };
  }

  return {
    captures,
    band: bandOf(captures),
    per_mode,
    labeled_rows: labeled.length,
    unlabeled_rows: scorable.length - labeled.length,
  };
}
