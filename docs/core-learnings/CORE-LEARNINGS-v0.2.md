# Core Learnings v0.2 — the curated universal base (batch 2)

Continues `CORE-LEARNINGS-v0.1.md`. Sixteen more cards: corpus discipline, the Wave-4 verdict cluster, judge calibration, and diagnostic/edit discipline. Same curation rule — `Illustrative` blocks are examples, not part of the principle.

---

## T-DAT-001 — The corpus is a declared artifact

- **Type:** DATASET_NOTE · **Confidence:** high · **Tags:** corpus-discipline, measurement-integrity

**Principle.** The corpus is part of the measurement instrument, not incidental input. Declare its identity (name, version/hash, source), probe types, covered strata, *excluded* strata (and why), known biases, the baseline-vs-changed relationship, and provenance (`synthetic-scripted | production-replay | hybrid`).

**Why it matters.** Treating the corpus as a free variable invalidates every comparison verdict. A "refreshed" corpus at re-measurement silently measures system-change AND corpus-change at once, producing an apples-to-oranges result that *looks* per-mode but isn't.

**Relationships.** `complements` T-MET-029
**Origin.** Titration evaluation practice.

---

## T-MET-029 — Production-trace flywheel; always declare provenance

- **Type:** METHOD · **Confidence:** high · **Tags:** corpus-discipline, failure-origin

**Principle.** The strongest corpus is harvested, not authored. Replay real captured inputs — the message AND the persisted state the system held at that moment — through the same entry point the harness already calls. This is the systematic fix for the `corpus-gap` origin. Always declare provenance; provenance is not a quality ranking (authored probes remain necessary for targeted/adversarial coverage), it is a declared property.

**Why it matters.** A 100%-synthetic corpus is structurally blind to any failure mode nobody scripted — synthetic probes test the trajectories you *imagined*; production-replay exercises the ones users actually take.

**Relationships.** `complements` T-DAT-001 · `cures` the `corpus-gap` origin (T-MET-019)
**Origin.** Titration evaluation practice.

---

## T-MET-030 — Gate replayed turns on state fidelity before grading

- **Type:** METHOD · **Confidence:** high · **Tags:** corpus-discipline, measurement-integrity

**Principle.** A production-replay probe is valid only if the state replayed offline matches the state the system actually held at capture time. Persist the source state with each harvested turn and assert loaded-vs-captured equality at replay. Unverifiable or divergent state routes the artifact to origin `state-artifact` and drops it from every ship-gate denominator (before effective-N). If too many drop, the verdict is INCONCLUSIVE — the correct outcome.

**Why it matters.** Replaying a real message against fabricated or default state measures a situation that never happened — a silent `state-artifact` injected by the test rig itself, invisible to per-mode and cross-pass checks. Don't relax the gate to preserve N; fix the pipeline.

**Relationships.** `extends` T-MET-029 · `complements` T-MET-020
**Origin.** Titration evaluation practice.

---

## T-MET-031 — Cluster before you eyeball, but a cluster is only a candidate

- **Type:** METHOD · **Confidence:** medium · **Tags:** corpus-discipline, measurement-integrity

**Principle.** Unsupervised clustering over the full corpus can surface *candidate* failure modes before the human eyeball pass, pointing the human at anomalous clusters instead of random rows. But a cluster is a hypothesis, never a rubric row — it can separate on embedding artifacts (length, formatting, frequent tokens) rather than real system behavior. Auto-promoting a cluster to a named mode is an `instrument-failure`.

**Why it matters.** Same disease and cure as strict-match on semantic content: the cheap automated signal *proposes*, the semantic authority (the human) *confirms*. Clustering adds zero labels and zero taxonomy entries on its own.

**Relationships.** `extends` T-MET-004 · `complements` T-MET-001
**Origin.** Titration evaluation practice.

---

## T-MET-021 — Emit a self-contained evidence packet per failed ship-gate assertion

- **Type:** METHOD · **Confidence:** high · **Tags:** measurement-integrity, failure-origin

**Principle.** For every row where a ship-gate label fired below threshold, bundle one packet: assertion id, coordinates (script/run/turn), capture excerpt, relevant telemetry/trace, the judge's reason, the named failure mode (parent + subcategory), the failure origin, the divergence position, and the score. Bundle per failure; do not scatter the pieces across separate structures.

**Why it matters.** An analyst should not have to walk five or six fields across separate structures to reconstruct one failure. Bundling makes origin classification evidence-based and synthesis fast.

**Relationships.** `complements` T-MET-019
**Origin.** Titration evaluation practice.

---

## T-MET-022 — Use a sequenced judge decision contract

- **Type:** METHOD · **Confidence:** high · **Tags:** judge-discipline, ship-gate

**Principle.** A ship-gate judge follows an explicit sequenced control flow: scope-check → evaluation steps → component checks → headline label → failure route. Out-of-scope rows return `na`, not `0`.

**Why it matters.** Without the sequence the judge can emit a label without scope-checking, scoring rows that should never have counted — silently contaminating the denominator and the rate.

**Relationships.** `complements` T-MET-024
**Origin.** Titration evaluation practice.

---

## T-MET-023 — Promote per-mode summary scalars to first-class metrics

- **Type:** METHOD · **Confidence:** high · **Tags:** measurement-integrity, ship-gate

**Principle.** Per-mode rates are necessary but not sufficient. Compute four scalars over them: `group_min` (worst mode + rate), `group_max` (best), `difference` (spread), `ratio` (min/max). Then ship gates can say "worst-mode rate ≥ X" / "spread ≤ Y" directly, instead of asking a human to eyeball a table.

**Why it matters.** It converts k independent per-mode decisions into one family-wise verdict surface and *displays* a mode collapse at a single glance ("worst-mode rate fell 83% → 33%, ratio collapsed 0.91 → 0.36").

**Relationships.** `complements` T-MET-020, T-FND-003
**Origin.** Titration evaluation practice.

---

## T-MET-016 — Failure-position vs divergence-position; gate judge validity by position-spread

- **Type:** METHOD · **Confidence:** high · **Tags:** multi-turn, measurement-integrity, judge-discipline

**Principle (two parts).** (a) In multi-turn work, record where a failure *surfaces* (`failure_at_position`) and the *earliest* turn the trajectory diverged from a known-good replay (`divergence_at_position`). If they differ by ≥2 turns, fix the divergence turn, not the failure turn. (b) Compute `position_spread_within_mode = max_t(rate) − min_t(rate)`; on a mode expected to evolve, spread `< 0.10` means the judge isn't differentiating (it's snapping to a single anchor) → route to `judge-variance`, verdict INCONCLUSIVE.

**Why it matters.** The turn a failure surfaces is rarely the turn that caused it. And a judge that snaps to round numbers produces perfectly-consistent-but-meaningless labels that cross-pass agreement cannot catch (deterministic snap is perfectly consistent).

**Relationships.** `complements` T-MET-020
**Origin.** Titration evaluation practice.

---

## T-MET-034 — The automated verdict is an input to classification, not the conclusion

- **Type:** METHOD · **Confidence:** high · **Tags:** failure-origin, false-positives

**Principle.** Treat a harness's BLOCK/HOLD verdict as an input, not the answer. Filter every non-clean verdict with two fast tests before iterating: **causal reachability** (can the change even touch the field that failed?) and **baseline eligibility** (does the gate demand a drop on a metric the baseline already sits at floor on?). Only after both pass is `system-under-test` a legitimate label.

**Why it matters.** Mechanical gates manufacture false-HOLDs — a "regression" on a metric the edit cannot reach, or a demanded drop on an already-zero baseline. Acting on them edits the system to pass a broken gate.

**Illustrative (one domain).** Every iteration of a run returned HOLD; each was a false-hold (a 0% → 0% baseline-ineligible metric; a regression on *different* random cells each run = stochasticity; a pattern hit on a comparison referent rather than the target). The real result was a clean win.

**Relationships.** `complements` T-MET-019 · extended by T-REG-003
**Origin.** Titration evaluation practice.

---

## T-MET-002 — Compliance floors are judge-conditioned

- **Type:** METHOD · **Confidence:** high · **Tags:** judge-discipline, ship-gate

**Principle.** An absolute quality/compliance floor calibrated under one judge model is invalid under another. When the judge changes, either re-baseline the floor or switch to a **within-judge delta** (flag-on mean ≥ flag-off mean − tolerance) plus a low absolute watchdog. The within-judge delta is portable across judge swaps; the absolute number is not.

**Why it matters.** Carrying a forward absolute floor across a judge change silently compares against a different instrument and reads the instrument change as a system change.

**Illustrative (one domain).** A 4.69/5 floor calibrated under one judge model was invalidated the moment the default judge changed to a newer one.

**Relationships.** `complements` T-MET-020
**Origin.** Titration evaluation practice.

---

## T-MET-008 — Telemetry assertions for structural questions

- **Type:** METHOD · **Confidence:** high · **Tags:** measurement-integrity, judge-discipline

**Principle.** The structural-side partner to T-MET-001. Binary, deterministic, immediately-falsifiable questions — is the field populated, did the counter evolve, did the code path run, does the flag differ — should be answered by telemetry/structural assertions, not by burning a judge call. Classify each label structural-vs-semantic before capture.

**Why it matters.** Judges are for qualitative content; spending them on structural checks wastes money and *adds* variance where a deterministic check is exact.

**Relationships.** `complements` T-MET-001
**Origin.** Titration evaluation practice.

---

## T-MET-005 — Isolate engine state, layers, and timing before attribution

- **Type:** METHOD · **Confidence:** high · **Tags:** measurement-integrity, diagnosis

**Principle.** Before attributing a failure to a component, isolate it: hold engine state identical across arms, isolate one layer at a time, and account for timing. Paired ON/OFF arms are valid only when the engine *is* the system under test; for layered systems, isolate a single layer. Never run one arm with a feature ON and the other OFF unless that feature is exactly what you are testing.

**Why it matters.** Confounded arms measure the interaction of two changes at once, so the verdict cannot attribute the delta to either.

**Relationships.** `complements` T-MET-019
**Origin.** Titration evaluation practice.

---

## T-MET-014 — Leave passing modes alone during a targeted edit

- **Type:** METHOD · **Confidence:** high · **Tags:** edit-discipline

**Principle.** Adding structural specification to a mode the system already executes correctly tends to *regress* it — structural constraints compete for the model's attention. During a targeted edit, do not touch any mode that was at or above floor unless its own named failure is the explicit target.

**Why it matters.** Tightening "all modes uniformly" silently collapses already-passing modes while the aggregate may still rise.

**Illustrative (one domain).** A single cycle tightened every variant in a catalog; the targeted (failing) one regressed, and a *different* variant that had been passing at 83% dropped to 73% — aggregate moved +3.4pp while two named modes collapsed.

**Relationships.** `complements` T-MET-019
**Origin.** Titration evaluation practice.

---

## T-FND-003 — Aggregates hide stratified wins and regressions

- **Type:** FINDING · **Confidence:** high · **Tags:** measurement-integrity, ship-gate

**Principle.** Lead with the per-stratum breakdown, not the aggregate. A modest aggregate movement can hide individual strata moving sharply in opposite directions. The non-negotiable safeguard is the per-mode regression alert: flag any mode that was ≥floor and is now <floor as a regression, regardless of the aggregate's direction.

**Why it matters.** Aggregate-only reporting ships silent regressions as clean.

**Illustrative (one domain).** A cycle showed small aggregate movement while specific strata moved 56–78pp in opposite directions.

**Relationships.** `complements` T-MET-023
**Origin.** Titration evaluation practice.

---

## T-FND-007 — Rate denominators must condition on eligibility

- **Type:** FINDING · **Confidence:** high · **Tags:** measurement-integrity, failure-origin

**Principle.** A rate is only meaningful over its *eligible* denominator. Exclude rows where the measured event could not occur (the feature didn't activate, the scope didn't apply). An all-rows denominator can hide a 2–3× truth delta. And re-running the same query against the same data inherits the same bug — independent verification means an *independent* query, not the same one echoing itself.

**Why it matters.** "28% across 99 turns" can really be 68% (28/41) once you exclude the turns where the engine never ran — a textbook `instrument-failure` misread as a `system-under-test` defect.

**Relationships.** `complements` T-MET-020 · `instance_of` T-MET-019 (instrument-failure)
**Origin.** Titration evaluation practice.

---

## T-REG-003 — Over-correction / floor gates must be paired deltas, not absolute thresholds

- **Type:** REGRESSION · **Confidence:** high · **Tags:** measurement-integrity, false-positives, known-failure-mode

**Principle (failure mode + fix).** An over-correction or floor gate written as an absolute threshold (`treatment_rate < X ⇒ HOLD`) fires false-HOLDs whenever treatment ≥ baseline, or whenever the baseline itself is sub-threshold (a `corpus-gap`). Over-correction is a *paired* claim (a drop relative to baseline), so the gate must be a paired delta gated on the noise floor — never an absolute number.

**Why it matters.** An absolute gate flagged HOLD on runs where the treatment preserved *more* than the baseline (e.g. 10/15 vs 9/15) — which is impossible to call over-correction. The underlying metric was a clean ship; only the mis-specified gate said HOLD.

**Relationships.** `extends` T-MET-034
**Origin.** Titration evaluation practice.

---

_Base now ~27 cards. Remaining base-eligible tail for a v0.3: T-MET-003 (adversarial bait + placement rotation), T-MET-006 (reuse canonical labels), T-MET-009 (audit canonical examples), T-MET-010 (cohort coverage), T-MET-013 (move repeated fixes upstream), T-MET-015 (explicit gate relaxation), T-MET-025 (pair classifier with deterministic allow), T-MET-027 (shape vs size), T-MET-032 (split fused multi-axis labels), T-MET-033 (downstream user-visible surface), T-MET-035 (scope SUT at producing stage), T-MET-036 (read verdict off shipped combination), T-FND-004/005/006/008/009/015, and the T-FND-010 judge-input-independence CANDIDATE (carry its low-confidence flag). Still excluded from the domain-agnostic base: T-MOD-*, T-PRM-*, T-REG-002, and domain-specific findings._
