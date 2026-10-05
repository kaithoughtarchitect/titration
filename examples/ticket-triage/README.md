# Example: ticket-triage

A small support-ticket sorter with two real bugs, and the record of Titration finding and fixing
one of them. Use it to see the whole flow on something small before pointing Titration at your
own code.

For each ticket, a model returns a category and a priority; `formatter.mjs` then turns the reply
into the record a helpdesk imports.

```bash
cp ../../.env .env         # or create .env with OPENROUTER_API_KEY=...
node triage.mjs            # triages tickets.jsonl, writes runs/run-<time>.jsonl
```

The triage model is `deepseek/deepseek-v4-flash-0731` (set `TRIAGE_MODEL` to change it). A run
over the 34 tickets costs well under a cent.

## The two bugs

The support team has two complaints:

- "Half the billing questions show up as urgent. Someone asking which cards we accept is not urgent."
- "Follow-up tickets arrive with no category, so they sit in the unsorted queue."

| Bug | Where | What Titration should say |
| --- | --- | --- |
| The prompt's last line makes anything that mentions money urgent | `prompt.txt` | `system-under-test`: edit the prompt |
| The formatter drops any category with a hyphen (`follow-up`, `feature-request`) | `formatter.mjs` | `formatter`: fix the code, **not** the prompt |

## Try it

With Titration connected to your agent and the skills installed (see the main README), open this
folder in your agent and ask:

> Our support team keeps complaining about ticket triage quality (see the README). Where should I start?

In standard stdio, omit `project` and leave `TITRATION_PROJECT` unset/blank. The client must supply
this folder's local Git repository roots; Git must be available to the server. This example is a
subdirectory of the Titration repository, so it uses that repository's memory, not a separate
`ticket-triage` partition. An independent repository uses its own current Git anchor. Local/global
client configuration both work when correct roots are supplied; opening a folder alone is not proof
that the client sent them. Missing/failed/ambiguous roots refuse, with no server-cwd fallback.

Keep the same repository context through picker mint/status, baseline, verification, job polling,
every loop call and memory writes; IDs do not redirect scope. Arbitrary `project` names and nonblank
`TITRATION_PROJECT` are not overrides: each must match the derived scope or the call refuses.
The example's local `.env` is for `triage.mjs`, not the MCP server.

The advisory tools (`classify_failure`, `propose_cards`, `harness_design`) use the same repository
memory automatically, or run without private context if the roots are unavailable. `ledger: false`
skips the ledger. `harness_validate` is stateless. Base overlays remain read-only.

Old named data stays where it was: legacy factory integrations without a resolver and the standalone
search CLI (`TITRATION_TENANT`, default `default`) retain their separate access paths. Automatic
stdio cannot switch to `default` or `ticket-triage` by argument. No data is moved or redistributed.
See [Automatic repository memory](../../README.md#automatic-repository-memory) for identity,
changed/lost-anchor limits, compatibility evidence and legacy selection details.

Then let it run the three skills in order: **scout** picks the target, `classify_failure` tells the
two bugs apart, and **improve** freezes a baseline and runs the loop.

## What happened when we ran it (2026-09-27)

This historical run used named project memory; automatic binding does not move those records.
A fresh agent session, with nothing but the docs to go on:

1. **scout** picked the prompt's priority rule, and said the missing categories were a code bug that
   doesn't need Titration.
2. **classify_failure**, three judges from three vendors, agreeing 3 of 3 each time:
   - a billing ticket marked urgent → `system-under-test` (a prompt edit is a valid fix)
   - a follow-up with no category → `formatter` (don't touch the prompt)
3. **Baseline**, graded by codex + DeepSeek V4 Pro + GLM 5.3 Flash:

   | Group | Failure rate |
   | --- | --- |
   | billing questions (t01–t10) | 90% (9 of 10) |
   | follow-ups (t11–t18) | 0% |
   | real emergencies (t19, t22, t26) | 0% |
   | everything else | 0% |

   90 of 90 judge votes arrived; the judges agreed 98.9% of the time.
4. **The fix**: the agent replaced the last line of the prompt with
   "Decide priority by whether the customer can still work and whether there is a security problem.
   Mentioning money, a charge, a refund, a price, an invoice or a plan does not make a ticket urgent
   on its own."
5. **goal_titrate converged in one turn**: billing 90% → 0%, overall 30% → 0% (noise floor ±1.1
   points), the three real emergencies still urgent, no group got worse. The lesson was saved as
   cards in the project's memory.

## Over-correction probes (t31–t34)

Added after the run above, when Titration's eval-harness validator pointed out that the first 30
tickets had no case mentioning money **and** a real blocker, so nothing proved the fix would not
over-correct. They are now part of the sample:

| Ticket | What it is | Shipped prompt | Fixed prompt |
| --- | --- | --- | --- |
| t31 | failed payment, whole team locked out | urgent | urgent |
| t32 | checkout crashes for every customer | urgent | urgent |
| t33 | billing details changed without permission | urgent | urgent |
| t34 | overcharged, "no rush" | urgent | normal |

The fix keeps real emergencies urgent even when they mention money. The run above used t01–t30.

The formatter bug is left in on purpose, so you can see Titration refuse to call it a prompt problem.
