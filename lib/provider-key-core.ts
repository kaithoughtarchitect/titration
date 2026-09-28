// Titration MCP — provider API key parsing and its typed failure (PURE, import-free).
//
// Self-hosted Titration reads one OpenRouter key from the environment. There is no
// credential store, KEK, or per-user key; this core only validates the key's shape
// and names the failure a caller reports when it is missing or rejected.

export type ProviderCredentialFailureCode =
  | "invalid_input"
  | "credential_required"
  | "credential_invalid";

const FAILURE_MESSAGES: Record<ProviderCredentialFailureCode, string> = {
  invalid_input: "OPENROUTER_API_KEY is malformed.",
  credential_required: "Set OPENROUTER_API_KEY before using an OpenRouter judge or embeddings.",
  credential_invalid: "OpenRouter rejected OPENROUTER_API_KEY.",
};

export class ProviderCredentialError extends Error {
  readonly retryable = false;

  constructor(readonly code: ProviderCredentialFailureCode) {
    super(FAILURE_MESSAGES[code]);
    this.name = "ProviderCredentialError";
  }
}

export function parseProviderApiKey(value: unknown): string {
  if (typeof value !== "string" || value.length < 12 || value.length > 512) {
    throw new ProviderCredentialError("invalid_input");
  }
  if (value !== value.trim() || /[\u0000- \u007f]/.test(value)) {
    throw new ProviderCredentialError("invalid_input");
  }
  return value;
}

export function resolveOpenRouterApiKeyFrom(env: Record<string, string | undefined>): string {
  const key = env.OPENROUTER_API_KEY;
  if (!key) throw new ProviderCredentialError("credential_required");
  return parseProviderApiKey(key);
}
