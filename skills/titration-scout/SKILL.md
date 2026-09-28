---
name: titration-scout
description: >-
  Find what in a repo is actually worth titrating: scan the LLM call sites + the prompt/system strings
  that drive them, filter to the surfaces that are VERIFY-SHAPED (open-ended output quality · a
  reproducible failure · measurable at small N), rank them, and hand the top pick to titration-improve
  with a goal + rubric already drafted. The on-ramp BEFORE you know what to measure. Phases 1-3 are
  read-only repo analysis; Phase 4 writes one manifest under `.titration/scan/`, then stops — nothing
  leaves this machine, ever. The Titration MCP server need not even be installed yet — Phases 1-3 run
  on any repo. Use when the user has no target yet — "what should I improve?", "where do I start?",
  "what's worth testing/titrating here?", "find something to evaluate". NOT for running the A/B (that's
  titration-improve, which scout hands off to) or designing a harness (titration-harness). Works under
  any MCP coding agent (Claude Code / Codex / Cursor / others).
---

# Titration Scout — find the surface worth titrating

This skill answers the first question a new Titration user hits: **what do I even point this at?**
It reads the repo, enumerates the model-driven surfaces, keeps **only** the ones a cross-vendor
verdict can actually move, and hands the best candidate to the improvement loop with a goal + rubric
already drafted.

> **Prereq: none for Phases 1-3.** Scout's analysis is pure repo read — no MCP call, and Titration
> need not even be installed yet. Phase 4 always writes one manifest file to `.titration/scan/`, no
> matter what, then **stops**: the manifest is a local record for you (and the next scan) to read —
> it is never sent anywhere, there is no server to send it to, and this skill never asks for a
> confirmation to push it. The Titration MCP server itself is only needed for the *next* step
> (`titration-improve` / `titration-harness`), which scout hands off to. This is the one skill that
> works before anything is wired — it is the true on-ramp.

## Phase 1 — Enumerate the surfaces (no judgement yet)

Inspect the repo and list every place a model produces an output. Everything you read stays inside the
repository's **working directory** — never walk outside it — and log files are read only at locations
the user actually names, never wherever you guess they might be. Describe what you find as **sampled**
or **inspected**, never as exhaustively read: a scan cannot know it saw everything.

1. **Detect the stack + providers.** Read the dependency manifest (`package.json`, `pyproject.toml` /
   `requirements.txt`, `go.mod`, …) and scan imports for provider SDKs and frameworks (`openai`,
   `anthropic` / `@anthropic-ai`, `langchain`, `litellm`, `llamaindex`, a bare HTTP call to a model
   endpoint, …).
2. **Find the prompt/system strings that drive each call.** The system prompt, the user-prompt
   builder/template, the instruction block. These — not the SDK call — are the thing you'd A/B.
3. **List each candidate surface** with: what it does · where its output goes (user-facing? feeds
   another step?) · is the output **open-ended prose** or a **closed-set label / structured value**.

## Phase 2 — Filter by verify-fitness (the load-bearing step)

A surface is worth a cross-vendor verdict only if **all four** hold. Drop the rest — and say *why*,
so the user learns the shape. Every skip you record (here, and later in the scan manifest's `skipped[]`,
Phase 4) carries the failing test's **closed id** — exactly one of the four below, never an invented one.

| id | Test | Worth titrating | Skip / route elsewhere |
| --- | ---- | --------------- | ---------------------- |
| `quality_varies` | **Output varies in quality** | Two prompt versions produce meaningfully different *happy-path* output — ideally open-ended prose, where the judge panel earns its keep | Output is deterministic/structural (JSON shape, regex, parse) → a **unit test**, not a verdict |
| `failure_reproducible` | **Failure is reproducible** | The bad behavior shows up on inputs you can actually collect | No reachable corpus that exhibits it → a baseline never freezes on it: `establish_baseline` **refuses** (`reproduced=false`) unless at least 3 of the collected cases fail at a rate of 10% or more |
| `measurable_at_small_n` | **Measurable at small N** | The change moves the **common** path | A rare-path **reliability/robustness fix** (a retry on a <1% failure) → v1 and v2 produce *identical* happy-path output at small N → the verdict is a tautology, not a finding |
| `rubric_statable` | **Rubric is statable** | You can write a fixed pass/fail criterion for "good" | "Good" is purely taste with no criterion → nothing to freeze |

Two traps worth calling out by name, because they look titratable and aren't:

- **The rare-path fix.** A robustness change that only fires on a fraction of a percent of inputs is
  *invisible* to an A/B at small N — both arms emit the same output on every input you'd realistically
  test. Real change, wrong instrument. (Route it to a unit test / fault-injection, not a verdict.)
- **The closed-set classifier.** A label from a fixed set with a known answer key is cheaper to check
  with an **accuracy eval / unit test** than a judge panel — `verify` still works, but it's not where
  the cross-vendor moat shines. Prefer it as a candidate only when the others are weaker.

## Phase 3 — Rank, draft the baton, hand off

1. **Rank the survivors** by: how *subjective* the output (more subjective → more panel value) × how
   *easy* the reproducing corpus is to gather × how *live / costly* the open question is.
2. **Draft the baton for the #1 surface** — the package `titration-improve` consumes. Everything here
   is a **DRAFT**, nothing is frozen or spent: improve will *confirm the rubric with the user, then*
   freeze it at `establish_baseline`. **Scout never freezes and never spends.**
   - **goal** — the behavior you want;
   - **rubric** — a **PROVISIONAL** pass/fail criterion (fail = the output exhibits the failure),
     drafted from *static code* to clear the "rubric is statable" fitness test in Phase 2. It is NOT
     final: `titration-improve` sharpens it against real baseline outputs (and any reference the user
     brings) before freezing. Flag it provisional so the user knows it's a starting point, not the law.
   - **corpus** — where the inputs come from (be specific: which dir / log / dataset). A baseline only
     *freezes* once the failure actually reproduces there — needing at least 3 failing cases at a rate
     of 10% or more; once frozen, a verdict against it stays **inconclusive below 20** scorable rows, so
     more is better than either floor.
   - **no prompt text.** The baton carries `goal`, `rubric`, and `corpus` — never the current prompt or
     the proposed change. The surface named in the recommendation (its file + symbol) is where
     `titration-improve` finds both versions itself.
3. **STOP and present**, in the one output block (below): the ranked shortlist, the drafted baton for
   the top pick, and the scan disclosure from Phase 4 — always rendered together on this same turn. Let
   the user choose before any capture or grading. Then hand off, **passing the baton**:
   - → **`titration-improve`** to run it — it will **sharpen + confirm the rubric against real outputs
     with the user, then** `establish_baseline` → the **`goal_titrate` loop** (iterate to the goal — the
     default). (`verify` is only for a one-off "did this single change help?", never the loop.)
   - → **`titration-harness`** *first* if the corpus needs a designed capture / a spend-gate before
     you commit to it.
   - **Say plainly when the harness step can be skipped.** If real captured outputs already exist
     (about 20+ rows that include the failure, like a recorded run over a sample file), they ARE the
     corpus: go straight to `titration-improve`. The harness track designs and validates a multi-file
     capture harness, which is worth it for a large or costly capture, and heavy for a small one.

## Phase 4 — Write the manifest, then stop

This is the artifact scout leaves on disk for you: plain JSON, yours to keep, edit, delete, or diff
against the next scan. It runs every time this skill runs, on **every** surface Phase 2 kept — not
just the #1 pick — plus every surface it skipped, all in one manifest, written once per run. There is
no server-side counterpart, no confirmation to give, and nothing this skill sends anywhere.

1. **Turn the survivors into findings.** Every finding needs exactly these fields, spelled exactly as
   listed — nothing more, nothing less: `source_path`, `symbol`, `state`, `revision_ref`,
   `content_digest`, `goal`, `rubric_pass`, `rubric_fail`, `evidence_summary`, `occurrence_count`,
   `occurrence_window_days`.
   - `source_path` — the file's path **relative to the repository root**, forward slashes, no leading
     `./` or `/`, and never starting with `..`.
   - `symbol` — the function / handler / method name at that path, **without** a trailing `()`.
   - For each surface that cleared all four Phase 2 tests, draft a `goal` and a provisional
     `rubric_pass` / `rubric_fail` the same way step 2 above drafts the baton — from static code. Tag
     `state: "incident"` when you found concrete evidence the failure already happened (a log line, a
     bug report, a commit message) and can describe it — never quote it — in `evidence_summary`, with
     an `occurrence_count` / `occurrence_window_days`; tag `state: "opportunity"` otherwise — worth
     testing, not yet known to be broken (leave `evidence_summary`, `occurrence_count`,
     `occurrence_window_days` `null`). Set `revision_ref` to the current commit hash touching that file
     (short or full, lowercase hex) and `content_digest` to `sha256:` plus the 64-character lowercase
     hex sha256 digest of the call site's current content — both describe *which version* you looked
     at, never the content itself.
   - Every surface Phase 2 skipped becomes a `skipped[]` entry with exactly these fields: `name` (the
     surface), `test` (the closed id from Phase 2's table), `reason`, and `path_to_eligibility` (or
     `null` when there isn't one).
2. **Write the manifest** — `manifest_schema: "titration-scan/v1"`, a `scan` block (`started_at` /
   `finished_at` in ISO 8601 UTC, `outcome`: `"complete"` normally, `"partial"` if you stopped early —
   then set `stopped_after` to what completed, e.g. `"18 of 47 call sites"` — or `"failed"` on an
   unrecoverable error, plus `call_sites_sampled`, `log_days_read`, `commits_read`), the `findings[]`
   and `skipped[]` from step 1. `findings` may be empty — write the manifest regardless; it still
   records what was sampled. Write it to `.titration/scan/<started_at>.json` (colons become hyphens and
   the sub-second fraction is dropped, e.g. `2026-09-03T14:02:11.000Z` →
   `.titration/scan/2026-09-03T14-02-11Z.json`). Keep it: it is worth diffing against the next scan's
   manifest to see exactly what changed.
3. **Emit the full output block now.** The manifest was already written to `.titration/scan/` (step 2)
   and stays there. Emit the block below (Output format) in full: the ranked shortlist, the drafted
   baton, and the `SCAN` section naming this run's manifest path and counts. The recommendation,
   shortlist, and baton are the skill's product — they are what the user reads.
4. **Respect the bounds that keep the manifest readable.** `source_path` ≤ 400 characters, `symbol`
   ≤ 200, `goal` / `rubric_pass` / `rubric_fail` ≤ 400 each, `evidence_summary` ≤ 600 — each non-empty
   when present (write `null`, never an empty string, for anything you don't have). `occurrence_count`
   and `occurrence_window_days`, when set, are non-negative integers (up to 1,000,000 and 3650
   respectively) — leave both `null` when you don't have real counts. In `skipped[]`: `name` ≤ 200,
   `reason` ≤ 400, `path_to_eligibility` ≤ 400 (or `null`), and the whole `skipped[]` array is capped at
   50 items and, serialised as JSON, stays under 16 KiB. Cut the list (and say so) rather than write an
   unreadable manifest. None of `source_path`, `symbol`, `name`, `reason`, `path_to_eligibility`, or
   `stopped_after` may contain a newline. If there are more skipped surfaces than the cap, keep as many
   as fit and record in `scan.stopped_after` that the skipped list was cut (e.g. `"skipped list cut at
   50 of 63 surfaces"`); also state the cut on the output block's `manifest:` line (e.g. `manifest:
   <path> (<n> findings, 50 of 63 skipped — list cut)`).

## Output format — render the result EXACTLY like this

Plain text — NO tables, NO emoji (decorative OR functional). Tables wrap/break in narrow terminals and
emoji mojibake in logs/SSH/pipes, and this output is ALSO re-read by downstream agents — so
portability + deterministic shape beat polish. Scannability comes from STRUCTURE, not decoration: a
recommendation-first line, fixed UPPERCASE status labels (TAKE / ALT / WEAK / SKIP), and the baton as a
fenced `yaml` block with a fixed schema (so a downstream agent extracts it cleanly). Emit ONLY the
block below, and nothing after it:

````
titration-scout — <repo>

RECOMMENDATION
Top pick: <surface>
Why: <one line, plain words>

SHORTLIST
1. TAKE  <surface>  — <short why>
2. ALT   <surface>  — <short why>
3. WEAK  <surface>  — <short why>
-  SKIP  <surface>  — <reason + where it should go instead>

BATON (provisional)
```yaml
goal: <the behavior you want>
rubric:
  pass: <criterion>
  fail: <criterion>
corpus: <where the inputs come from>   # freeze needs >=3 failing at >=10%; inconclusive below 20
```

SCAN
manifest: <path written> (<n> findings, <n> skipped | <kept> of <total> skipped — list cut)

NEXT: <top pick> -> titration-improve (it sharpens the rubric, then freezes)
HARNESS: <skip: the corpus is ready (<n> captured rows) | first: <why a designed capture is needed>>
````

## Boundaries

- Scout **only finds and frames** a target — it never grades, captures, or changes code. It produces a
  ranked shortlist + a drafted loop setup, nothing else.
- Phase 4's scan manifest is a **local artifact only** — there is no dashboard, no receipt, and no
  server that receives it. The scan runs every time this skill runs, independent of which surface (if
  any) the user later hands to `titration-improve`.
- It is the step *before* the others: it does **not** run the improvement loop (`titration-improve`)
  or design a wind tunnel (`titration-harness`).
- The shortlist is **advisory** — the user owns which surface to titrate, or whether to at all.
- Note for users hardening their *own* Titration-style tooling: a model surface whose prompt is frozen
  inside an engine/tool can't be A/B'd *through* that tool — you run the two prompt variants
  client-side and ship both output sets to `verify` (client-ships-outputs). Scout flags this when the
  top pick's prompt isn't swappable at the call site.
