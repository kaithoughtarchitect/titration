// Titration MCP — embedding helper (OpenRouter)
//
// Routes embeddings through OpenRouter, resolving the same request-scoped
// provider credential the judges use — this build resolves it from its own
// explicit process key. Default model: openai/text-embedding-3-small (1536d).
// Override with TITRATION_EMBED_MODEL (must match the cards.embedding vector(<DIM>) in db/001_schema.sql).

import { resolveOpenRouterApiKey } from "./provider-key";
import { ProviderCredentialError } from "./provider-key-core";
import { parseEmbeddingResponse } from "./embed-core";

export const EMBED_MODEL = process.env.TITRATION_EMBED_MODEL || "openai/text-embedding-3-small";
const OPENROUTER_EMBED_TIMEOUT_MS = 60_000;

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const apiKey = await resolveOpenRouterApiKey();
  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
    signal: AbortSignal.timeout(OPENROUTER_EMBED_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) {
    throw new ProviderCredentialError("credential_invalid");
  }
  if (!res.ok) throw new Error(`OpenRouter embeddings request failed (${res.status})`);
  return parseEmbeddingResponse(await res.json(), texts.length);
}

export async function embedOne(text: string): Promise<number[]> {
  return (await embedBatch([text]))[0];
}

// pgvector literal: '[1,2,3]'::vector
export const toVec = (a: number[]) => "[" + a.join(",") + "]";
