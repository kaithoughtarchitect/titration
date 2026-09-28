# Titration agent skills

Three agent skills that drive the local Titration MCP server end to end: find something worth
measuring, measure it safely, then measure whether a change actually helped. Nothing here needs a
web server, an account, or a browser — except the one-shot local judge picker inside
`titration-improve`, which opens a page on `127.0.0.1` on your own machine and nowhere else.

| Skill | What it does | Use it when |
|---|---|---|
| [`titration-scout`](titration-scout/SKILL.md) | Reads your repo, finds the model-driven surfaces worth a cross-vendor verdict, ranks them, and drafts a goal + rubric for the top pick. Read-only; writes one JSON manifest to `.titration/scan/` and stops. | "What should I improve?" / "Where do I start?" |
| [`titration-harness`](titration-harness/SKILL.md) | Designs and validates a paired-corpus test harness *before* you spend on capture — a 9-check report with a Proceed / Revise / Reject recommendation. | "Is my eval set sound before I spend money on it?" |
| [`titration-improve`](titration-improve/SKILL.md) | Freezes a rubric + baseline, then runs the `goal_titrate` loop: you make each change and ship its outputs, Titration grades them via a cross-vendor judge panel and tells you whether it actually helped. | "Is v2 better than v1?" / "Did this prompt change help?" |

Typical order: `titration-scout` → (optionally `titration-harness`, if the corpus needs a designed
capture first) → `titration-improve`.

## What these skills need

- The Titration MCP server registered in your agent and pointed at your own `TITRATION_DATABASE_URL`
  (see the repo root README / `.env.example`). `titration-scout`'s read-only phases (1-3) don't even
  need this — they work on any repo before Titration is set up at all.
- Judges from three vendor families other than your agent's own, for grading (`titration-improve`,
  and the grading step of `titration-harness`'s follow-through). An `OPENROUTER_API_KEY` in `.env`
  covers this on its own. The subscription CLIs (`claude`, `codex`, `grok` on your `PATH`) add
  seats with no per-call cost, but no CLI covers a panel alone, since each is one vendor. `TITRATION_JUDGES` in `.env` (a comma-separated list of
  roster ids, or `auto`) skips the interactive picker for unattended or CI runs.

## Install

Each skill is one self-contained folder (`SKILL.md` plus whatever it needs) directly under this
repo's `skills/`. There is no installer script — copy or symlink the three folders into wherever your
agent reads skills from. Symlinking means a `git pull` in this repo updates the installed skill
immediately; copying is a one-time snapshot you re-copy after an update.

### Claude Code — `.claude/skills/`

**macOS / Linux:**

```bash
mkdir -p .claude/skills
# copy:
cp -r skills/titration-scout skills/titration-harness skills/titration-improve .claude/skills/
# — or symlink instead of copy:
for d in titration-scout titration-harness titration-improve; do
  ln -s "$(pwd)/skills/$d" ".claude/skills/$d"
done
```

**Windows (PowerShell):**

```powershell
New-Item -ItemType Directory -Force -Path .claude\skills | Out-Null
# copy:
Copy-Item -Recurse -Force skills\titration-scout,skills\titration-harness,skills\titration-improve .claude\skills\
# — or symlink instead of copy (Developer Mode or an elevated shell is required to create symlinks on Windows):
foreach ($d in "titration-scout","titration-harness","titration-improve") {
  New-Item -ItemType SymbolicLink -Path ".claude\skills\$d" -Target (Resolve-Path "skills\$d") -Force
}
```

Restart Claude Code (or reload the window) after installing so it picks up the new skills.

### Codex and other agents — `.agents/skills/`

`.agents/skills/` is the portable convention several coding agents (including Codex) read skills
from. The commands are identical to the Claude Code ones above with the target directory changed:

**macOS / Linux:**

```bash
mkdir -p .agents/skills
cp -r skills/titration-scout skills/titration-harness skills/titration-improve .agents/skills/
# — or symlink:
for d in titration-scout titration-harness titration-improve; do
  ln -s "$(pwd)/skills/$d" ".agents/skills/$d"
done
```

**Windows (PowerShell):**

```powershell
New-Item -ItemType Directory -Force -Path .agents\skills | Out-Null
Copy-Item -Recurse -Force skills\titration-scout,skills\titration-harness,skills\titration-improve .agents\skills\
# — or symlink (Developer Mode / elevated shell required):
foreach ($d in "titration-scout","titration-harness","titration-improve") {
  New-Item -ItemType SymbolicLink -Path ".agents\skills\$d" -Target (Resolve-Path "skills\$d") -Force
}
```

If your agent isn't Claude Code or Codex and reads skills from a different path, check that agent's
own documentation for the expected location — the three `skills/titration-*` folders here are
plain, framework-free Markdown (`SKILL.md` with a YAML frontmatter `name` + `description`) and don't
need any Titration-specific tooling to install; only the destination path differs by agent.

## Checking the skills are still clean

`skills/check-skills.mjs` greps this directory for mechanics that don't exist in this
self-hosted build (a web dashboard, a sync/push step, cloud accounts, multi-user setups, a
stored client config, tools this build never shipped, etc.) and checks that every tool name mentioned actually
exists in the local server's 18-tool
surface. Run it after editing any `SKILL.md`:

```bash
node skills/check-skills.mjs
```

It exits non-zero (with the offending line) on the first problem it finds, and prints nothing on
success beyond a confirmation line.
