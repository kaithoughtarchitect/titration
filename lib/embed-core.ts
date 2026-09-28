export const EMBED_DIMENSION = 1536;

export function parseEmbeddingResponse(
  value: unknown,
  expectedCount: number,
): number[][] {
  if (
    !Number.isSafeInteger(expectedCount)
    || expectedCount < 0
    || !value
    || typeof value !== "object"
    || Array.isArray(value)
  ) {
    throw new Error("OpenRouter embeddings response is invalid");
  }
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length !== expectedCount) {
    throw new Error("OpenRouter embeddings response is invalid");
  }
  const ordered: Array<number[] | undefined> = Array(expectedCount);
  for (const item of data) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("OpenRouter embeddings response is invalid");
    }
    const { index, embedding } = item as {
      index?: unknown;
      embedding?: unknown;
    };
    if (
      typeof index !== "number"
      || !Number.isInteger(index)
      || index < 0
      || index >= expectedCount
      || ordered[index] !== undefined
      || !Array.isArray(embedding)
      || embedding.length !== EMBED_DIMENSION
      || embedding.some(
        (component) => (
          typeof component !== "number" || !Number.isFinite(component)
        ),
      )
    ) {
      throw new Error("OpenRouter embeddings response is invalid");
    }
    ordered[index] = embedding as number[];
  }
  if (ordered.some((embedding) => embedding === undefined)) {
    throw new Error("OpenRouter embeddings response is invalid");
  }
  return ordered as number[][];
}
