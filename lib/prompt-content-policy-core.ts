// Import-clean exact-prompt storage policy shared by any UI seam and remote MCP client.

export class PromptContentLimitError extends Error {
  constructor(public readonly bytes: number, public readonly maxBytes: number) {
    super(`prompt content is ${bytes} bytes; exact capture limit is ${maxBytes} bytes`);
    this.name = "PromptContentLimitError";
  }
}

export const DEFAULT_PROMPT_CONTENT_MAX_BYTES = 65_536;

export function promptContentMaxBytes(raw: unknown): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PROMPT_CONTENT_MAX_BYTES;
}

export function assertExactPromptFits(text: string, maxBytes: number): number {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) throw new PromptContentLimitError(bytes, maxBytes);
  return bytes;
}
