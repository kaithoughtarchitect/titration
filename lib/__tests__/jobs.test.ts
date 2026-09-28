// Titration MCP — async job state-machine unit test (no network, no DB).
// Pins the pure B4a logic the job store + server route on: the legal job
// transitions (canTransition), terminal detection (isTerminal), and the
// sync-vs-async fast-path switch (shouldRunAsync). The DB writes enforce the same
// legal-from sets in their WHERE clauses, so this is the offline contract for them.
// Run: npx tsx lib/__tests__/jobs.test.ts

import { canTransition, isTerminal, shouldRunAsync, SYNC_CORPUS_MAX, type JobStatus } from "../jobs-core";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}

// ── canTransition ─────────────────────────────────────────────────────────────
// queued → running|failed ; running → succeeded|failed ; terminal → nothing.

// Legal forward moves.
check("queued → running", canTransition("queued", "running") === true);
check("queued → failed (early)", canTransition("queued", "failed") === true);
check("running → succeeded", canTransition("running", "succeeded") === true);
check("running → failed", canTransition("running", "failed") === true);

// Illegal moves: skipping running, reviving terminal, self-loops.
check("queued ↛ succeeded (must run first)", canTransition("queued", "succeeded") === false);
check("running ↛ queued (no rewind)", canTransition("running", "queued") === false);
check("succeeded ↛ failed (terminal is final)", canTransition("succeeded", "failed") === false);
check("succeeded ↛ running (terminal is final)", canTransition("succeeded", "running") === false);
check("failed ↛ succeeded (terminal is final)", canTransition("failed", "succeeded") === false);
check("failed ↛ running (terminal is final)", canTransition("failed", "running") === false);
check("queued ↛ queued (no self-loop)", canTransition("queued", "queued") === false);

// Every state pair is covered by the table (no undefined → silent true/false).
{
  const states: JobStatus[] = ["queued", "running", "succeeded", "failed"];
  const allBoolean = states.every((f) => states.every((t) => typeof canTransition(f, t) === "boolean"));
  check("every (from,to) pair returns a boolean", allBoolean);
}

// ── isTerminal ────────────────────────────────────────────────────────────────
check("succeeded is terminal", isTerminal("succeeded") === true);
check("failed is terminal", isTerminal("failed") === true);
check("queued is not terminal", isTerminal("queued") === false);
check("running is not terminal", isTerminal("running") === false);

// ── shouldRunAsync (the fast-path switch) ─────────────────────────────────────
check("small corpus → sync", shouldRunAsync(1) === false);
check("at the sync ceiling → sync (boundary inclusive)", shouldRunAsync(SYNC_CORPUS_MAX) === false);
check("one over the ceiling → async", shouldRunAsync(SYNC_CORPUS_MAX + 1) === true);
check("empty corpus → sync", shouldRunAsync(0) === false);
check("custom lower ceiling routes async sooner", shouldRunAsync(5, 4) === true);
check("custom ceiling: at boundary → sync", shouldRunAsync(4, 4) === false);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
