// Titration MCP — resolves the OpenRouter key from the process environment.
import { resolveOpenRouterApiKeyFrom } from "./provider-key-core";

export async function resolveOpenRouterApiKey(): Promise<string> {
  return resolveOpenRouterApiKeyFrom(process.env);
}
