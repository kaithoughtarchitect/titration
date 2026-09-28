---
name: titration-harness
description: >-
  Design + validate a Titration "wind tunnel" (a paired-corpus validation harness) BEFORE you spend on
  capture. `harness_design` proposes it: a human-review README, a label schema with authority classes,
  quantified ship-gate thresholds + rationale, and a 5-file manifest. Status is always PROPOSED - wait
  for an explicit "scaffold it" before writing any file. `harness_validate` then scores the design (or
  a scaffolded manifest) against codebase facts you supply. The validated harness - its 5 files and
  the corpus you capture - lives in your own repo; there is no separate declare or sync step. Use when
  the user wants to set up the measurement before testing - "design a test harness / wind tunnel",
  "how do I measure this safely?", "is my eval set sound before I spend on a corpus?", "validate my
  harness". NOT for finding what to test (titration-scout) or running the A/B loop
  (titration-improve). Requires the Titration MCP server. Works under any MCP coding agent.
---

# Titration Harness — stand up a wind tunnel before you spend

This skill sets up a **harness** — the controlled test environment ("wind tunnel") that answers *"did
this change move the metric without regressing the floor?"* Design and validate are two single
advisory model calls; the harness itself is just files — the 5-file manifest plus whatever corpus you
capture — and it lives in **your own repo**. There is nothing to declare, sync, or push, and no browser
step for this skill (that's `titration-improve`'s judge picker).

> **Prereq:** the Titration MCP server, connected to your own Postgres (see the repo README).

## The flow

0. **Gather the facts first.** Read the code and write down, verbatim: the exact allowed output values
   (every category, priority, label set), the output schema, 3-5 real sample inputs with their current
   outputs, the pipeline entry point and the relevant file names, plus what the validator needs (step 2).
   These are your `codebase_facts`, and both calls get the same ones. The server can't see your repo, so
   anything you leave out, the design will mark `UNKNOWN` rather than guess.
1. **Design — `harness_design`** `{ system_description, change_type, codebase_facts, baseline_facts?, project? }` → a
   **PROPOSED** design package: a human-review README, a label schema with authority classes
   (structural / compliance-literal / semantic), quantified ship-gate thresholds + rationale, the
   5-file manifest (capture-corpus / generate-labels / ai-label / analyze-corpus / compare), predicted
   outcomes, and the precedent it applied. **status is always `PROPOSED`** — surface it to the user and
   **wait for an explicit "scaffold it"** before writing any file. (This is the most-expensive-failure
   checkpoint: catching a wrong measurement *before* the capture spend.) `baseline_facts` is optional —
   cite real numbers with a source if you have them (never invented); omit it and the design routes
   baseline capture to its own phase. `project` is optional and only lends the design call whatever
   precedent lives in that project's own cards — it never returns raw cards to the user and never
   enters a verdict.
2. **Validate — `harness_validate`** `{ design_or_manifest, codebase_facts, mode?, project? }` → a
   scored 9-check report `/100` + a recommendation (Proceed 90+ / Revise 70–89 / Reject <70).
   Pass the design package **unchanged**, with the same facts from step 0. If the design lists
   `UNKNOWN` items, answer them in the facts before validating.
   **`codebase_facts` is REQUIRED and is yours to supply** — the server can't see your repo: resolved
   IDs, cited baseline numbers WITH source, the pipeline entry point (the harness calls the pipeline
   function directly, not HTTP/UI), the isolation state (engine flags identical across both arms), and
   the **false-clean traps** (a prompt-override or settings flag that would make the candidate corpus
   identical to baseline). Missing/contradictory grounding → a Critical, which caps the recommendation
   at Revise (or Reject if the score is already below 70). **Advisory, not blocking** — YOU decide
   whether to run capture. `mode: "quick"` re-runs only checks 1, 2, 3, 8 (file-contract, label schema,
   grounding, judge safety) for re-validation after a minor edit; omit it for all 9.
   **Expect a loop, not a one-shot pass.** The validator is deliberately strict, and a first Reject or
   Revise on a real design is normal. Show the user the Critical findings in plain words, fix the design
   (or the corpus, when the finding is a coverage gap), and validate again with the same facts. Scores
   move a few points between runs of an unchanged design; judge progress by the Criticals, not the
   number.
3. **Scaffold and capture, in your own repo.** Once the design is approved ("scaffold it"), write the
   5 files from the manifest, run capture, and keep the resulting corpus wherever you keep test
   fixtures in this repo. The harness's job ends there — grading the labels it produces is a separate
   step, below.

## The grading boundary

A harness captures and structures; the engine grades. Route any **semantic** label (one a judge, not a
regex, decides) through `establish_baseline` and `goal_titrate` (or a one-shot `verify`) — see
`titration-improve` for the full loop, including the local judge picker and the required
`player_model`. A harness file that calls a model API to produce a semantic label verdict itself is a
defect: it bypasses the engine's cross-vendor consensus, noise-floor/effective-N gate,
baseline-reproduction refusal, and frozen rubric.

Keep deterministic **structural** checks — regex, counts, retention math — inside your own harness
files; those never need a judge. Use `goal_titrate` when the verdict needs to show up as an iterated
run; `verify` is a single pass and persists nothing.

## Boundaries

- This skill *designs* and *validates* a harness. It does **not** run the improvement loop (that's
  `titration-improve`).
- `harness_design` / `harness_validate` are **single advisory model calls**, NOT verdicts — they never
  write files, run capture, or touch your repo. You own every GO.
- There is no separate declare step, no sync, no browser consent for this skill. Once validated, the
  harness and its corpus are just files in your own repo, graded the same way any other candidate is
  (`titration-improve`).
