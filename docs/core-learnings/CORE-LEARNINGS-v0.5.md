# Core Learnings v0.5 — retirement curation batch

This batch converts reusable methodology retained from an earlier internal
ledger into domain-independent base cards. It also restores the one base card
that existed only in the database, so the markdown source remains canonical.

Source IDs are traceability only. Each principle below stands without any
of its original character, conversation, model, provider, or infrastructure
context.

---

## T-MET-041 — Read an engine refusal as a diagnosis; never lower a gate to force a verdict

- **Type:** METHOD · **Confidence:** high · **Tags:** measurement-integrity, eval-design, gates, corpus, attribution

**Principle.** A refusal to freeze a baseline, an INCONCLUSIVE effective-N result, or a per-mode regression block is a typed diagnosis of the evaluation, not an obstacle to bypass. Use its reason to repair the measured surface, corpus, or attribution; never lower a gate merely to turn that refusal into a pass. A gate may be relaxed only with an independent empirical-ceiling rationale, never because the current run cannot clear it.

**Why it matters.** A refused verdict is often the cheapest available evidence that the ruler is wrong. Treating it as friction manufactures confidence from a measurement instrument that cannot distinguish signal from noise.

**Illustrative (one domain).** A baseline failed to reproduce because the harness measured an already-cleaned artifact rather than the standing memory map touched by the change. Rebuilding the corpus around the right artifact restored reproduction; widening the genuine residue restored effective-N. No threshold changed.

**Relationships.** `extends` T-MET-020 · `complements` T-MET-015 · `complements` T-MET-039.
**Origin.** Titration evaluation practice.

---

## T-MET-058 — Verify source availability and eligibility before attributing a failure to the prompt

- **Type:** METHOD · **Confidence:** high · **Tags:** corpus-discipline, source-validation, failure-origin, pre-flight

**Principle.** Before attributing a missing behavior to an instruction, verify that its required source exists on real rows and carries the relevant content. A nominally populated field, a mature workflow state, or a long interaction is not evidence that the needed signal is available. Measure take-rate and content eligibility at the actual injection boundary.

**Why it matters.** Prompt edits cannot synthesize dimensions absent from their input. Misclassifying an empty or ineligible substrate as a system-under-test defect wastes iterations and can hide a corpus gap.

**Relationships.** `extends` T-MET-004 · `complements` T-MET-019 · `complements` T-MET-029.
**Origin.** Abstracted from prior internal cards T-FND-011, T-FND-012, and T-FND-014.

---

## T-MET-059 — Repair a shared instruction frame across every surface that inherits it

- **Type:** METHOD · **Confidence:** high · **Tags:** prompt-design, regression-scope, audit-discipline, change-scope

**Principle.** When a defect arises from a reusable instruction frame, template, or convention rather than one local wording choice, treat it as a class defect. Identify every surface that inherits the frame, repair them coherently, and test representative siblings. Fixing only the surface where the bug appeared leaves latent replicas behind.

**Why it matters.** Local fixes make a shared design flaw look solved until another untested surface activates the same failure.

**Relationships.** `extends` T-MET-013 · `complements` T-MET-005.
**Origin.** Abstracted from a prior internal card T-FND-016.

---

## T-MET-060 — Treat any production-divergent harness constant as a variable

- **Type:** METHOD · **Confidence:** critical · **Tags:** harness-fidelity, production-parity, controlled-variable, pre-flight

**Principle.** A component pinned in a harness is a valid controlled constant only when production has the same component at the same setting. If production differs or is unknown, expose the condition as a variable and run the production-faithful arm as a baseline.

**Why it matters.** A harness can mask, manufacture, or invert the observed effect by holding on a component production does not use. Agreement with production must be measured, not assumed.

**Relationships.** `extends` T-MET-005 · `complements` T-MET-029 · `complements` T-MET-018.
**Origin.** Abstracted from a prior internal card T-MET-039.

---

## T-MET-061 — Verify the final assembled context after every destructive transform

- **Type:** METHOD · **Confidence:** high · **Tags:** prompt-assembly, injection-fidelity, diagnosis, silent-failure

**Principle.** When a pipeline injects context and then strips, trims, normalizes, or truncates it, validate the final request sent to the model—not merely the intermediate parameter. Place always-on memory, identity, and safety material after any transform that could erase it, or prove that the transform preserves it.

**Why it matters.** A correct intermediate variable is not evidence that the model received the content. Silent post-injection loss is easily misdiagnosed as a model-recall failure.

**Relationships.** `instance_of` T-MET-060 · `complements` T-MET-030.
**Origin.** Abstracted from prior internal cards T-MET-042 and T-MET-051 (the latter database-only); the original evidence is not part of this public repository.

---

## T-MET-062 — Report bimodal behavior as outcome probability, not a small-sample mean

- **Type:** METHOD · **Confidence:** high · **Tags:** statistics, effective-n, metric-design, bimodal

**Principle.** When independent runs fall into distinct clean-or-failed modes, report the fraction crossing a defined threshold and show the per-run distribution. Do not infer a trend from an average over a few bimodal observations.

**Why it matters.** A small-sample mean can look smooth, monotonic, and precise while concealing a qualitatively unstable process.

**Relationships.** `extends` T-MET-020 · `complements` T-MET-027.
**Origin.** Abstracted from a prior internal card T-MET-040.

---

## T-MET-063 — Measure distinct failures and agreement per feature before reading a gate

- **Type:** METHOD · **Confidence:** high · **Tags:** metric-design, effective-n, noise-floor, feature-level, paired-delta

**Principle.** Before interpreting a quality gate, count distinct failure behaviors rather than repeated appearances of one behavior, compute judge agreement per feature rather than globally, and compare paired deltas rather than chasing headroom on an already-passing floor. The metric unit, its attribution, and its noise floor are part of the verdict contract.

**Why it matters.** Aggregating repeated instances, soft-feature dissent, and unrelated dimensions into one rate makes the score describe the corpus and evaluator more than the system under test.

**Relationships.** `extends` T-MET-020 · `complements` T-MET-023 · `complements` T-MET-062.
**Origin.** Abstracted from prior internal cards T-FND-013, T-MET-044, T-MET-047, and T-REG-004, plus database-only card T-MET-052.

---

## T-MET-064 — Separate structural confirmation from statistical remeasurement

- **Type:** METHOD · **Confidence:** high · **Tags:** verification, remeasurement, harness-fidelity, scope

**Principle.** A short, cheap run can confirm that a structural repair took effect, but it cannot replace a full remeasurement of semantic or statistical outcomes. State-gated subsystems, variance, and regression floors must be exercised under the original measurement conditions before declaring the outcome closed.

**Why it matters.** Treating a narrow confirmation as an at-scale verdict creates false confidence exactly when an implementation looks most persuasive.

**Relationships.** `complements` T-MET-035 · `complements` T-MET-020.
**Origin.** Abstracted from a prior internal card T-MET-049.

---

## T-MET-065 — Ground free-form test actors in explicit truth and isolate adversarial probes

- **Type:** METHOD · **Confidence:** high · **Tags:** harness-design, ground-truth, adversarial-bait, stateful-systems

**Principle.** A free-form synthetic actor is gradeable only when its durable facts and authority boundaries are explicit. Give the actor a fixed truth sheet, prevent unbounded invention, and isolate adversarial bait from any persistent store under test—or assert the store mutation as part of the test.

**Why it matters.** Without a known truth surface, a natural conversation cannot be scored honestly; without probe isolation, the test can contaminate the very state it claims to evaluate.

**Relationships.** `extends` T-MET-029 · `complements` T-MET-003 · `complements` T-MET-030.
**Origin.** Abstracted from prior internal cards T-MET-045 and T-MET-054 (the latter database-only).

---

## T-MET-066 — Give a judge authorized ground truth current to the judged turn

- **Type:** METHOD · **Confidence:** high · **Tags:** judge-design, ground-truth, temporal-fidelity, false-positive

**Principle.** A semantic judge must receive both the context it is authorized to treat as true and the version of that context that existed at the judged turn. A context-free judge invents fabrication; a stale oracle can mark a correct answer as a contradiction.

**Why it matters.** Missing or temporally lagging ground truth creates false failures that depress multiple dimensions and misroute remediation.

**Relationships.** `complements` T-MET-022 · `complements` T-MET-024 · `complements` T-MET-030.
**Origin.** Abstracted from prior internal cards T-MET-041 and T-MET-053 (the latter database-only).

---

## T-MET-067 — Budget structured judgment for its worst-case response and expose parse failure

- **Type:** METHOD · **Confidence:** medium · **Tags:** judge-design, structured-output, execution-integrity, silent-failure

**Principle.** Size a structured judge's output budget for its full reasoning and schema payload, then measure malformed or truncated responses explicitly. Never let an unparseable judgment disappear into an undifferentiated error or not-applicable bucket.

**Why it matters.** A harness can appear to run successfully while silently dropping the most demanding judgments, biasing the observed result.

**Relationships.** `extends` T-MET-022 · `complements` T-MET-001.
**Origin.** Abstracted from a prior internal card T-MET-043.

---

## T-MET-068 — Verify persistence through the authoritative reference read

- **Type:** METHOD · **Confidence:** high · **Tags:** knowledge-integrity, verification, retrieval, write-confirmation

**Principle.** Confirm a newly persisted record through its authoritative identifier read, not through semantic retrieval, a ranked list, or an adjacent system's status. Treat discoverability and persistence as separate properties.

**Why it matters.** A search miss can mean lag, ranking, filters, or a different source of truth; using it as a write verdict produces false data-loss incidents and unsafe retries.

**Relationships.** `complements` T-MET-018 · `complements` T-MET-069.
**Origin.** Abstracted from a prior internal card T-MET-048.

---

## T-MET-069 — Test self-retrieval with diagnostic queries and current truth

- **Type:** METHOD · **Confidence:** high · **Tags:** retrieval-eval, anti-leakage, ground-truth, current-truth

**Principle.** A retrieval evaluation over its own knowledge base must use user-symptom queries rather than card paraphrases, score structurally against declared expected references, and expect the current corrected knowledge rather than an obsolete predecessor.

**Why it matters.** Lexical leakage measures embedding round-trip rather than retrieval quality; stale truth rewards superseded knowledge. Either defect makes later retrieval improvements impossible to trust.

**Relationships.** `complements` T-MET-001 · `extends` T-MET-029 · `complements` T-MET-068.
**Origin.** Abstracted from a prior internal card T-MET-050.

---

## T-MET-070 — Attribute a red frozen test before reverting or re-freezing

- **Type:** METHOD · **Confidence:** high · **Tags:** characterization-test, regression, attribution, freeze-discipline

**Principle.** A frozen characterization, snapshot, or golden test that turns red is an attribution question before it is a verdict on the current change. Compare against the prior known-good revision, identify the change that moved the behavior, and only then choose revert, repair, or intentional re-freeze.

**Why it matters.** In concurrent work, an old unrecorded drift can be mistakenly blamed on the current edit; reflexive re-freezing then destroys the only signal that could identify it.

**Relationships.** `complements` T-MET-017 · `complements` T-MET-041.
**Origin.** Abstracted from a prior internal card T-MET-055.

---

## T-MET-071 — Do not deterministically resolve an unverified fact conflict at write time

- **Type:** METHOD · **Confidence:** high · **Tags:** memory-integrity, conflict-resolution, evidence-accumulation, stateful-systems

**Principle.** When two observations conflict on a single-valued fact, do not silently choose a winner at write time unless the source and change semantics make that decision authoritative. Preserve the conflict, seek corroboration or adjudication, and make the eventual resolution auditable.

**Why it matters.** Newest-wins accepts adversarial claims; established-wins blocks genuine change; keeping both without lifecycle treatment pollutes downstream reasoning. The correct policy depends on evidence not available at first write.

**Relationships.** `extends` T-MET-003 · `complements` T-MET-019 · `complements` T-MET-065.
**Origin.** Abstracted from a prior internal card T-MET-056.

---

## T-MET-072 — Tune extraction recall through both salience and batch scope

- **Type:** METHOD · **Confidence:** high · **Tags:** extraction, batch-size, recall, prompt-design, cadence

**Principle.** A conservative extractor can miss an explicit fact for two independent reasons: its instruction does not value that fact type, or a large batch dilutes the fact among more salient content. Tune semantic salience and batch scope together, then measure recall on deliberately buried examples.

**Why it matters.** Fixing only the prompt or only the cadence can leave recall at zero, leading teams to misdiagnose an extraction problem as a missing-data problem.

**Relationships.** `extends` T-MET-064 · `complements` T-MET-058.
**Origin.** Abstracted from a prior internal card T-MET-057.
