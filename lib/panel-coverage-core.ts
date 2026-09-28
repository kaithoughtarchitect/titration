// Titration MCP — panel-coverage accounting (PURE, import-free, offline-tested).
//
// THE DEFECT THIS EXISTS TO CLOSE (2026-08-25, Issue 4): per-row
// `agreement` is computed across the judges that actually RETURNED a grade, so losing
// dissenters can only ever RAISE unanimity — three judges answering and agreeing reads
// 1.0, and ONE judge answering reads 1.0 too. During a systematic judge-plane outage
// (OpenRouter 402 on the grading account), a verify call with 53 of 96 votes missing
// returned `agreement: 1.0` and `confidence: "high"`. `effective_n` counts ROWS, not
// VOTES, so it cannot distinguish "23 rows graded by three vendors" from "23 rows graded
// by one". The only place the damage was visible was `panel.failed`, which nothing at the
// top level pointed at.
//
// The contract here: a caller who reads ONLY top-level fields can tell a one-vendor
// verdict from a three-vendor one. This module computes the vote accounting; verify.ts
// owns the verdict policy built on it (confidence caps, the panel floor → INCONCLUSIVE,
// establish's refusal to freeze on a damaged panel).
//
// NO imports ON PURPOSE (same law as capture-adapter-core: the offline gate must reach
// this without a DB). Row shape is structural — verify.ts's RowGrade satisfies it.

export interface PanelVoteRowLike {
  byJudge: Record<string, string>; // judgeId → normalized verdict ("pass" | "fail" | non-canonical)
  verdict: string | null; // per-row consensus (scorable iff "pass" | "fail")
}

export interface VoteCoverage {
  expected: number; // rows shipped × panel size — every vote a clean run would have produced
  received: number; // judge grades that actually came back (canonical or not)
  coverage: number; // received / expected, 0..1 (1.0 = clean panel)
  mean_judges_per_row: number; // received / rows shipped
  unavailable_judges: string[]; // panel judges that returned ZERO grades across the whole corpus (systematic outage: quota / payment / config)
  under_corroborated_rows: number; // SCORABLE rows decided by fewer than floor_votes canonical votes — a one-judge opinion wearing a consensus verdict
  scorable_rows: number; // denominator for the floor share
  floor_votes: number; // the corroboration floor the counts above were computed against
}

export function computeVoteCoverage(
  rows: PanelVoteRowLike[],
  panelIds: string[],
  floorVotes = 2,
): VoteCoverage {
  const total = rows.length;
  const expected = total * panelIds.length;
  let received = 0;
  let under = 0;
  let scorable = 0;
  const seen = new Set<string>();
  for (const r of rows) {
    const votes = Object.entries(r.byJudge ?? {});
    received += votes.length;
    for (const [id] of votes) seen.add(id);
    if (r.verdict === "pass" || r.verdict === "fail") {
      scorable++;
      const canonical = votes.filter(([, v]) => v === "pass" || v === "fail").length;
      if (canonical < floorVotes) under++;
    }
  }
  return {
    expected,
    received,
    coverage: expected ? Number((received / expected).toFixed(4)) : 0,
    mean_judges_per_row: total ? Number((received / total).toFixed(2)) : 0,
    unavailable_judges: panelIds.filter((id) => !seen.has(id)),
    under_corroborated_rows: under,
    scorable_rows: scorable,
    floor_votes: floorVotes,
  };
}

// The panel floor: when MORE than `share` of the scorable rows were decided by fewer
// than the corroboration floor, the corpus-level number is not a cross-vendor consensus
// any more — the honest verdict is a refusal to claim one, exactly as the noise floor
// already refuses a delta it cannot distinguish from noise. The zero-scorable case is
// deliberately NOT this gate's job (the effective-N gate owns it and fires first).
export function panelFloorTripped(votes: VoteCoverage, share: number): boolean {
  if (votes.scorable_rows === 0) return false;
  return votes.under_corroborated_rows / votes.scorable_rows > share;
}

// One honest sentence for the verdict's own `reason` (spec A4's acceptance folded in:
// a verdict graded on fewer rows/votes than were shipped says so WHERE THE CALLER READS,
// not only in a nested block). Returns "" on a clean, fully-graded panel.
export function describeVoteCoverage(
  votes: VoteCoverage,
  opts: {
    effective_n: number;
    total: number;
    unavailable_error_samples?: Record<string, string>; // judgeId → sample error (e.g. "OpenRouter request failed (402)")
  },
): string {
  const bits: string[] = [];
  if (votes.received < votes.expected) {
    bits.push(`panel coverage ${(votes.coverage * 100).toFixed(1)}%: ${votes.received} of ${votes.expected} judge votes returned`);
    if (votes.unavailable_judges.length > 0) {
      const samples = opts.unavailable_error_samples ?? {};
      const named = votes.unavailable_judges
        .map((id) => (samples[id] ? `${id} ("${samples[id]}")` : id))
        .join(", ");
      bits.push(`judge(s) returned nothing for the whole corpus: [${named}]`);
    }
    if (votes.under_corroborated_rows > 0) {
      bits.push(`${votes.under_corroborated_rows} of ${votes.scorable_rows} scorable rows decided by fewer than ${votes.floor_votes} votes`);
    }
  }
  if (opts.effective_n < opts.total) {
    bits.push(`graded ${opts.effective_n} of ${opts.total} shipped rows`);
  }
  return bits.length ? ` ⚠ ${bits.join("; ")}.` : "";
}
