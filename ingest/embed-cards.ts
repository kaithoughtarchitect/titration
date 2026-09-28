// Titration MCP — embed all cards lacking a vector (both tenants).
//
// Run:  OPENROUTER_API_KEY=... TITRATION_DATABASE_URL=... npx tsx ingest/embed-cards.ts
// Idempotent: only embeds rows where embedding is null (re-run after new cards).
//
// Exported as `embedAllUnembedded()` (rather than shelled out to) so scripts/setup.ts
// can call it in-process as the third step of `npm run setup`.

import "../server/bootstrap-env"; // FIRST: lib/embed reads OPENROUTER_API_KEY at import.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { embedBatch, EMBED_MODEL, toVec } from "../lib/embed";
import { postgresOptions } from "../lib/db-connect-core";

export async function embedAllUnembedded(): Promise<void> {
  const DB = process.env.TITRATION_DATABASE_URL;
  if (!DB) throw new Error("Set TITRATION_DATABASE_URL.");
  const sql = postgres(DB, postgresOptions(DB, process.env));
  try {
    const rows = await sql`select id, card_ref, title, body from cards where embedding is null order by card_ref`;
    if (rows.length === 0) { console.log("all cards already embedded — nothing to do"); return; }
    console.log(`embedding ${rows.length} cards with ${EMBED_MODEL}...`);

    const BATCH = 32;
    let done = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const vecs = await embedBatch(chunk.map((r) => `${r.title}\n\n${r.body}`));
      for (let j = 0; j < chunk.length; j++) {
        await sql`update cards set embedding = ${toVec(vecs[j])}::vector where id = ${chunk[j].id}`;
      }
      done += chunk.length;
      console.log(`  ${done}/${rows.length}`);
    }
    console.log("done");
  } finally {
    await sql.end();
  }
}

const isDirectRun =
  Array.isArray(process.argv) &&
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  embedAllUnembedded().catch((e) => { console.error(e); process.exit(1); });
}
