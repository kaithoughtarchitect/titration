// Titration MCP — Refusal → Draft Auto-Capture: the I/O half.
//
// On a baseline reproduce-refuse or a terminal verify inconclusive/regression, auto-draft an
// unpromoted, typed METHOD candidate into the existing knowledge_review_queue — so the reusable
// methodology lesson (the class of thing hand-captured as base card T-MET-041) is captured
// deterministically instead of depending on an agent's memory (the CV88 failure mode).
//
// Purely additive, fail-open side effect: classify (refusal-capture-core.ts) -> assertWritable
// (never __base__) -> dedup (two deterministic exact SQL predicates, no cardSearch/embedding) ->
// INSERT one pending knowledge_review_queue row. Returns void — nothing here can alter a verdict
// already computed by establishBaseline/verify. The whole body is wrapped in a fail-open
// try/catch (mirrors captureVerdict's never-throw-into-the-verdict discipline, flywheel.ts:122-177):
// any error (a bad tenant, a dedup-query failure, an insert failure) is caught, logged, and
// swallowed — it NEVER propagates to the caller. Never auto-promotes: the row stays
// `pending` until an existing human approveLearning action creates a cards row.
//
// REUSE, NOT REBUILD: the exact knowledge_review_queue insert column set seedReviewProposals
// already writes (flywheel.ts:252-259); assertWritable/tenantId/sql/sql.json from store.ts (the
// ONE postgres pool). source_kind stays 'manual' (D2 — zero migration; the KEEP-ALL-SIX CHECK
// vocabulary — the knowledge_review_queue.source_kind check constraint in db/001_schema.sql —
// has no 'establish_baseline'/'refusal' value).

import { assertWritable, sql, tenantIdForWrite } from "./store";
import { deriveRefusalClass, type RefusalClass, type RefusalSignal } from "./refusal-capture-core";

// Which refusal site produced the signal — supplies the run/baseline lineage for
// source_ref + evidence. `kind` is INTERNAL provenance (NOT the row's source_kind,
// which is always 'manual').
export type RefusalSource =
  | { kind: "establish_baseline"; run_ref?: string | null; goal?: string }
  | { kind: "verify"; baseline_id: string; run_ref?: string | null; goal?: string };

// knowledge_review_queue.payload — a METHOD card stub. payload.type='METHOD';
// refusal_class lives HERE, never on the wire result — this IS the exact-dedup
// key via the `class:${refusal_class}` tag / `payload->>'refusal_class'`.
export interface RefusalDraftPayload {
  type: "METHOD";
  title: string; // e.g. "Refusal captured: reproduce_fail"
  body: string; // canonical refusal→fix text (grounded in signal.reason)
  refusal_class: RefusalClass;
  tags?: string[]; // e.g. ['refusal-capture', `class:${refusal_class}`]
  confidence?: "low" | "medium" | "high";
  sample_size: string; // e.g. "1 refusal observation" (mirrors seedReviewProposals)
  reproducibility: string; // e.g. "single refused run"
  origin_ref: string | null; // the run/baseline lineage id
}

// knowledge_review_queue.evidence — run lineage for the reviewer.
export interface RefusalDraftEvidence {
  refusal_class: RefusalClass;
  origin_kind: RefusalSource["kind"]; // single source of truth (Phase-3b nit: was a re-declared union)
  run_ref: string | null;
  baseline_id?: string | null;
  tenant: string;
}

// Purely additive side effect: classify -> assertWritable -> dedup (2 exact SQL
// predicates) -> INSERT one pending row. Returns void (nothing that can alter a
// verdict). NEVER throws into the caller: the whole body is wrapped in a fail-open
// try/catch that logs and swallows. Runs AFTER the gate has already
// refused. The caller passes the real EstablishResult / VerifyResult;
// it is read structurally as a RefusalSignal.
export async function maybeDraftRefusalCandidate(
  tenant: string,
  signal: RefusalSignal,
  source: RefusalSource,
): Promise<void> {
  try {
    const refusal_class = deriveRefusalClass(signal);
    if (!refusal_class) return; // not a refusal (or an unclassified refusal path) — nothing to draft

    assertWritable(tenant); // reject '__base__' — never write the curated base

    const tid = await tenantIdForWrite(tenant);

    // Dedup 1: an active METHOD card already carries the exact class tag — skip.
    // Deterministic exact SQL predicate, GIN-indexed (the cards_tags_idx GIN index in
    // db/001_schema.sql) — NOT cardSearch (no embed, no similarity threshold that could
    // false-suppress a genuinely-new lesson).
    const [existingCard] = await sql`
      select 1 from cards
      where tenant_id = ${tid} and type = 'METHOD' and status = 'active'
        and tags @> ARRAY[${"class:" + refusal_class}]::text[]
      limit 1`;
    if (existingCard) return;

    // Dedup 2: a queue row of ANY status already covers this class — skip.
    // Dropping the status='pending' filter also closes the rejected-class re-draft gap (a decided
    // row persists in-place; payload.refusal_class survives). Check-then-insert, no backing unique
    // index — a concurrent double-refusal is a documented residual, same window as
    // seedReviewProposals.
    const [existingQueueRow] = await sql`
      select 1 from knowledge_review_queue
      where tenant_id = ${tid} and payload->>'refusal_class' = ${refusal_class}
      limit 1`;
    if (existingQueueRow) return;

    // source_ref narrowed on source.kind (RefusalSource is a discriminated union — baseline_id
    // only exists on the 'verify' variant, Phase-3b forward-note).
    const baseline_id: string | null = source.kind === "verify" ? source.baseline_id : null;
    const run_ref = source.run_ref ?? null;
    const source_ref = run_ref ?? baseline_id ?? null;
    const goal = source.goal ?? "";
    const reason = (signal.reason ?? "").trim();
    const title = `Refusal captured: ${refusal_class}`;
    const body = reason || `Refusal classified as ${refusal_class} (no reason text available).`;

    const payload: RefusalDraftPayload = {
      type: "METHOD",
      title,
      body,
      refusal_class,
      tags: ["refusal-capture", `class:${refusal_class}`],
      confidence: "medium",
      sample_size: "1 refusal observation",
      reproducibility: "single refused run",
      origin_ref: source_ref,
    };

    const evidence: RefusalDraftEvidence = {
      refusal_class,
      origin_kind: source.kind,
      run_ref,
      baseline_id,
      tenant,
    };

    const source_label = `auto-refusal · ${refusal_class} · ${goal.slice(0, 60)}`; // A4: mirrors 'auto-seed · ... · ...'
    const rationale = body;

    await sql`
      insert into knowledge_review_queue
        (tenant_id, type, status, source_kind, source_ref, source_label, title, rationale, payload, evidence, high_stakes)
      values
        (${tid}, 'learning', 'pending', 'manual', ${source_ref}, ${source_label},
         ${title}, ${rationale}, ${sql.json(payload as any)}, ${sql.json(evidence as any)}, ${false})`;
  } catch (err) {
    // FAIL-OPEN: the gate's already-computed verdict stands untouched regardless of
    // whether classify/dedup/insert succeeds, fails, or is skipped (a __base__ tenant's
    // assertWritable throw lands here too, mirroring captureVerdict's read-only handling).
    console.error(`[refusal-capture] draft attempt failed (fail-open) for tenant '${tenant}':`, err instanceof Error ? err.message : err);
  }
}
