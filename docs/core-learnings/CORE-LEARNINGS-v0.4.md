# Core Learnings v0.4 — the curated universal base (batch 4)

Continues v0.1–v0.3. One card, curated from a 2026-07-21 platform incident: a validation
instrument green-lit the exact failure class it existed to catch because the grading-authority
rule lived in prose while every neighboring template modeled the opposite. Same curation rule —
the `Illustrative` block is an example, not the principle.

---

## T-MET-040 — The evaluation engine grades; a harness only captures and ships

- **Type:** METHOD · **Confidence:** high · **Tags:** judge-discipline, measurement-integrity, harness-design

**Principle.** Semantic label verdicts belong to the evaluation engine — the layer that carries the noise-floor / effective-N INCONCLUSIVE gate, baseline-reproduction refusal, the frozen rubric hash, per-mode regression blocking, and accumulated judge memory. A harness file that calls a model API itself to produce label verdicts is a design defect, however carefully its judge is prompted: it silently bypasses every one of those guards and yields numbers with no statistical floor. The harness's role is capture and structure — emit output rows, ship them to the engine, and record the engine's verdict as its artifact. Deterministic, structural labels (regex, counts, well-formedness) stay local: they are mechanics, not judgment. Corollary for tool builders: encode this boundary in the templates and validators themselves, not in prose beside them — a rule stated in documentation while the scaffold's own examples model a local judge will lose to the examples every time.

**Why it matters.** A locally-judged harness looks scientific — multiple models, temperature 0, majority vote — while having none of the engine's guardrails, so it can certify a false-clean result with full confidence. Worse, a validator that only asks "is the local judge safely prompted?" and never "should this judge exist at all?" will score the defect perfectly, turning the measurement instrument itself into the failure.

**Illustrative (one domain).** A scaffolded harness shipped a self-contained 3-judge labeler that called a model gateway directly at temperature 0 and wrote verdicts to a local file; the design validator scored it 100/100 on its judge-safety check because every hardening rule it knew (output-wrapping, treat-as-data, temp 0) was about prompting the local judge safely — not about routing judgment to the engine. It was caught only by a human asking who the judge was.

**Relationships.** `complements` T-MET-038 · `complements` T-MET-020
**Origin.** Platform incident 2026-07-21 (tenant harness scaffold, Day-21 session); the first base card curated from live platform operation rather than an existing prior card.
