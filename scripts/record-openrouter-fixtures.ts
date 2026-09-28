// Records the five real-transport fixtures an OpenRouter judge needs before it may
// be added to judges-roster.json (see lib/__tests__/fixtures/openrouter/README.md):
// one tiny chat completion per reasoning effort (low / medium / high), the model's
// row from GET /api/v1/models, and GET /api/v1/models/{id}/endpoints.
//
// Usage: npx tsx scripts/record-openrouter-fixtures.ts <openrouter-slug> [more slugs...]
// Needs OPENROUTER_API_KEY (read from .env); it is sent to OpenRouter and never printed.
// Cost: three one-word completions per slug — a fraction of a cent. Never run from npm test.

import "../server/bootstrap-env";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://openrouter.ai/api/v1";
const here = dirname(fileURLToPath(import.meta.url));
const recordedRoot = join(here, "..", "lib", "__tests__", "fixtures", "openrouter", "recorded");
const EFFORTS = ["low", "medium", "high"] as const;

function dirFor(slug: string): string {
  return join(recordedRoot, slug.replaceAll("/", "__").replaceAll(":", "--"));
}

async function getJson(url: string, key: string): Promise<unknown> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`GET ${url.replace(API, "")} → ${res.status}`);
  return res.json();
}

async function record(slug: string, key: string): Promise<void> {
  const out = dirFor(slug);
  mkdirSync(out, { recursive: true });

  const list = (await getJson(`${API}/models`, key)) as { data: { id: string }[] };
  const row = list.data.find((m) => m.id === slug);
  if (!row) throw new Error(`${slug} is not in OpenRouter's model list`);
  writeFileSync(join(out, "model.json"), JSON.stringify(row, null, 2) + "\n");

  const endpoints = await getJson(`${API}/models/${slug}/endpoints`, key);
  writeFileSync(join(out, "endpoints.json"), JSON.stringify(endpoints, null, 2) + "\n");

  for (const effort of EFFORTS) {
    const res = await fetch(`${API}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: slug,
        reasoning: { effort },
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`${slug} effort ${effort} → ${res.status}`);
    writeFileSync(join(out, `effort-${effort}.json`), JSON.stringify(body, null, 2) + "\n");
    const usage = (body as { usage?: { reasoning_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number }; cost?: number } }).usage;
    const reasoning = usage?.completion_tokens_details?.reasoning_tokens ?? usage?.reasoning_tokens ?? "n/a";
    console.log(`${slug}  effort=${effort}  ok  reasoning_tokens=${reasoning}  cost=$${usage?.cost ?? "?"}`);
  }
  console.log(`${slug}  wrote 5 files → ${out}`);
}

const slugs = process.argv.slice(2);
if (slugs.length === 0) {
  console.error("usage: npx tsx scripts/record-openrouter-fixtures.ts <openrouter-slug> [...]");
  process.exit(2);
}
const key = process.env.OPENROUTER_API_KEY;
if (!key) {
  console.error("OPENROUTER_API_KEY is not set (add it to .env)");
  process.exit(2);
}
for (const slug of slugs) {
  try {
    await record(slug, key);
  } catch (e) {
    console.error(`${slug}  FAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}
