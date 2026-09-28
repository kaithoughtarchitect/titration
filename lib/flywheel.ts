// Titration MCP — the flywheel I/O layer.
//
// The fail-open wrappers around the card store's cardSearch (read advisory context IN
// before a verdict) + cardCreate→runCapture (promote a durable learning OUT after a
// completed run). The PURE decision — what query a read uses, what card a verdict
// promotes — is flywheel-core.ts; this layer does only the DB I/O and, CRITICALLY,
// never lets a ledger read miss or a write failure block or alter a verdict
// (FAIL-OPEN: any error → an empty context / a not-captured note, NEVER a throw). The
// verdict stands on its own; the ledger only annotates it (advisory-only, by design).
//
// REUSE, NOT REBUILD: store.ts wholesale (cardSearch / cardCreate / runCapture /
// assertWritable + the ONE postgres pool). The card store is not re-authored. Writes
// target the caller's project tenant (for example demo) — never __base__ (assertWritable
// rejects it, belt-and-braces with cardCreate's own guard).

import { randomUUID } from "node:crypto";
import { cardCreate, cardSearch, runCapture, assertWritable, sql, tenantId, tenantIdForWrite } from "./store";
import { proposeCards } from "./card-propose";
import type { ProposedSupersession } from "./store";
import { embedOne, toVec } from "./embed";
import {
  buildReadQuery,
  verdictToCard,
  runRefFor,
  type ReadInput,
  type CaptureInput,
  type CardSpec,
} from "./flywheel-core";
import {
  buildReviewSeedRunSummary,
  reviewCaptureCompleted,
  reviewCaptureFailed,
  reviewCaptureNotRun,
  type ReviewCaptureResult,
} from "./flywheel-review-core";

// ── read side (advisory; always-on with a kill-switch upstream; fail-open) ──────

export interface LedgerCard {
  id: string; // selected-workspace identity (`project:T-FND-001`; creator base when explicitly selected)
  card_ref: string;
  type: string;
  title: string;
  score: number;
  edges: string[];
  layer: "project" | "base";
}
export interface LedgerContext {
  consulted: boolean; // did the read actually run? (false = empty query / kill-switched upstream)
  tenant: string;
  query: string;
  cards: LedgerCard[]; // top-k advisory cards (failed-edit memory / domain-calibrated origins)
  error: string | null; // a fail-open note (the read failed) — surfaced, NEVER thrown
}

// Query the tenant ledger for advisory context. Pure-additive: the result is attached
// to the verdict envelope, it never changes the verdict. Any failure (no DB, embed
// failure, no key, unknown tenant) returns an empty context with an `error` note —
// the verdict proceeds exactly as pre-B5.
export async function readLedger(tenant: string, input: ReadInput, k = 5): Promise<LedgerContext> {
  const query = buildReadQuery(input);
  const base: LedgerContext = { consulted: false, tenant, query, cards: [], error: null };
  if (!query) return base; // nothing to search on (e.g. empty goal) — silent, not an error
  try {
    // Public verdict envelopes expose only the selected workspace's ledger.
    // Internal platform methodology is consumed by internal reasoning seams,
    // never returned as browseable cards through ledger_context.
    const res = await cardSearch(query, tenant, k, { activeOnly: true });
    const layer = tenant.trim() === "__base__" ? "base" : "project";
    return {
      consulted: true,
      tenant,
      query,
      cards: (res.results ?? []).map((r: any) => ({
        id: `${layer}:${r.card_ref}`,
        card_ref: r.card_ref,
        type: r.type,
        title: r.title,
        score: r.score,
        edges: r.edges ?? [],
        layer,
      })),
      error: null,
    };
  } catch (e: any) {
    // FAIL-OPEN: a read miss never blocks a verdict.
    return { ...base, error: `ledger read failed (fail-open): ${e?.message ?? e}` };
  }
}

// ── write side (opt-in; fail-open; never __base__) ──────────────────────────────

export interface CaptureResult {
  captured: boolean;
  card_ref: string | null;
  run_ref: string | null;
  type: string | null;
  embedded: boolean; // did the promoted card get its embedding written (→ immediately searchable by the read side)?
  error: string | null;
  // Write-time dedup outcome (additive, fail-open). `deduped:"reinforced"` ⇒ the capture matched
  // an existing card and bumped it instead of creating a new node (card_ref is the EXISTING ref).
  // `proposed_supersession` ⇒ the new card inserted AND a higher-confidence-upgrade advisory was
  // surfaced for a later confirm sweep (NO edge/flip was written). Both null when dedup found nothing.
  deduped?: "reinforced" | null;
  proposed_supersession?: ProposedSupersession | null;
  // AUTO-SEED (the "don't-miss-a-learning" fix): how many reusable-learning proposals this
  // capture drafted + enqueued as `pending` review rows for a human to approve/reject. 0 when the
  // draft found nothing or the (fail-open) seed step failed. Additive — never affects the verdict.
  seeded_review?: number;
  // Empty extraction is reported here instead of becoming an unfinished card for the reviewer.
  review_capture?: ReviewCaptureResult;
}

// Promote a completed verdict's durable learning back to the tenant ledger:
// cardCreate (the FINDING / REGRESSION the pure decision chose) → runCapture (a run
// row + an observed_in edge — the flywheel link back to the card store). Opt-in (the caller gates
// this); returns { captured:false } with no error when there is no durable learning
// (verdictToCard → null, e.g. an inconclusive verify). FAIL-OPEN: a write failure is
// surfaced but never blocks/alters the verdict, which was computed before this ran.
export async function captureVerdict(tenant: string, input: CaptureInput): Promise<CaptureResult> {
  const none: CaptureResult = { captured: false, card_ref: null, run_ref: null, type: null, embedded: false, error: null, deduped: null, proposed_supersession: null, seeded_review: 0, review_capture: reviewCaptureNotRun() };
  try {
    assertWritable(tenant); // never write the curated base (cardCreate guards again)
    const spec: CardSpec | null = verdictToCard(input);
    if (!spec) return none; // no durable learning (inconclusive verify / nothing to record)
    const runRef =
      input.kind === "goal_titrate"
        ? runRefFor({ kind: "goal_titrate", job_id: input.job_id })
        : runRefFor({ kind: "verify", baseline_id: input.baseline_id, nonce: randomUUID().slice(0, 8) });

    // dedupe:true — auto-capture is the #1 near-duplicate source. cardCreate may REINFORCE an
    // existing card (returns `deduped:"reinforced"` + the EXISTING card_ref, no new node) or surface a
    // `proposed_supersession` advisory (new card inserted; NO edge/flip written). Both are additive.
    const created = await cardCreate(tenant, {
      type: spec.type,
      title: spec.title,
      body: spec.body,
      sections: spec.sections,
      tags: spec.tags,
      confidence: spec.confidence,
      sample_size: input.kind === "verify"
        ? "1 frozen-baseline comparison"
        : `1 terminal goal_titrate run (${input.result.turns} turn${input.result.turns === 1 ? "" : "s"})`,
      reproducibility: "single verified run",
      origin_ref: runRef,
    }, { dedupe: true });
    const card_ref = created.card_ref;
    const reinforced = created.deduped === "reinforced";
    await runCapture(tenant, runRef, spec.title, [card_ref]);
    // Embed the promoted card NOW so the read side can surface it — cardSearch filters
    // `embedding is not null`. cardCreate ALREADY embeds on the `create` path (store.ts:228-233
    // embed-on-write, reusing the dedup pre-check vector), so this embedCard is the explicit-promote
    // backstop. SKIP it on a REINFORCE (`deduped:"reinforced"`): that branch returned an existing,
    // already-embedded curated ref — re-embedding it with THIS capture's (duplicate) text would
    // overwrite a curated embedding, violating the "reinforce touches only sample_size/updated_at"
    // invariant. Best-effort otherwise: a failure leaves the card embedded-by-cardCreate or
    // backfillable later, but never loses the card / blocks the verdict.
    const embedded = reinforced ? true : await embedCard(tenant, card_ref);
    // AUTO-SEED the reusable learnings into the review queue (a non-skippable step). Runs AFTER the
    // FINDING/REGRESSION is written; fully fail-open (its own diagnostic result), so it can never block
    // or alter the verdict/capture. This closes the gap where a verdict's durable METHOD/PROMPT_BEHAVIOR
    // learning was left for the agent to hand-extract and could be silently missed.
    const review_capture = await seedReviewProposals(tenant, input, spec, runRef);
    return {
      captured: true, card_ref, run_ref: runRef, type: spec.type, embedded, error: null,
      deduped: created.deduped ?? null,
      proposed_supersession: created.proposed_supersession ?? null,
      seeded_review: review_capture.proposal_count,
      review_capture,
    };
  } catch (e: any) {
    // FAIL-OPEN: surface the failure, never throw — the verdict already stands.
    return { ...none, error: `ledger capture failed (fail-open): ${e?.message ?? e}` };
  }
}

// Embed one freshly-promoted card so vector search can immediately surface it.
// Best-effort + isolated: its own try/catch so an embedding hiccup never unwinds the
// already-written card (which a later embed-cards pass would still backfill).
async function embedCard(tenant: string, cardRef: string): Promise<boolean> {
  try {
    const tid = await tenantId(tenant);
    const [card] = await sql`
      select title, body from cards
      where tenant_id = ${tid} and card_ref = ${cardRef}`;
    if (!card) return false;
    const vec = toVec(await embedOne(`${card.title}\n\n${card.body}`));
    await sql`update cards set embedding = ${vec}::vector where tenant_id = ${tid} and card_ref = ${cardRef}`;
    return true;
  } catch {
    return false;
  }
}

// AUTO-SEED the review queue with the run's reusable NON-verdict learnings (METHOD / PROMPT_BEHAVIOR /
// MODEL_PROFILE / DATASET_NOTE — proposeCards never drafts FINDING/REGRESSION, those are THIS capture).
// The verdict flywheel is the one place both verify AND goal_titrate captures pass through, so seeding
// here makes the seeding step non-skippable: every captured verdict draws its durable learnings into
// the human review inbox instead of relying on the agent to remember the extraction ritual.
//
// FAIL-OPEN + isolated (own try/catch returns a diagnostic, never throws): a proposeCards miss or an
// insert failure leaves the already-written verdict + FINDING untouched. Enqueues each draft as a
// `pending` row, with the same duplicate_of normalization used elsewhere (a proposeCards `duplicate_of`
// is copied to `card_ref` so an approved duplicate UPSERTS the named card). The write targets the
// caller's already-firewalled write tenant (assertWritable ran).
async function seedReviewProposals(tenant: string, input: CaptureInput, spec: CardSpec, runRef: string): Promise<ReviewCaptureResult> {
  let seeded = 0;
  try {
    const tid = await tenantIdForWrite(tenant);
    // The FINDING/REGRESSION body already summarizes the outcome; add the goal so the proposer can
    // ground a reusable lesson on WHAT was being achieved.
    const runSummary = buildReviewSeedRunSummary(input, spec);
    const drafted = await proposeCards({ run_summary: runSummary, tenant, run_ref: runRef });
    const proposals = drafted?.proposals ?? [];
    // The two slices carry different terminal shapes — narrow by kind (VerifySlice has the rates;
    // GoalSlice has convergence/turns). Both go into the review row's evidence for the reviewer.
    const evidence =
      input.kind === "verify"
        ? {
            baseline_id: input.baseline_id,
            baseline_rate: input.result.baseline_rate,
            candidate_rate: input.result.candidate_rate,
            metric_delta: input.result.metric_delta,
            floor_intact: input.result.floor_intact,
            run_ref: runRef,
          }
        : {
            baseline_id: input.baseline_id,
            converged: input.result.converged,
            decision: input.result.decision,
            turns: input.result.turns,
            overall_progress: input.result.overall_progress,
            run_ref: runRef,
          };
    for (const p of proposals) {
      if (!p || typeof p.type !== "string" || !p.title) continue; // skip a malformed draft, never throw
      const payload: Record<string, unknown> = {
        type: p.type,
        title: p.title,
        body: typeof p.body === "string" ? p.body : "",
        sections: Array.isArray(p.sections) ? p.sections : undefined,
        tags: Array.isArray(p.tags) ? p.tags : undefined,
        confidence: typeof p.confidence === "string" ? p.confidence : undefined,
        sample_size: p.sample_size ?? (input.kind === "verify" ? "1 frozen-baseline comparison" : "1 terminal goal_titrate run"),
        reproducibility: p.reproducibility ?? "single verified run",
        origin_ref: runRef,
        // Normalize: duplicate_of → card_ref so an approved duplicate upserts the named card.
        ...(p.duplicate_of ? { card_ref: p.duplicate_of, duplicate_of: p.duplicate_of } : {}),
      };
      await sql`
        insert into knowledge_review_queue
          (tenant_id, type, status, source_kind, source_ref, source_label, title, rationale, payload, evidence, high_stakes)
        values
          (${tid}, 'learning', 'pending', ${input.kind}, ${runRef},
           ${`auto-seed · ${input.kind} · ${input.goal.slice(0, 60)}`}, ${p.title},
           ${typeof p.rationale === "string" && p.rationale ? p.rationale : spec.title},
           ${sql.json(payload as any)}, ${sql.json(evidence as any)}, ${false})`;
      seeded++;
    }
    const outcome = reviewCaptureCompleted(seeded);
    if (outcome.status === "no_approval_ready_learning") {
      console.info(`[flywheel] no approval-ready learning for ${tenant}/${runRef}; review queue unchanged`);
    }
    return outcome;
  } catch (e: any) {
    // FAIL-OPEN: the verdict + FINDING already stand; a seed failure is logged, never surfaced as a throw.
    console.error(`[flywheel] auto-seed review proposals failed (fail-open) for ${tenant}/${runRef}:`, e?.message ?? e);
    return reviewCaptureFailed(e, seeded);
  }
}
