// Titration MCP — the PURE async-job core (no I/O, no imports).
//
// Split out of jobs.ts so it is genuinely offline-testable (no DB) — the same
// discipline as applyReconsideration / decideEscalation / findRateDissent: keep
// the decision pure here, the postgres I/O in jobs.ts. The DB writes in jobs.ts
// enforce the SAME legal-from sets in their WHERE clauses, so this module is the
// authoritative contract for them.

export type JobKind = "verify" | "establish_baseline" | "goal_titrate";
export const DURABLE_JOB_KINDS = [
  "verify",
  "establish_baseline",
] as const satisfies readonly JobKind[];
export type DurableJobKind = (typeof DURABLE_JOB_KINDS)[number];
export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export function isDurableJobKind(value: unknown): value is DurableJobKind {
  return DURABLE_JOB_KINDS.includes(value as DurableJobKind);
}

// Legal forward transitions. A job may fail from any non-terminal state; it may
// only succeed out of `running`; terminal states are final.
const LEGAL_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  queued: ["running", "failed"],
  running: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return LEGAL_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isTerminal(s: JobStatus): boolean {
  return s === "succeeded" || s === "failed";
}

// The fast-path switch: route a corpus larger than the sync ceiling to an async
// job. Pure so the server's sync-vs-async decision is testable without booting it.
export const SYNC_CORPUS_MAX = 40;
export function shouldRunAsync(corpusLen: number, syncMax: number = SYNC_CORPUS_MAX): boolean {
  return corpusLen > syncMax;
}
