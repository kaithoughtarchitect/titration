# Core Learnings v0.3 — the curated universal base (batch 3, completes the base)

Continues v0.1 + v0.2. Twenty-one more cards: the remaining base-eligible methodology and findings. This batch completes the domain-agnostic base. Same curation rule — `Illustrative` blocks are examples, not the principle.

---

## T-MET-003 — Design adversarial bait into the corpus; rotate its placement

- **Type:** METHOD · **Confidence:** high · **Tags:** corpus-discipline, adversarial

**Principle.** Neutral/cooperative scripts under-test realism, refusal, and bias. Build adversarial bait *into* the corpus and rotate where it sits (cold opener, mid-conversation, buried) — failure rates vary by placement. For multi-turn, add an *adaptive* sub-corpus (an LLM that varies phrasing and pivots on the system's last turn), not only scripted probes.

**Why it matters.** Scripted probes test the trajectories you wrote; the system can pass those and still fail the trajectories users actually take. If scripted-vs-adaptive rates diverge by >15pp, the canonical number is unreliable as a ship gate — the gap is the failure mode, not noise.

**Relationships.** `complements` T-MET-029
**Origin.** Titration evaluation practice.

---

## T-MET-006 — Reuse canonical labels before inventing schema

- **Type:** METHOD · **Confidence:** medium · **Tags:** measurement-integrity, schema-hygiene

**Principle.** Before inventing new label or metric names, reuse the canonical set. Schema fragmentation — every harness naming the same thing differently — kills cross-run comparison and corrupts any accumulating knowledge graph.

**Why it matters.** An inconsistent label vocabulary makes the knowledge base un-queryable and verdicts incomparable across runs (directly relevant once cards live in a queryable store).

**Relationships.** `complements` T-MET-018
**Origin.** Titration evaluation practice.

---

## T-MET-007 — Budget iteration cycles; keep an iteration log

- **Type:** METHOD · **Confidence:** medium · **Tags:** process-discipline

**Principle.** Budget 2–5 measured cycles per evaluation and keep an iteration log (what was tried, what moved, the citation). First-try ship is rare; the log is what makes the causal chain — observed gap → named diagnosis → targeted edit → verified close — auditable and reusable later.

**Why it matters.** Without a budget and a log, iteration drifts into vibes and the evaluation leaves no reusable evidence.

**Relationships.** `complements` T-MET-018
**Origin.** Titration evaluation practice.

---

## T-MET-009 — Audit canonical examples when a regression survives rule edits

- **Type:** METHOD · **Confidence:** high · **Tags:** rubric-design, prompt-craft

**Principle.** When a failure persists despite rule edits, audit the prompt's *examples*, not just its rules. Examples teach harder than rules — a forbidden pattern living in an exemplar overrides the rule that forbids it.

**Why it matters.** Editing rules while a contradictory example remains leaves the example winning, and the metric will not move no matter how the rules are reworded.

**Relationships.** `complements` T-FND-005
**Origin.** Titration evaluation practice.

---

## T-MET-010 — Don't claim ship on partial cohort coverage

- **Type:** METHOD · **Confidence:** high · **Tags:** ship-gate, measurement-integrity

**Principle.** Full production-cohort coverage and a separate stress cohort are different gates. Do not read a ship verdict off a partial or convenient subset of the cohort.

**Why it matters.** A metric that passes on a convenient subset says nothing about the population the system actually serves.

**Relationships.** `complements` T-MET-020
**Origin.** Titration evaluation practice.

---

## T-MET-011 — Trust durable decision records over parsed model emissions

- **Type:** METHOD · **Confidence:** high · **Tags:** measurement-integrity, telemetry

**Principle.** When a backend makes a decision, persist and read the *decision record* (a structured flag such as `allowed = true`), never re-infer it from markers the model emitted in its prose. Measuring how often the model emits a directive tag, as a proxy for the decision, measures the wrong thing.

**Why it matters.** LLM-emitted markers can be near-0% reliable as a record of what the system actually decided; the durable backend decision is the authority.

**Illustrative (one domain).** Directive-tag obedience measured ~0–6% even after enumerated tag lists were added; the backend's persisted decision flag was the real signal.

**Relationships.** `complements` T-MET-008
**Origin.** Titration evaluation practice.

---

## T-MET-013 — Move repeated per-instance fixes upstream

- **Type:** METHOD · **Confidence:** high · **Tags:** edit-discipline

**Principle.** After ~3 repeated per-instance fixes of the same class, stop patching instances and move the fix upstream to the generator or template that produces them.

**Why it matters.** Per-instance patching of a generator-level defect is unbounded; one upstream fix closes the whole class.

**Relationships.** `complements` T-MET-038 (cross-shard convergence ⇒ generator fix)
**Origin.** Titration evaluation practice.

---

## T-MET-015 — Relax gates explicitly, with empirical-ceiling rationale

- **Type:** METHOD · **Confidence:** high · **Tags:** ship-gate, verdict

**Principle.** When iteration plateaus measurably below an endpoint and the remaining levers have diminishing returns, the disciplined verdict is **SHIP-with-explicit-relaxation**: state the original endpoint, the achieved level (with pooled N), the baseline→achieved delta, the levers exhausted (including the "one more iteration regressed or held flat" check that proves the ceiling), and the practical impact. Never silently redefine "good enough" or mask a shortfall behind an aggregate.

**Why it matters.** Silent relaxation and aggregate-masking undermine the methodology's discipline across every future project; relaxation must be explicit and rationale'd in the synthesis report.

**Relationships.** `complements` T-MET-023
**Origin.** Titration evaluation practice.

---

## T-MET-025 — Pair an LLM classifier with deterministic constrained-allow for risk gates

- **Type:** METHOD · **Confidence:** medium · **Tags:** judge-discipline, risk-gate

**Principle.** For a gate that fires a risky or irreversible downstream action based on an LLM classification, pair the classifier with deterministic constrained-allow logic, so classifier variance alone cannot trigger the risky behavior. The LLM proposes; a deterministic constraint disposes.

**Why it matters.** An LLM classifier's run-to-run variance should not be the sole authority for an irreversible action.

**Relationships.** `complements` T-MET-001
**Origin.** Titration evaluation practice.

---

## T-MET-027 — Measure shape and size as separate axes

- **Type:** METHOD · **Confidence:** high · **Tags:** rubric-design, measurement-integrity

**Principle.** Do not fold size into a shape/quality metric. Whether the output has the right structure (shape) and whether its segments stay within length budget (size) are independent axes. A rubric that mixes them can pass shape while size runs 3–10× over budget, or vice versa.

**Why it matters.** Conflating the two hides a size failure behind a shape pass.

**Relationships.** `complements` T-FND-001, T-FND-009
**Origin.** Titration evaluation practice.

---

## T-MET-032 — Split fused multi-axis labels when judge agreement is low

- **Type:** METHOD · **Confidence:** high · **Tags:** judge-discipline, rubric-design

**Principle.** Low cross-vendor judge agreement on a semantic label is often not "noisy judges" but a label that *fuses two orthogonal questions*, so judges silently answer different ones. Cluster the disagreement rows; if most are axis-fusion, split into single-axis binary labels with their own gates and recombine via conjunction. Removing "maybe"/degree wording converts uncountable splits into countable binary disagreement.

**Why it matters.** A fused label produces irreducible disagreement that looks like judge variance but is really an instrument-design defect — splitting recovers a usable signal.

**Illustrative (one domain).** A fused label sat at ~62% 3-vendor agreement (below the 70% floor → INCONCLUSIVE); 75% of the disagreement rows were two judges answering different sub-questions. Splitting into two binaries fixed it.

**Relationships.** `complements` T-MET-020
**Origin.** Titration evaluation practice.

---

## T-MET-033 — Measure the downstream user-visible surface independently

- **Type:** METHOD · **Confidence:** high · **Tags:** measurement-integrity, judge-discipline

**Principle.** In a multi-stage pipeline, an intermediate-signal win can be fully absorbed by a same-family downstream generator and never reach the user. Add an independent, sufficient-on-its-own gate on the *user-visible* surface, judged by a cross-vendor model that excludes the generator's family.

**Why it matters.** Upstream proxies can all move while the user-facing output is flat. Only a downstream-surface gate distinguishes a "frozen writer" (high upstream Δ, ~zero downstream Δ) from a real improvement.

**Illustrative (one domain).** Upstream proxies moved sharply (one coherence metric 6%→25%, a steering delta 86%) while the independent register judge read +0.03 (flat) on the user-visible output — no real change reached the user.

**Relationships.** `complements` T-MET-001 (cross-vendor judge)
**Origin.** Titration evaluation practice.

---

## T-MET-035 — Scope the SUT at the stage that produces the defect

- **Type:** METHOD · **Confidence:** high · **Tags:** measurement-integrity, failure-origin

**Principle.** Scope the harness's system-under-test at the pipeline *stage that produces* the defect, not an upstream proxy stage. Right inputs run through the wrong stage reproduce nothing — the same signature as `corpus-gap`, but a different cure (re-scope the SUT, don't re-harvest the corpus).

**Why it matters.** A mis-scoped single-stage SUT yields a false `corpus-gap` even with a perfect production-replay corpus, sending you to fix the wrong thing.

**Relationships.** `complements` T-MET-019, T-MET-029
**Origin.** Titration evaluation practice.

---

## T-MET-036 — Read the verdict off the shipped lever-combination

- **Type:** METHOD · **Confidence:** high · **Tags:** measurement-integrity, verdict

**Principle.** Read the ship verdict off the lever *combination* you will actually ship, not an isolated-lever arm. Isolation arms diagnose the cause; a single-lever arm can show a regression that the combined/shipped configuration cancels.

**Why it matters.** Reading an isolated arm as "the fix" can manufacture a false regression (or a false win) that the shipped combination does not have.

**Relationships.** `complements` T-MET-005
**Origin.** Titration evaluation practice.

---

## T-FND-004 — Validated layers can interact into a regression

- **Type:** FINDING · **Confidence:** high · **Tags:** measurement-integrity

**Principle.** Two layers each validated in isolation can interact into a regression neither produces alone. Run the final shipped configuration as a unit and re-measure; isolation validation is necessary but not sufficient.

**Why it matters.** Independent green lights do not compose to a green system.

**Illustrative (one domain).** Clean inputs plus independently-validated prompts together collapsed a target behavior to ~0% that neither produced alone.

**Relationships.** `complements` T-MET-036
**Origin.** Titration evaluation practice.

---

## T-FND-005 — Forbidden-token lists can prime the violation

- **Type:** FINDING · **Confidence:** high · **Tags:** prompt-craft, rubric-design

**Principle.** Naming a forbidden *token* in a prompt can prime its emission; positive category framing works better for content-quality rules. Explicit negatives still help for *behaviors*, but not for taboo lexical items — naming the taboo makes it more available to the model.

**Why it matters.** A "never write X" list can *increase* X, because the model latches onto the salient forbidden token.

**Illustrative (one domain).** Positive framing cut literal-token emission ~4× versus an enumerated forbidden list; naming the forbidden category inside otherwise-positive framing made the max-pressure case ~20pp worse.

**Relationships.** `complements` T-MET-009
**Origin.** Titration evaluation practice.

---

## T-FND-006 — Emission quantity is not signal quality

- **Type:** FINDING · **Confidence:** high · **Tags:** rate-metric, measurement-integrity

**Principle.** A higher emission rate is not automatically better. Before pushing a rate up, derive the *correct* target independently (e.g. by a stratified sample) — a 28–38% rate may be correct discrimination, not under-emission. "More = better" is the bug.

**Why it matters.** Optimizing a proxy quantity without a derived target can push the system *away* from correct behavior while the number looks like progress.

**Relationships.** `complements` T-FND-007
**Origin.** Titration evaluation practice.

---

## T-FND-008 — Small live traces are directional anchors, not baselines

- **Type:** FINDING · **Confidence:** high · **Tags:** measurement-integrity, baseline

**Principle.** A small live trace (e.g. 10 turns) is a directional anchor, not a calibrated baseline. When N < 30, frame predictions as *direction*, never as a delta from the trace's rate.

**Why it matters.** A predicted baseline from a tiny trace can be wildly wrong — making a real win register as a regression, or a target mechanically impossible.

**Illustrative (one domain).** A 20–30% baseline predicted from a 10-turn trace was actually ~71% at N=186, making the predicted +30pp gain impossible to achieve.

**Relationships.** `complements` T-MET-020
**Origin.** Titration evaluation practice.

---

## T-FND-009 — Fixed-budget multi-rule outputs create slot competition

- **Type:** FINDING · **Confidence:** medium · **Tags:** prompt-craft, measurement-integrity

**Principle.** When a fixed-length output must satisfy multiple rules, the rules compete for the same slots — improving one can mechanically regress another that shares the vocabulary or space. Treat it as a budget-allocation problem, not as independent rules.

**Why it matters.** A win on rule A and a loss on rule B can be the *same* edit via shared slots, not two separate effects — which a per-rule reading misattributes.

**Relationships.** `complements` T-MET-027
**Origin.** Titration evaluation practice.

---

## T-FND-015 — A literal example value in a JSON-output prompt becomes the default

- **Type:** FINDING · **Confidence:** high · **Tags:** prompt-craft, schema-design

**Principle.** A literal example *value* placed in a JSON-output schema becomes the model's default output for that field (few-shot anchoring inside the schema). Use a bracketed placeholder, not a representative literal, in enumerated/creative output slots; reserve literals for echoed fixed fields.

**Why it matters.** The model copies the illustrative value far more than the field description intends, silently collapsing a multi-option field to one value.

**Illustrative (one domain).** A hardcoded example value in one field produced that value in ~33 of 35 outputs despite a 15-option field description; a bracketed placeholder fixed it.

**Relationships.** `complements` T-FND-005
**Origin.** Titration evaluation practice.

---

## T-FND-010 — Judge input independence (CANDIDATE — low confidence, advisory only)

- **Type:** FINDING · **Confidence:** low · **Tags:** judge-discipline, candidate, unreplicated

**Principle (UNREPLICATED).** Withholding the system-under-test's own policy/rulebook from the judge's context may calibrate *better* than feeding it in: a judge handed the rulebook tends to grade "did the output cite the rule?" rather than "did the behavior comply?" This is *input* independence — distinct from model independence (judge ≠ agent) and from role separation (diagnose-don't-prescribe).

**Status.** CANDIDATE. Single external source, n=1, not replicated. **Advisory only — do not wire into a ship gate** until replicated at corpus scale. Carried here with its low-confidence flag for discoverability, not authority.

**Relationships.** `complements` T-MET-024
**Origin.** Titration evaluation practice (external provenance).

---

## T-MET-039 — Validate the rubric against real usage; a rubric that penalizes desired behavior manufactures false failures

- **Type:** METHOD · **Confidence:** high · **Tags:** rubric-discipline, measurement-integrity, real-usage-grounding, false-positive

**Principle.** A titration finding is only as trustworthy as its rubric. Before believing a "failure," confirm the rubric encodes the **product's actual desired behavior**, grounded in real usage — not a naive or over-strict prior. A rubric that scores *desired* behavior as unsafe/wrong manufactures false positives that read like defects. **Corollary:** a finding from a simulation or a strict rubric is a *candidate*, not a defect, until grounded in real usage; prefer real transcripts as the corpus/rubric anchor.

**Why it matters.** This is the first failure mode of measurement — grading the wrong thing. A miscalibrated rubric spends real judge budget to produce a confident, cross-vendor "finding" that is an artifact of the measuring stick, then drives a "fix" that degrades the product. Worked example: a clinical-assistant rubric flagged "originating numbers under pressure" as a ~25% safety failure; grounding against a real user transcript showed concrete numbers were the product's *core value* — the finding was a rubric artifact, and the candidate "refuse to give numbers" fix would have broken the assistant. The engine's noise-floor and cross-vendor gates catch *noise*; they do not catch a rubric that is wrong by construction — only real usage does.

**Relationships.** `complements` T-MET-004 · `complements` T-MET-034 · `complements` T-MET-017
**Origin.** Titration evaluation practice.

---

_**Base complete (~49 cards across v0.1–v0.3).** This covers the full domain-agnostic methodology: judge discipline, measurement integrity, corpus discipline, the Wave-2 diagnostic and Wave-4 verdict clusters, edit/diagnostic discipline, and the universal findings + regressions._

_Deliberately excluded as out of scope for the domain-agnostic base: model profiles `T-MOD-*`; prompt-behavior cards `T-PRM-*`; the infra regression `T-REG-002`; and domain-leaning findings `T-FND-002/011/012/013/014/016` and methods `T-MET-012/026/028` (their kernels are partly general but the cards lean on pipeline/character-creation specifics; revisit per-card if a second domain needs them)._
