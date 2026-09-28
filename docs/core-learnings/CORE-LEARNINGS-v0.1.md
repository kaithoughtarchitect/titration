# Core Learnings v0.1 — the curated universal base

Domain-agnostic Titration discipline. Eleven cards: the judge-discipline + measurement-integrity cluster. See `README.md` for the curation rule. `Illustrative` blocks are examples, not part of the principle.

---

## T-MET-001 — Strict-match is below the judge for semantic questions

- **Type:** METHOD · **Confidence:** high · **Tags:** judge-discipline, measurement-integrity, false-positives

**Principle.** Strict-match operators (regex, keyword, `===`, substring, set-membership) are valid authority for **structural** questions only — does the JSON parse, does the field exist, is the value in a known range. **Semantic** questions — are these the same thing, did the output honor the instruction, is it coherent — require an LLM judge. *The question type, not the implementation, decides which to use.*

**Why it matters.** On a semantic question strict-match fails in both directions: it phantom-flags equivalents written differently (false positive) and misses real failures hidden in paraphrase (false-clean). Either way it measures the analyst's surface intuition, not the system. Two gates: **runtime** (every strict-match hit on content is judge-verified in the same call; flagged-but-judge-rejected = INCONCLUSIVE, never a silent override) and **pre-flight** (audit every content pattern set for false positives/negatives before the first capture).

**Illustrative (one domain).** A compliance check compared two labels with `===`; one side emitted a raw slug, the other the same value humanized for display, differing only cosmetically. Strict equality reported ~25% "drift"; the true drift was 0%. The check was binary (`==`) but the question was fuzzy (`≈`).

**Relationships.** `cures` T-REG-001
**Origin.** Titration evaluation practice.

---

## T-MET-004 — Look at raw artifacts before building the abstraction

- **Type:** METHOD · **Confidence:** high · **Tags:** measurement-integrity, rubric-design

**Principle.** Before authoring a rubric or a metric, read the actual captured outputs by hand (a working floor is ≥20 baseline artifacts). A rubric written without prior human exposure to the corpus encodes the analyst's assumptions, not the system's observed behavior — and the diagnostic silently inherits those assumptions. Run a cheap end-to-end probe first to catch plumbing bugs before any measurement.

**Why it matters.** The named failure modes you'll find are otherwise the categories you *expected*, not the ones that actually exist. The cost is ~30 minutes; the cost of skipping is invisible until a later cycle reveals the rubric was measuring the wrong thing.

**Origin.** Titration evaluation practice.

---

## T-MET-017 — Freeze the rubric before full labeling

- **Type:** METHOD · **Confidence:** high · **Tags:** rubric-design, measurement-integrity, ship-gate

**Principle.** After the look-before-you-label pass, freeze the rubric for the rest of the evaluation. **Never edit the prompt and the rubric in the same cycle** — if both move, you cannot attribute a metric change to either, and the eval becomes a moving target. If the rubric must change mid-evaluation: pause, revise, re-label the baseline under the new rubric (a new grading run with its own identity), then resume.

**Why it matters.** A drifting measuring stick produces a false comparison verdict — the single most silent failure in iteration. Make the freeze a sealed artifact (hash the rubric + judge prompt + corpus declaration), not a prose promise; prose rules decay under execution pressure, mechanical gates do not.

**Relationships.** `cures` T-FND-001
**Origin.** Titration evaluation practice.

---

## T-MET-018 — Fingerprint every grading run

- **Type:** METHOD · **Confidence:** high · **Tags:** measurement-integrity, reproducibility

**Principle.** Every measurement run records enough identity to be reproducible: system version, prompt version(s) (per-target hashes), corpus version (including provenance share), judge model + parameters, rubric version, model parameters, and timestamps. Put the rubric hash in the output filename so a re-grade cannot silently overwrite a baseline.

**Why it matters.** Without the fingerprint, a later comparison silently measures against a baseline whose composition has drifted, and there is no way to reconstruct what was actually measured. This is the highest-leverage piece of measurement provenance.

**Origin.** Titration evaluation practice.

---

## T-MET-019 — Classify the failure origin before editing

- **Type:** METHOD · **Confidence:** high · **Tags:** failure-origin, measurement-integrity

**Principle.** Every observed failure classifies into one of nine origins: `system-under-test` · `corpus-gap` · `rubric-ambiguity` · `judge-variance` · `formatter / post-processor` · `instrument-failure` · `pre-existing-pattern` · `state-artifact` (+ `cost-exhausted`, runtime loops only). **Only `system-under-test` is a valid target for a prompt/system edit.**

**Why it matters.** Editing the prompt to "fix" any of the other eight optimizes against a broken eval — you tune the system to your own instrument error. In practice ~30–50% of "the prompt is wrong" verdicts trace to a non-`system-under-test` origin on inspection. This is the most silent failure the methodology defends against.

**Relationships.** `complements` T-MET-024
**Origin.** Titration evaluation practice.

---

## T-MET-020 — Report effective-N and calibrate judge noise

- **Type:** METHOD · **Confidence:** high · **Tags:** ship-gate, judge-discipline, measurement-integrity

**Principle.** Every ship-gate metric reports its **scorable denominator** beside its rate ("85% on n=7" is not a ship signal). And the dominant noise source is usually not N but **cross-pass agreement**: the noise floor is `(1 − agreement) × 100` pp, and required sample size is `N = ceil(noise_floor_target / (1 − agreement))`. Rules of thumb hold only when agreement is high (a binary Y/N floor of n≈20 assumes agreement ≥80%); below that, N must rise.

**Why it matters.** A "+5pp" delta looks meaningful until you compute that 85% agreement puts the noise floor at ±15pp. Deltas inside the noise floor are INCONCLUSIVE, not significant.

**Illustrative (one domain).** A harness cleared every effective-N gate (n=55–186) yet landed INCONCLUSIVE on most labels: cross-pass agreement ran 38–76%, producing noise floors of ±24pp to ±62pp that swallowed the observed deltas. Two byte-identical arms even measured 30% vs 0% at n=10 — identical inputs cannot differ, so any single-mode reading at n≤10 is noise calibration, not effect.

**Relationships.** `extends` T-MET-017
**Origin.** Titration evaluation practice.

---

## T-MET-024 — Diagnose, don't prescribe

- **Type:** METHOD · **Confidence:** high · **Tags:** judge-discipline, failure-origin

**Principle.** The judge **names what is wrong and why; it does not propose the fix.** The judge's system prompt forbids replacement wording ("should say…", "the next step is…"). The editor authors repairs, grounded in the diagnostic. Reciprocally, the editor's change must trace back to a named diagnostic finding (an edit a cold reader of the diagnostic could roughly predict) — not invoke a frame the diagnostic never grounded.

**Why it matters.** A prescriptive judge anchors the editor on one fix, collapses signal, and contaminates the audit trail — the evaluation stops measuring what it claims to. Judge surfaces, editor reasons from what was surfaced; when either side prescribes, the causal chain breaks.

**Relationships.** `complements` T-MET-019
**Origin.** Titration evaluation practice.

---

## T-MET-037 — Human-as-judge is the gate for taste

- **Type:** METHOD · **Confidence:** high · **Tags:** judge-discipline, judge-ladder

**Principle.** Pick the judge by question type: structural → strict-match; rule-bound semantic → LLM judge (it scales); **taste / register / aesthetic → a human is ground truth.** LLM judges confidently false-green on taste, because they score measurable structural traits and are blind to whether the language actually reads well.

**Why it matters.** On taste questions an automated metric can look green while the artifact is unusable — and no amount of judges fixes it, because they share the blind spot. Reserve the human rung for the 1–2 taste-critical labels.

**Illustrative (one domain).** Three blind cross-vendor LLM judges scored a set of outputs 82–98% on an exemplar-match rubric and called them green; the owner read the *same* outputs as garbled and unparseable and rejected all of them. Only human-judged rounds drove it from all-fail to pass.

**Relationships.** `complements` T-MET-001, T-MET-038 (the judge ladder)
**Origin.** Titration evaluation practice.

---

## T-MET-038 — Sharded multi-model panel; convergence = systemic fix

- **Type:** METHOD · **Confidence:** medium · **Tags:** judge-discipline, judge-ladder, bulk-review

**Principle.** To quality-gate a large set of generated artifacts, fan out N high-capability reviewers over **disjoint shards** under one rubric. The findings that *all* reviewers raise independently (cross-shard convergence) are **systemic generator defects** — fix the generator, not the individual artifacts. The inverse of "aggregates hide failures": independent reviewers aggregate *into* a systemic signal.

**Why it matters.** It separates one-off artifact defects (patch the artifact) from generator-level root causes (fix the prompt/template once), which a per-artifact pass cannot distinguish.

**Illustrative (one domain).** 35 generated artifacts, 5 reviewer agents over 7 each, one fan-out: independently, all 5 reports flagged the same 3 generator root causes — which justified fixing the generator prompt rather than patching ten outputs.

**Relationships.** `complements` T-MET-037 (the judge ladder: strict → single judge → parallel panel → human)
**Origin.** Titration evaluation practice.

---

## T-REG-001 — Regex as a quality judge ships false-clean

- **Type:** REGRESSION · **Confidence:** high · **Tags:** judge-discipline, false-positives, known-failure-mode

**Principle (the failure mode).** Using a regex / keyword filter as the authority on a "is the content X enough?" question ships real failures as clean. The model substitutes semantic equivalents the pattern cannot see, so the pattern reads pass while the behavior fails. The narrow, canonical case that T-MET-001 generalizes.

**Why it matters.** It is the loudest, most expensive form of false-clean: the verdict says 0% failure with confidence, and the failures ship.

**Illustrative (one domain).** A forbidden-phrase regex read a corpus as "violation eliminated" and ship-eligible; an LLM-judge re-pass on the same outputs found ~47% still failed — the model had swapped in paraphrased equivalents the regex never matched.

**Relationships.** `superseded_by`/`generalized_by` T-MET-001 (LLM-judge is authority on content questions; regex is a fast mechanical sanity check only)
**Origin.** Titration evaluation practice.

---

## T-FND-001 — Length is not quality

- **Type:** FINDING · **Confidence:** high · **Tags:** rubric-design, judge-discipline

**Principle.** A rubric that anchors a quality dimension on word counts ("5 = 30–60 words, 1 = 1–3 words") silently measures verbosity, not quality. Score **signal features** — the named elements that actually constitute the quality you want — not length. The judge shares the generator's instinct to reward fluency and length; name the style you want explicitly so the rubric doesn't reward the model's default.

**Why it matters.** Length- and style-biased rubrics move a number while the real dimension doesn't, and the system "improves" toward more words.

**Relationships.** `cured_by` T-MET-017
**Origin.** Titration evaluation practice.

---

_Next to curate: the corpus-discipline cluster (look-before-label is in; add corpus-as-declared-artifact, production-trace flywheel + provenance, state-fidelity gate), and the remaining measurement-integrity methods. Model/prompt/domain cards (T-MOD-*, T-PRM-*, T-REG-002, domain-specific findings) stay out of scope for the domain-agnostic base and are deliberately excluded._
