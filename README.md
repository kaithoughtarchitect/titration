# <img src="docs/images/titration-logo.svg" alt="" width="36" height="36"> Titration

**Let your coding agent fix a prompt until it actually works, and prove it did.**

Point your agent at a prompt that misbehaves. It changes the prompt, reruns it, and Titration
grades every attempt against a baseline that doesn't move, with judges from *other* AI vendors.
The loop keeps going until the problem is gone, or until Titration tells you the prompt was never
the problem.

**Real run:** billing tickets wrongly marked urgent went from **90% → 0%** in one measured change
([worked example](examples/ticket-triage)).

![The nine failure origins: only system-under-test means you should edit the prompt; the other eight are measurement, data, or pipeline problems](docs/images/nine-origins.png)

An open-source **MCP server** with 18 tools. Self-hosted. Setup for Claude Code, Codex and Cursor.
[Five-slide overview (PDF)](docs/deck/titration-deck.pdf)

## Why you can trust the loop

An agent that iterates against a score will happily game the score. Titration is built so it can't:

- **Other vendors grade the work.** Your agent's own vendor is never on the judge panel, and a
  score needs judges from at least two vendor families to answer. Fewer, and the attempt is
  refused with the reason and never scored.
- **The baseline doesn't move.** A baseline freezes its rubric, its outputs and its judges, so
  "better" always means better against the same yardstick.
- **Noise is not a win.** A change inside the judges' disagreement band comes back
  `inconclusive`, never `passed`, and a gain that breaks another group of cases doesn't ship.
- **It tells you when it isn't the prompt.** Every failure is classified into one of nine
  origins. Only one of them means "edit the prompt"; the others point at your test set, your
  rubric, your judges or the code around the model.
- **Memory that compounds.** What each run learns becomes searchable cards your agent can use
  next time, alongside a starter pack of 66 evaluation methods.
- **Yours.** Your Postgres, your keys, your judges. Nothing leaves your machine except the calls
  to the judge and embedding providers you choose.

---

## How it works

> "The first principle is that you must not fool yourself, and you are the easiest person to fool."
> (Richard Feynman)

> "When a measure becomes a target, it ceases to be a good measure."
> (Goodhart's law, as put by Marilyn Strathern)

![How Titration decides: three judges from three vendors classify the failure, a split must be argued rather than averaged, and only system-under-test routes to a prompt edit](docs/images/how-it-decides.png)

![How Titration measures the fix: one change at a time against a frozen baseline, graded by a cross-vendor panel, with findings kept as memory](docs/images/how-it-measures.png)

Titration never pulls or runs your code. Your agent sends the outputs it wants judged; Titration
grades only those declared outputs against the rubric. It runs as a local MCP server over stdio,
calls the judges you pick, and stores everything in your own Postgres.

## Quickstart (about 5 minutes)

You need **Node.js 22.11+**, **Docker**, and access to judges from **three vendor families
other than your agent's own** (a panel is three judges from three families, and your agent's
family never judges its own work).

- An **[OpenRouter](https://openrouter.ai) API key** covers this on its own (12 models across 9
  families) and also turns on memory search. This is the simplest start.
- The subscription CLIs can fill up to two seats at no per-call cost: `claude`
  (`npm i -g @anthropic-ai/claude-code`), `codex` (`npm i -g @openai/codex`), and `grok`.
  With them, a panel is typically two CLIs plus one OpenRouter model.

```bash
git clone https://github.com/kaithoughtarchitect/titration.git
cd titration
docker compose up -d          # Postgres + pgvector on localhost:5432
npm install
cp .env.example .env          # then set OPENROUTER_API_KEY if you have one
npm run setup                 # applies the schema, loads the base starter pack
```

`npm run setup` is safe to re-run. Without an OpenRouter key it still loads the starter pack,
but card search (vector search) stays off until you add a key and run `npm run embed`.

### Connect your agent

The server speaks MCP over stdio. Point your client at `server/server.ts` in your clone
(replace the path):

**Claude Code**

```bash
claude mcp add titration -- npx tsx /absolute/path/to/titration/server/server.ts
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.titration]
command = "npx"
args = ["tsx", "/absolute/path/to/titration/server/server.ts"]
```

**Cursor** (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "titration": { "command": "npx", "args": ["tsx", "/absolute/path/to/titration/server/server.ts"] }
  }
}
```

The server reads `.env` from the clone itself, so no secrets go into client config.
Restart your agent after adding the server or changing its environment, so it starts a fresh MCP
process. Choose a project as described below before making stateful calls.

### Optional: agent skills

`skills/` contains three skills that walk an agent through the whole flow —
**scout** (find what is worth measuring), **harness** (design and validate the measurement),
**improve** (baseline, then improve against it). See [skills/README.md](skills/README.md).

## Choosing judges

The first time your agent establishes a baseline, it calls `referee_panel_mint` and a small
page opens in your browser (served on `127.0.0.1` only). Pick three judges from three
different vendor families; your agent's own family is greyed out, and so is the vendor of the
model your app calls, when the agent passes it as `sut_model` (a judge may favour its own vendor). The panel is locked to that
baseline, so every later comparison uses the same judges. (Diagnosing a failure with
`classify_failure` is not grading, so that panel may include your agent's own vendor.)

| Door | Cost | Notes |
| --- | --- | --- |
| `claude` CLI | your Claude subscription | verified |
| `codex` CLI | your ChatGPT subscription | verified |
| `grok` CLI | your Grok subscription | built; unverified — help wanted |
| OpenRouter | pay per token | 12 curated models across 9 vendor families |

Edit `judges-roster.json` to change the pool. To add an OpenRouter model, first record its proof
calls with `npx tsx scripts/record-openrouter-fixtures.ts <slug>` (a fraction of a cent). For unattended runs or CI, set
`TITRATION_JUDGES` in `.env` to a comma-separated list of roster ids, or to `auto` to let
Titration pick three families you have access to (subscription CLIs first, never the Player's
family).

**What grading costs:** each judged output is one call per judge. A 20-output baseline with a
three-judge panel is 60 judge calls — free on subscription CLIs (within their usage limits),
and billed per token on OpenRouter models.

## Tools

| Area | Tools |
| --- | --- |
| Memory | `card_search`, `card_get`, `card_create`, `card_relate`, `card_distill`, `run_capture`, `propose_cards`, `edge_propose` |
| Measurement design | `harness_design`, `harness_validate` |
| Grading | `referee_panel_mint`, `referee_panel_status`, `establish_baseline`, `verify`, `classify_failure`, `job_status` |
| Improvement loop | `goal_titrate`, `goal_titrate_step` |

### Choose a project deliberately

For the 14 stateful tools above (all except `classify_failure`, `harness_design`,
`propose_cards`, and `harness_validate`), MCP project selection is:

1. A valid nonblank explicit `project` wins, after trimming.
2. Otherwise, omitted/null/blank `project` uses a valid nonblank `TITRATION_PROJECT` from the
   server process environment (or the clone's `.env`). Missing/blank configuration is **unset**.
3. Without either, the call returns `PROJECT_REQUIRED: pass project or configure TITRATION_PROJECT`.
   Pass a deliberate project or configure one, then restart the server.

Names are 1–63 characters: lowercase letters/digits first, then lowercase letters/digits,
underscores or hyphens. Invalid explicit input is refused, never replaced by configuration.
Invalid nonblank configuration (including `__base__`) returns `Invalid TITRATION_PROJECT:` only
when fallback is needed: fix the configuration or pass a valid explicit project, which bypasses it.
These refusals happen before tool work; they do not disable the server's existing startup job sweep.

For multiple repositories on one database, pass distinct names such as `project: "repo-a"` and
`project: "repo-b"` on every stateful call, or give each server process its own intentional
`TITRATION_PROJECT`. A globally configured default **intentionally shares one partition** across
all callers of that process. Opening another folder does not select a project: there is no cwd or
repository inference. Carry the same explicit project through picker mint/status, baseline,
verification, job polling, and every loop call; ticket, baseline and job IDs do not select scope.

To access legacy data, pass `project: "default"` explicitly (or deliberately configure
`TITRATION_PROJECT=default`). Existing data is not moved or redistributed. Explicit `__base__`
reads remain available, and the intentional shared base overlay is unchanged; base writes are
refused, and `__base__` cannot be the configured fallback.

The three advisory exceptions keep optional context: omitting `project` on `classify_failure`
skips ledger reads (`ledger: false` also skips them); on `propose_cards` it skips neighbor reads
while retaining supplied `existing_cards`; on `harness_design` it keeps base-only precedent.
Configured defaults do not activate that omitted context. `harness_validate` is stateless and takes
no project. Pass an explicit project to advisory tools when you want that project's context.

This rule is MCP-only. The standalone `query/card-search.ts` CLI still uses `TITRATION_TENANT`
and its legacy `default` fallback, not `TITRATION_PROJECT`.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). A good first
contribution is a new learning for the base starter pack in `docs/core-learnings/`, or
recording a verified fixture for the `grok` judge door.

## License

[Apache-2.0](LICENSE)
