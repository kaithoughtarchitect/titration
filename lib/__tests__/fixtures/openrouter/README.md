# OpenRouter U1/U2 admission fixtures

HALT ledger for the referee-panel picker catalog. A commissioned id is
**selectable only after recorded live OpenRouter transport fixtures** prove
both U1 and U2. Docs-only field names are not proof. An empty
`recorded/` directory and a zero-admit catalog are a valid ship.
Live admits (recorded OpenRouter probes, 2026-09-07) fill the picker roster.
Claude Opus 5 stays in membership, halted (no Anthropic on the OpenRouter picker).
Muse Spark 1.3 is admitted with unpublished Agentic Index. Nitro slugs stay in
membership, halted.
`qwen/qwen3.8-max` redirects; `qwen/qwen3.8-max-0902` is admitted.
2026-09-27: GPT-6 Sol/Luna, DeepSeek V4.1 Flash and Grok 4.7 admitted with recorded U1 receipts
(scripts/record-openrouter-fixtures.ts); OpenRouter has not published an Agentic Index for them yet.
The self-hosted picker never displays the index, so it is not an admission gate here. The models
they replace are halted with a "superseded by" reason, never removed (stored panel locks still load).

Offline `npm test` must not call OpenRouter or any real database.
Any future live probe is disposable-only and is recorded here before
an id may flip to `admitted`.

## Commissioned ids

Identity is the OpenRouter slug. Order is the admission ledger order:

1. `anthropic/claude-opus-5`
2. `openai/gpt-5.6-sol`
3. `moonshotai/kimi-k3`
4. `qwen/qwen3.8-max`
5. `meta/muse-spark-1.2`
6. `google/gemini-3.7-flash`
7. `deepseek/deepseek-v4-pro-0813`
8. `z-ai/glm-5.3`
9. `deepseek/deepseek-v4-flash-0731`
10. `x-ai/grok-4.6`
11. `minimax/minimax-m3`
12. `minimax/minimax-m2.7-20260318:nitro`
13. `openai/gpt-oss-120b:nitro`
14. `openai/gpt-5.6-terra`
15. `openai/gpt-5.6-luna`
16. `google/gemini-3.8-flash`
17. `z-ai/glm-5.3-flash`
18. `meta/muse-spark-1.3`
19. `qwen/qwen3.8-max-0902`
20. `openai/gpt-6-sol`
21. `openai/gpt-6-luna`
22. `deepseek/deepseek-v4.1-flash`
23. `x-ai/grok-4.7`

## Files

| Path | What |
| --- | --- |
| `admission.json` | One row per commissioned id. `status` is `admitted` or `halted`. Halted rows carry a `reason`. |
| `recorded/` | Per-id live transport receipts. Empty until a live probe is recorded. |
| `../openrouter-fixture-admission.test.ts` | Offline gate: commissioned rows, admit requires recorded files, zero admits allowed, no invented index/price/P50. |

## Candidate field paths (not proven, not values)

These names come from OpenRouter docs / third-party schema. They are **paths
to look for in a recorded live body**, not invented metrics, and they do not
make an id selectable:

- Agentic Index: `benchmarks.artificial_analysis.agentic_index`
- P50 latency: `latency_last_30m.p50`
- P50 throughput: `throughput_last_30m.p50`

Do not copy numbers into `admission.json`. If a recorded model body has no
published Agentic Index at the proven path, the id stays `halted`.

## U1 — effort honor

Prove the model honors `reasoning.effort` `low`, `medium`, and `high` through
OpenRouter rather than silently ignoring an unsupported parameter. One recorded
live chat-completions (or responses) receipt per effort.

## U2 — snapshot field contract

Prove the live GET bodies actually contain the index and P50 fields the picker
would snapshot. Candidate paths above; the recording pins the contract.

## Recorded layout (when a live fixture exists)

Sanitize the slug: `/` → `__`, `:` → `--`. Example:
`recorded/openai__gpt-5.6-luna/`.

| File | Live request |
| --- | --- |
| `effort-low.json` | chat/completions (or responses) with `reasoning.effort=low` |
| `effort-medium.json` | same, `medium` |
| `effort-high.json` | same, `high` |
| `model.json` | GET `/api/v1/models/{id}` (or the matching row from GET `/api/v1/models`) |
| `endpoints.json` | GET `/api/v1/models/{id}/endpoints` |

Bodies must be real transport receipts. Do not invent OpenRouter JSON.

## How an id becomes admitted

1. Capture the five files above from a disposable database, never a shared or
   production one. Do not run the probe from `npm test`.
2. Confirm U1 (all three efforts honored) and U2 (snapshot paths present,
   Agentic Index published).
3. Set that row in `admission.json` to `"status": "admitted"` and drop `reason`.

Until those files exist, the row stays `halted`. Unproven ids are omitted from
the selectable catalog, not shown disabled.
