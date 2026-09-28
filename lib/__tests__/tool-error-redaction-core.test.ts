// Titration MCP — tool-error redaction pipeline unit test (no network, no DB).
// Pins the behaviour of describeToolError (server/mcp-server.ts):
// a bounded tool-error message is redacted for secret-like tokens and local
// filesystem locators before it ever reaches an MCP caller.
// Run: npx tsx lib/__tests__/tool-error-redaction-core.test.ts

import { redactToolErrorText } from "../tool-error-redaction-core";

let failures = 0;
let total = 0;
function check(name: string, condition: boolean, detail = "") {
  total++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : `  ${detail}`}`);
  if (!condition) failures++;
}

// ── secret-like tokens ──────────────────────────────────────────────────────

{
  const secretKey = "sk-or-v1-4f9a2b8c1d3e5f7a9b0c2d4e6f8a1b3c5d7e9f1a3b5c7d9e";
  const message = `Request failed with key ${secretKey} rejected by the provider.`;
  const redacted = redactToolErrorText(message);
  check(
    "sk-or-v1-style key is redacted",
    redacted.includes("[REDACTED]") && !redacted.includes(secretKey),
    redacted,
  );
}

{
  const message = 'Login failed: password="Sup3rSecret!23" was rejected by the server.';
  const redacted = redactToolErrorText(message);
  check(
    "password=... pair is redacted",
    redacted.includes("[REDACTED]") && !redacted.includes("Sup3rSecret!23"),
    redacted,
  );
}

// ── local filesystem locators ───────────────────────────────────────────────

{
  const message = "Cannot read C:\\Users\\someone\\secret.txt because the file is locked.";
  const redacted = redactToolErrorText(message);
  check(
    "Windows path is redacted",
    redacted.includes("[REDACTED]")
      && !redacted.includes("secret.txt")
      && !redacted.includes("Users\\someone"),
    redacted,
  );
}

{
  const message = "Cannot reach \\\\buildserver\\share\\config.json because the network path was not found.";
  const redacted = redactToolErrorText(message);
  check(
    "UNC path is redacted",
    redacted.includes("[REDACTED]")
      && !redacted.includes("config.json")
      && !redacted.includes("buildserver"),
    redacted,
  );
}

{
  const message = "Check /home/x/y for the details.";
  const redacted = redactToolErrorText(message);
  check(
    "POSIX path is redacted",
    redacted.includes("[REDACTED]") && !redacted.includes("/home/x/y"),
    redacted,
  );
}

// ── plain text is left alone ────────────────────────────────────────────────

{
  const message = "The tool call failed because the input was too large.";
  const redacted = redactToolErrorText(message);
  check("plain sentence is unchanged", redacted === message, redacted);
}

// ── judge model ids are not paths ───────────────────────────────────────────

{
  const message = "TITRATION_JUDGES='claude,google/gemini-3.8-flash,z-ai/glm-5.3-flash' is not a valid panel: 'claude' is family 'anthropic', the Player's own vendor family";
  const redacted = redactToolErrorText(message);
  check("a panel error keeps its judge ids and family (recorded 2026-09-27)", redacted === message, redacted);
}

{
  const message = "'openai/gpt-5.6-sol' is family 'openai', the Player's own vendor family — it may not sit on the panel";
  const redacted = redactToolErrorText(message);
  check("a quoted OpenRouter id is kept", redacted === message, redacted);
}

{
  const message = "judge deepseek/deepseek-v4-flash-0731 failed: OpenRouter returned 429.";
  const redacted = redactToolErrorText(message);
  check("a judge failure keeps the judge id", redacted === message, redacted);
}

{
  const secretKey = "sk-or-v1-4f9a2b8c1d3e5f7a9b0c2d4e6f8a1b3c5d7e9f1a3b5c7d9e";
  const message = `judge z-ai/glm-5.3-flash rejected key ${secretKey}.`;
  const redacted = redactToolErrorText(message);
  check(
    "a judge id next to a leaked key: the id survives, the key does not",
    redacted.includes("z-ai/glm-5.3-flash") && !redacted.includes(secretKey),
    redacted,
  );
}

{
  // The spaced-path default-deny still takes a whole clause that contains a real
  // path, model id included. Redacting too much here is the intended trade-off.
  const message = "judge deepseek/deepseek-v4-flash-0731 failed while reading C:\\Users\\someone\\secret.txt because the file is locked.";
  const redacted = redactToolErrorText(message);
  check("a clause with a real path is still redacted", !redacted.includes("secret.txt") && !redacted.includes("Users\\someone"), redacted);
}

{
  const message = "Check /home/x/google/gemini-3.8-flash for the details.";
  const redacted = redactToolErrorText(message);
  check("a slug inside a real path is still redacted with the path", !redacted.includes("/home/x"), redacted);
}

{
  const secretKey = "sk-or-v1-4f9a2b8c1d3e5f7a9b0c2d4e6f8a1b3c5d7e9f1a3b5c7d9e";
  const message = `bad model openai/${secretKey} rejected.`;
  const redacted = redactToolErrorText(message);
  check("a secret shaped like a model id is still redacted", !redacted.includes(secretKey), redacted);
}

{
  const message = "Unknown judge 'acme/some-model' in TITRATION_JUDGES.";
  const redacted = redactToolErrorText(message);
  check("an unknown vendor prefix falls back to the normal path rules", !redacted.includes("acme/some-model"), redacted);
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"} (${total} checks)`);
process.exit(failures === 0 ? 0 : 1);
