---
name: titration-improve
description: >-
  Run Titration's improvement loop - establish a frozen baseline, then titrate a prompt/system toward
  a goal: YOUR agent makes each change and runs it, shipping the candidate outputs while Titration
  GRADES them against the frozen baseline via cross-vendor judge consensus. The engine never runs your
  code; it never claims a win it can't tell from noise. Grading uses the user's own judges -
  subscription CLIs (`claude` / `codex` / `grok`) or OpenRouter (metered) - picked once per baseline
  in a local browser picker. Use when the user wants to know whether a change actually helped - "is v2
  better than v1?", "did this prompt change help or is it just noise?", "A/B / verify / titrate these
  two versions", "should I ship this change?" - or right after titration-scout picks a target. NOT for
  FINDING what to test (titration-scout) or designing a harness (titration-harness). Requires the
  Titration MCP server connected, and the Player's own model id for `player_model`. Works under any
  MCP coding agent.
---

# Titration Improve — titrate a prompt to a goal, with a verdict you can trust

This skill drives Titration's **client-ships-outputs improvement loop**: *you* make the change and run
it; Titration **grades** the outputs against a frozen baseline and tells you whether it actually
helped — never a win it can't distinguish from noise, and never an aggregate gain that hides a
per-mode regression.

> **The contract:** the engine **never runs your code.** You run each candidate locally, capture its
> outputs, and ship them inline as `OUTPUT_ROW`s. Your source / prompt / system stay on your machine —
> the server is the one your `TITRATION_DATABASE_URL` points at, and grading calls go to judges you
> chose (below), never anywhere else.

> **Cost, said plainly:** grading spends real judge calls. A subscription-CLI judge (`claude`,
> `codex`, `grok`) costs nothing beyond the subscription the user already pays for. An OpenRouter judge
> is billed per call, by OpenRouter, on the user's own key. Say this before the first `establish_baseline`
> spend, and again if a later run would add a metered judge that wasn't already in play.

## `player_model` — who is doing the work

`establish_baseline`, `verify`, `goal_titrate`, and `goal_titrate_step` all require `player_model`: the
model id of the agent making the change under test (yours, right now). The engine uses it to refuse a
judge that shares your own vendor family — a model is never allowed to grade its own family's work.
Pass `player_family` only when `player_model` itself isn't a resolvable model id (an internal or
fine-tuned name, for instance); an unresolvable id with no `player_family` is a typed refusal, not a
silent "no exclusion."

## `OUTPUT_ROW` — what you ship each turn

An array of `{ output (required), mode?, input?, record?, capture?, id? }`.

**What reaches a judge** (exactly this, nothing else): `mode` (rendered as the
authoritative BUCKET line), `record` (rendered as the authoritative RECORD block),
`input` (rendered as INPUT context), and `output`. `id` and `capture` are measurement
metadata and are never shown to a judge.

- `output` — the captured model output to grade.
- `mode` — optional bucket (e.g. `"edge"`, `"happy"`) → per-mode rates + regression alerts, AND the
  judge receives it as the harness-supplied BUCKET, so a stratified rubric ("the bucket is given to
  you") is decidable. Bucket **consistently** turn to turn so the loop's sub-objectives track.
- `input` — the probe that produced it (context only — NOT graded).
- `record` — optional harness-supplied evidence of what actually ran (ledger/tool record). The judge
  receives it as authoritative ground truth, so a rubric that compares the output's account against
  the record is falsifiable instead of graded against the output's own self-report.
- `capture` — optional replicate-capture label. Rows captured in the same run of ONE configuration
  share a label; with ≥2 labels the verdict reports `capture_variance` and the improvement claim must
  clear `significance_floor = max(noise_floor, band)`; label every row or none — a partially labelled corpus is refused before grading. The judge noise floor measures judge
  disagreement only — it cannot see capture-to-capture variance (field-measured at ~3× the floor), so
  single captures per candidate are single-draw comparisons.
- `id` — traceability.

> **Client timeout note:** grading a normal corpus commonly exceeds a 5-minute client idle timeout.
> In Claude Code, raise it with `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` under `env` in
> `.claude/settings.json` (it binds at session start only). After any timeout on `goal_titrate_step`,
> poll `job_status` and check `turn_count` BEFORE resending — a landed duplicate burns a budgeted turn.

## Sharpening the rubric — ground it in real outputs (do this before you freeze)

The rubric is the ruler: a vague one makes every verdict meaningless. Do NOT freeze the PROVISIONAL
rubric scout handed you — **perfect it against reality first.** Two ways in, and the best is both:

- **The user has a reference / clear idea** — a gold "this is what good looks like" output, or a sharp
  spec. Anchor on it: the rubric's job is to make *that* standard explicit and judge-checkable.
- **They don't** — **sample the baseline**: run the CURRENT prompt on ~3 inputs (cheap — generation
  only, no judge calls) and read the actual outputs. The rubric falls out of the contrast: *why* are
  these bad, and what would make them good?

Then discuss + tighten with the user until the rubric cleanly **separates the failing outputs from the
desired one.** What to actually discuss:

- **Decompose the reference** — *why* is the gold output good? Each reason becomes a pass criterion
  (e.g. "states a falsifiable claim" · "domain-independent" · "not derivable from the repo").
- **Strictness** — does pass need ALL criteria, or is it graded? Where's the line for a near-miss?
- **Modes** — does "good" mean different things for different inputs (happy vs edge)? Those become the
  per-mode buckets the loop tracks.
- **Judge-checkable?** — could two independent judges apply this and agree? If it's pure taste, it is
  not a rubric yet — make it observable.
- **Reproduction sanity** — do the *current* outputs actually FAIL this rubric? If not, there's nothing
  to improve and `establish_baseline` will refuse (`reproduced=false`).
- **Achievable?** — is the target reachable within the declared turn budget, or should the run use a larger budget?

The reference is an **authoring anchor, not a graded input**: the engine grades candidates against the
frozen *rubric*, so bake the reference's qualities INTO the rubric text.

**A good rubric looks like** (concrete · contrastive · judge-applicable):

> **Pass** = the card states ONE specific, reusable principle as a falsifiable claim — usable by another
> team after only swapping the example.
> **Fail** = vague ("be careful with prompts"), duplicative, or derivable just by reading the repo.
> **Near-miss (still fail)** = a real principle, but tied to one pipeline / not abstracted.

## Held-out cases — check the winner on cases the loop never saw

The loop grades every turn on the same cases, so a prompt can learn those cases and still get worse
on new inputs. To catch that, hold some cases back from the loop and grade the winner on them once, at
the end. This uses only the tools below and adds a single grading pass.

- **Split before the baseline.** If the corpus has **40 or more** cases, hold back 20% of them (at
  least 20 — `verify` needs 20 scorable cases on each side, or it returns `inconclusive`). Pick them at
  random within each `mode`, so every mode is on both sides. Write the held-back case ids to
  `.titration/holdout/<system_ref>.json` before any spend. The rest are the **tuned** cases.
- **Under 40 cases, run without a holdout.** Do not invent inputs to reach 40. The final report's
  first line then says there was no holdout, and why (see "Output format" below).
- **Two baselines, one rubric.** Establish a **tuned baseline** on the tuned cases and a **holdout
  baseline** on the held-back cases, with the exact same rubric text, both at step 3. Only the tuned
  baseline goes to `goal_titrate`.
- **Keep the held-back cases out of the loop.** While the loop runs, run the system on the tuned cases
  only, so held-back outputs never appear mid-loop. Run it on the held-back cases once, for the final
  check. Never ship them in a `goal_titrate_step`, and never use their outputs or grades to decide a
  change.
- **If the holdout baseline is refused** (for example `reproduced=false`: the current prompt passes
  those cases too often), carry on without a holdout; the final report's first line says so, with the
  refusal reason. Do not re-split: that is more judge spend on the same corpus.
- **Final check, once.** When the loop converges, run the winning prompt on the held-back cases and
  call `verify { baseline_id: <holdout baseline>, candidate_outputs, player_model }`. Keep each case's
  `id` and `mode` exactly as they were at the split. Only `passed` confirms the win. Anything else
  (`inconclusive` or a regression) means the report leads with "likely overfit, don't ship" (see
  "Output format" below). Do not restart the loop yourself — the user decides what happens next.

## The loop

1. **Sharpen + confirm the goal + rubric — and STOP.** Name the independently improvable capability
   as a concise 1-3 word `system_ref`; the project name and the experiment goal itself are invalid
   `system_ref` values. Before you capture or spend, **ground the rubric in real outputs** (see
   "Sharpening the rubric" above): anchor on the user's reference if they have one, else sample ~3
   baseline outputs; then discuss + tighten until it cleanly separates failing from desired.
   `establish_baseline` (step 3) **FREEZES** the rubric (`rubric_hash`) — immutable for the rest of the
   loop — and is the **first spend**, so the user **approves the sharpened rubric first**; wait for an
   explicit "go." A "go" approves the rubric only — it does **not** skip picking judges (step 3).
2. **Capture the baseline.** Run the CURRENT (pre-change) prompt/system over your corpus; collect the
   outputs as `OUTPUT_ROW`s. They must actually **reproduce the failure** — a baseline that can't
   exhibit the bug measures nothing. Then split off the held-out cases (see "Held-out cases" above).
3. **Get a judge panel, then `establish_baseline`.** A baseline needs at least 2 distinct-vendor judges,
   and never one that shares the Player's family. Two ways to get there — pick one:

   - **The local picker (default).** Call `referee_panel_mint` with `player_model` (your own model id;
     add `player_family` if the id is not recognisable), `sut_model` (the model the system under test
     calls, read from its code or config; add `sut_family` if the id is not recognisable; omit it only
     when you genuinely cannot tell) and optional `project`, so the ticket is claimed there →
     `{ ticket_id, picker_url, expires_at }`. Passing `sut_model` greys out that vendor too, because
     a judge may favour its own vendor's outputs. The server opens the page in the user's
     default browser itself. Also show the human `picker_url` **ALONE on its own line**, never inside a
     sentence, in case the browser did not open: terminals wrap long lines, and a click on a wrapped
     link opens a truncated URL. The
     page lists every judge door available on this machine — installed subscription CLIs, plus
     OpenRouter models if a key is set — with its cost class, disables whatever isn't available with
     the reason, and greys out the Player's own vendor family so it can't be picked. The user selects
     **3 judges from 3 distinct vendor families** and confirms. Do not spend while waiting.
     - Poll `referee_panel_status` `{ ticket_id, wait_seconds: 50 }` — the call holds open until the
       ticket leaves `pending`, so the answer lands the moment the human confirms; repeat until
       `confirmed` or `expired`. Start polling the moment the link is shown; never ask the human to
       report back ("say done").
     - On `expired` or a timeout: **HALT**. Do not call `establish_baseline`. A pending ticket is not
       revived — mint a fresh one only if the user retries.
     - On `confirmed`: call `establish_baseline` with `panel_receipt_id` set to that `ticket_id`.
     - **With a holdout**, each baseline needs its own ticket, because a ticket is used up by one
       `establish_baseline`. Mint both tickets up front, show both links together, and ask the user to
       pick the same three judges on each. Poll both tickets, then establish each baseline with its
       own `ticket_id`.
   - **`TITRATION_JUDGES` (unattended / CI).** If the user's `.env` sets `TITRATION_JUDGES` to a
     comma-separated list of roster ids, or to `auto`, the picker is skipped entirely and
     `establish_baseline` resolves the panel from that setting instead — do not mint a ticket, and do
     not send `panel_receipt_id`. `auto` prefers installed subscription CLIs first, adds OpenRouter
     judges only if `OPENROUTER_API_KEY` is set, always excludes the Player's own family, and needs 3
     distinct families or it refuses outright rather than seat a same-family judge.

   Either way, omitting **both** `panel_receipt_id` and a `TITRATION_JUDGES` setting is refused — there
   is no silent default panel. The picker (or the `TITRATION_JUDGES` resolution) runs **once per new
   baseline**: later `verify` / `goal_titrate` / `goal_titrate_step` calls reuse the panel locked onto
   that baseline — do not mint again — but every one of those calls still re-checks the *current*
   `player_model` against the locked panel's families, so a different Player picking up the same
   baseline is refused if it shares a locked judge's family.

   `establish_baseline { goal_brief: { failure, desired_behavior, scope? }, rubric, baseline_outputs,
   system_ref, player_model, panel_receipt_id | (rely on TITRATION_JUDGES), corpus_ref? }` grades the
   baseline via the resolved judges, **confirms it reproduces the failure** (else REFUSES with
   `reproduced=false`), **freezes the rubric** (`rubric_hash`), and returns a **`baseline_id`**.
   With a holdout, call it twice with the same rubric: once with the tuned cases and once with the
   held-back cases. Record both `baseline_id`s in the holdout file.
4. **Start the loop — `goal_titrate`** `{ baseline_id (the tuned one, with a holdout), candidate: { name, version?, summary?,
   deferred_scope? }, player_model, budget?, target_rate?, ledger: true, capture: true }` →
   `{ job_id }`. Sub-objectives = the baseline's modes, locked at turn 1. `target_rate` default `0`
   (bug eliminated); omitted `budget` defaults to `20` turns. `capture` is locked here and promotes a
   terminal finding or regression to durable project memory; omit it only when the user explicitly
   opts out.
5. **Each turn — `goal_titrate_step`.** YOU make the change, run it, capture this
   turn's outputs (bucketed by `mode`), and ship them with a required evolution
   declaration in the same call:

   ```json
   {
     "job_id": "<job_id>",
     "player_model": "<your model id>",
     "candidate_outputs": [
       { "id": "<case-id>", "mode": "<measured-mode>", "input": "<probe that produced it>", "output": "<captured output to grade>" }
     ],
     "evolution": {
       "artifact_kind": "prompt",
       "note": "<what changed, including commit or working-tree lineage; max 500 characters>"
     }
   }
   ```

   `evolution.prompt_file` is accepted for compatibility but this build never opens or reads it —
   **only the declared `note` is recorded**, in the user's own local database, the moment the turn
   grades. Exact prompt/system text is never stored anywhere, by design — the note is a display-
   provenance line, not a changelog, so summarise rather than paste one.

   - **Leak guard:** prompt/system text is separate evolution evidence. Never copy it into
     `candidate_outputs` (`output`/`input`), because that contaminates grading.
   - **Prior-turn gate:** the next step refuses if the preceding graded turn has no recorded note —
     fix the missing note first; do not continue with a hidden history gap.
   - **Recovery:** a note-save failure never changes the verdict — if grading succeeds but the note
     fails to save, the turn's verdict still stands. But there is no repair tool in this build:
     `goal_titrate_step` refuses to grade another turn on this job until that note is recorded. The
     tool's own error message on that failure names exactly which job and turn need a note; the only
     way to supply one after the fact is to fix the underlying local-database problem and record it
     directly, then retry `goal_titrate_step`.
   - **Evidence, not marketing:** ground every result in the returned verdict; never put an unreturned
     result in the note. Repeat while `continue`.
6. **Terminal.** Converged (a real, non-inconclusive improvement with every sub-objective ≤ target)
   OR stopped with a `failure_origin` (`goal-complete` / `turn-budget-reached` / `progress-stalled`) + a
   per-turn audit trail. On convergence with a holdout, run the one final `verify` against the holdout
   baseline (see "Held-out cases" above) before you report a win. The final report's first line
   follows "Output format" below, whatever the loop concluded.
7. **Optional — extract reusable learnings.** `capture: true` at step 4 already handled the terminal
   verdict (a FINDING on convergence, a REGRESSION on a stalled-or-exhausted run) automatically — no
   further action needed for that. For anything else worth keeping — a METHOD, a MODEL_PROFILE, a
   PROMPT_BEHAVIOR, a DATASET_NOTE — call `propose_cards { run_summary, project? }`: a single advisory
   model call **drafts** candidate cards + suggested edges for you to review; it creates nothing. Pass
   `project` to dedup against that project's existing cards (a near-duplicate comes back as
   `duplicate_of` so you update instead of creating anew). A METHOD draft or a `contradicts` /
   `supersedes` edge is flagged `requires_confirmation` / `high_stakes` — never create those without
   confirming with the user. Zero proposals is a valid outcome.

> **The DEFAULT is the LOOP (steps 4–7).** `verify` is a SEPARATE, narrow tool: ONE pass that grades a
> single candidate set and stops — it does NOT iterate toward the goal, and it persists no run (so
> nothing to look back on later — the loop does). Use `verify` ONLY for a genuine one-off "did this
> one change help?" — NEVER as a substitute for titrating to a goal. If the user said "improve / titrate
> to a goal," it is `goal_titrate`, not `verify`. `verify { baseline_id, candidate_outputs, player_model
> }` reuses the baseline's locked panel exactly like `goal_titrate` does.

## What the verdict protects you from

- A `metric_delta` inside the effective-N + inter-judge **noise floor** → `inconclusive`, never a
  false `passed`.
- An aggregate gain that hides a **per-mode regression** → does not ship.
- Grading requires **≥2 distinct-vendor judges**; if fewer respond the turn **fails loudly**
  (never a silent single-judge downgrade), and a judge sharing the Player's family is refused before
  any call is made.
- Large corpora run as a background job inside the same server process (see `async` on `verify` /
  `establish_baseline`, and the automatic threshold) — poll `job_status { project, job_id }` until
  `succeeded` or `failed`.

## Output format — render the gate and verdicts EXACTLY like this

Recommendation-first, confirm-or-edit — ONE
compact plain-text block; the user's job is a single decision. Same shape for the step-1 gate and every
later verdict. Keep the sample + rubric visible TOGETHER (the derivation is what deserves scrutiny).
MECHANICAL friction on the freeze (not just framing — "visual availability ≠ scrutiny"): NO silent
default; the user must actively type `go` to freeze. To change the rubric the user just **says what is
wrong in plain words** — the agent maps it to the right line, rewrites it, re-shows the rubric, and
re-asks (no `edit <n>` syntax to learn; natural language is the edit path).

Step-1 gate — emit ONLY this:

```
RUBRIC TO FREEZE — review before you approve (it drives every later grade)

Current behavior (v1 sample):
- <2-4 line real sample output>

Proposed rubric:
1. pass: <criterion>
2. pass: <criterion>
3. fail: <criterion>

Plan: baseline = <corpus> ; candidate = <v2 change>

No default. Reply: go  (freeze + run)  |  just say what you'd change (plain words)  |  explain (plain-English walkthrough)
```

When the user replies `explain`: in plain words, walk through THE DESIGNED RUBRIC ON THE TABLE — each
criterion and WHY it is there, grounded in what the sampled behavior showed — then THE PLAN and why
THIS plan (why this baseline, why this candidate change). Do NOT give a generic tutorial on what a
rubric is, the goal of rubrics, or why freezing matters — explain the SPECIFIC rubric + plan in front
of the user, then re-show the reply line.

Per-iteration verdict (step 5 / one-shot verify) — same shape:

```
VERDICT: <passed | inconclusive | regressed>   (frozen rubric)

Candidate sample:
- <2-4 line real sample>

Rubric check:
1. <criterion>: pass
2. <criterion>: fail — <one-line why>

Next: <one concrete action>
```

Final report (after the terminal turn): your final message to the user starts with exactly one of these
lines, word for word, before any summary or table:

```
Held-out check: passed on <n> cases the loop never saw.
Improved on tuned cases, not confirmed on held-out cases: likely overfit, don't ship.
No holdout: <reason — corpus under 40 cases, or the holdout baseline was refused: <refusal>>, so this result is measured only on the cases the loop tuned against.
```

A run that did not converge leads with its `failure_origin` instead; there is no final check to run.

## Boundaries

- The engine **never runs your code** — you ship outputs, it grades. Source / prompts stay local.
- The verdict is **advisory** — you own the GO. Nothing auto-applies.
- Evolution is captured **locally, on every interactive step**: the declared note only. A capture
  failure is explicit and blocks the next turn until the underlying problem is fixed and the note is
  recorded — there is no repair tool in this build. Captured prompt content never enters a grade, and
  is never stored regardless of what is captured on disk elsewhere.
- This skill is the *loop*. It does **not** find what to test (that's `titration-scout`) or design a
  harness (that's `titration-harness`).
