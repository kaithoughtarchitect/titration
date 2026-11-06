---
name: titration-diagnose
description: >-
  Work out which part of an agent to change when you already have a real failure and several possible
  causes. Rerun the agent from saved points just before the bad decision, changing one thing per fork,
  and compare against a control. The result is a clue, never a verdict: it hands one change to
  titration-improve to prove. Use when the user asks "which part should I change?", "is it the prompt, the
  skill or the tool?", "why does it keep doing this?", or wants to fork or replay a failing run. NOT for
  finding what to test (titration-scout), designing a harness (titration-harness), or deciding whether a
  change helped (titration-improve). Skip it for a system with one prompt and no tools: there is only one
  thing to change. Needs a harness that can rerun the agent. Works under any coding agent.
---

# Titration Diagnose — find which part to change

Before you spend on a full corpus run, find out which change is worth testing. You rerun the agent from
just before the bad decision, one change per fork, and see which change alters what it does.

> **The contract:** your harness does the forking, on your machine. Titration never runs your code. The
> forks spend agent calls only, no judges, and they produce a clue. Only `titration-improve` can say a
> change helped.

## When it fits

- The failure is real and repeats. If you are unsure, call `classify_failure` first. A `corpus-gap`,
  `rubric-ambiguity`, `formatter` or `instrument-failure` origin means leave the agent alone and fix that.
- More than one part could be the cause: prompt, skill, tool description, tool behaviour.

If the user already has one specific change in mind, skip this and use `titration-improve`.

## The procedure

1. **Write the check first.** Before any fork runs, write a fixed check on the tool log that says whether
   a run did the right thing, such as "it flagged the difference and posted no entry without an opened
   source". It must be code or a rule anyone could apply, written before you see a result. If you judge
   the forks by reading them yourself, you are marking your own work. It only has to fit the kind of case
   you will fork, so say which kind. Show the check to the user.
2. **Find the decision point.** Read failing logs for the step where the run went wrong, then pick the
   moment just before it. Use the same kind of moment each time.
3. **Save at least 3 points, from different cases.** One saved point can mislead. Save the conversation so
   far and all tool state, taken under the current setup, after a whole round of tool calls.
4. **Pick 2 to 4 changes, and write them down now.** The control is extra and does not count. Each fork
   changes exactly one thing: the skill text, the prompt, a tool description, or a tool's behaviour. To
   compare where an instruction belongs, use the same wording in each place, and say if the agent sees
   those places as one message. Trying many and keeping the best is picking the luckiest draw, so do not
   add changes after you see results.
5. **Run a control and every change, at least 5 runs from each point.** The control changes nothing. All
   forks from one point start from the same saved state, with the same turns left.
6. **Score with the check and tabulate,** per point and pooled.

   ```
   point     control  skill  prompt  tool
   case-1    0/5      3/5    2/5     2/5
   case-2    3/5      1/5    2/5     1/5
   pooled    3/30     18/30  9/30    8/30
   ```

7. **Decide, using big gaps only.** Pick a change only if it beats the control by at least 30 percentage
   points pooled, beats every other change pooled, and is the best change at most points (a tie at a point
   counts as best). If another change also clears the control and is within about 15 percentage points of
   your pick, name it as a close second: forks cannot separate them. If nothing qualifies, report "no clear
   winner". That is a real result: forks may not show a small effect, so it does not mean no change would
   help. Let the user decide what to do next.
8. **Hand off one change to `titration-improve`.** Name the change and pass on the check as a starting
   point for the rubric. The improve skill captures from the start of each run, over the whole corpus, and
   gives the verdict. Read its "Starting from a behaviour spec" section if the repo has a spec.

## If the harness cannot save and restore

Rerun the failing cases from the start with each change, with the same check, control and runs per case.
It is the same logic, slower and noisier, because each run may never reach the decision. Say in the report
that you used this fallback.

## What forks cannot tell you

- **The size of the effect.** In one test, forks ranked four options correctly but overrated the two weak
  changes and underrated the strong one. Rankings were useful. The numbers were not.
- **Whether it helps overall.** Forks from failing points never see the cases that were working, so a
  change can look good here and hurt elsewhere. Only a full corpus run shows that.
- **Effects on earlier steps.** The saved history still reflects the old setup, so a change that would have
  altered earlier turns gets less credit than it deserves.
- **Causes in general.** A fix that worked for someone else's agent may not work for yours. Test it.

## Output format

```
titration-diagnose — <agent>

CHECK: <the check, as written before the forks ran>
POINTS: <n saved points, from which cases> (or: fallback, reran from the start)

<the table from step 6>

PICK: <change | no clear winner>   CLOSE SECOND: <change | none>
WHY: <one line, from the table>

This is a clue, not a verdict. Forks do not show the size of the effect or harm to other cases.
NEXT: <titration-improve with this change | what the user needs to decide>
```

## Boundaries

- Fork results never go into a baseline, a rubric, `record` or a judge's prompt.
- This skill does not edit the agent for good. Put each change back after its forks, so the user's
  working copy ends as it began.
- It does not run the improvement loop or freeze anything.
