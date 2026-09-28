// Titration MCP — the one place the public repo URL is spelled out.
//
// Used only as the OpenRouter `HTTP-Referer` header value (lib/judge.ts):
// OpenRouter asks integrations to identify themselves with a referring URL.
// A single exported constant keeps that identifier in exactly one file.
export const PUBLIC_REPO_URL = "https://github.com/kaithoughtarchitect/titration";
