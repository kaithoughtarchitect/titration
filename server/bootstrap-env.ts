// Titration MCP — env bootstrap (local .env loader for the stdio server).
//
// Loads .env into process.env AT IMPORT, so the stdio MCP server can be
// launched by an MCP client (Claude Code / Desktop) WITHOUT the client config carrying
// the secrets inline. This must be the FIRST import in server.ts: ES modules evaluate
// imports in source order, so importing this before ../lib/store (which throws at import
// when TITRATION_DATABASE_URL is unset) makes the credentials available in time.
//
// Dependency-free (no dotenv) + fail-open + non-clobbering: a value already present in the
// environment (e.g. supplied via the MCP client's `env` block, or by a sourced shell) WINS
// — this only fills the gaps. A missing/unreadable .env is silently fine (the env may be
// provided another way; store.ts still throws loudly if a required var ends up unset).
//
// .env lives at .env (one level up from server/); resolved relative to THIS
// module via import.meta.url, not the process cwd, so it works regardless of where the
// client launches the server from.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

function loadDotEnv(): void {
  let text: string;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    text = readFileSync(resolve(here, "..", ".env"), "utf8");
  } catch {
    return; // no .env — fine; env may be supplied by the client config / shell
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // strip ONE layer of matching surrounding quotes (single or double)
    if (val.length >= 2 && ((val[0] === '"' && val[val.length - 1] === '"') || (val[0] === "'" && val[val.length - 1] === "'"))) {
      val = val.slice(1, -1);
    }
    // An empty value (`KEY=`, as in .env.example's optional entries) means "not set",
    // so every `??` default in the code still applies.
    if (key && val !== "" && process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv();
