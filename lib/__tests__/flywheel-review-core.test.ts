import {
  buildReviewSeedRunSummary,
  reviewCaptureCompleted,
  reviewCaptureFailed,
} from "../flywheel-review-core";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.error(`FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

const summary = buildReviewSeedRunSummary({
  kind: "goal_titrate",
  goal: "Stop duplicate memory promotion without losing real information.",
  candidate: {
    name: "CV91 Dedup",
    version: "70c3fd7",
    summary: "Stage day-ingest dedup and add an exact-text dreamer pre-check.",
    deferred_scope: "Fuzzy semantic duplicates remain deferred.",
  },
}, {
  title: "Goal converged",
  body: "The candidate passed against the frozen baseline.",
});

check("summary carries the verified outcome", summary.includes("VERIFIED OUTCOME") && summary.includes("Goal converged"));
check("summary carries candidate identity", summary.includes("Name: CV91 Dedup") && summary.includes("Version: 70c3fd7"));
check("summary carries the concrete change", summary.includes("Change made: Stage day-ingest dedup"));
check("summary carries the known boundary", summary.includes("Known deferred scope: Fuzzy semantic duplicates remain deferred."));

const empty = reviewCaptureCompleted(0);
check("empty extraction creates no review work", empty.status === "no_approval_ready_learning" && empty.proposal_count === 0);
check("empty extraction explains the diagnostic", !!empty.reason?.includes("no review item was created"));

const ready = reviewCaptureCompleted(2);
check("complete drafts are enqueued", ready.status === "proposal_enqueued" && ready.proposal_count === 2 && ready.reason === null);

const broken = reviewCaptureFailed(new Error("model unavailable"), 1);
check("seed failure is a diagnostic with partial count", broken.status === "failed" && broken.proposal_count === 1 && !!broken.reason?.includes("model unavailable"));

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed === 0 ? 0 : 1);
