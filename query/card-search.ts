// Titration MCP — semantic card_search + graph expansion (GraphRAG).
//
// Embeds the query, vector-searches one project's cards, and for each hit prints
// its typed outgoing edges — semantic recall seeded, graph context attached.
//
// Run:  OPENROUTER_API_KEY=... TITRATION_DATABASE_URL=... \
//       npx tsx query/card-search.ts "your question"
// Env:  TITRATION_TENANT=<project name> (default "default"); "__base__" reads the
//       read-only curated starter pack. Internal naming stays "tenant"; the
//       value is normalized through the same lib/project-core.ts resolveProject
//       every MCP tool routes through.

import "../server/bootstrap-env"; // FIRST: lib/embed reads OPENROUTER_API_KEY at import.
import postgres from "postgres";
import { embedOne, EMBED_MODEL, toVec } from "../lib/embed";
import { postgresOptions } from "../lib/db-connect-core";
import { resolveProject } from "../lib/project-core";

const DB = process.env.TITRATION_DATABASE_URL;
if (!DB) { console.error("Set TITRATION_DATABASE_URL."); process.exit(1); }

const query = process.argv.slice(2).join(" ").trim();
const tenant = resolveProject(process.env.TITRATION_TENANT);
const K = Number(process.env.TITRATION_K || 5);
if (!query) { console.error('usage: npx tsx query/card-search.ts "<query>"'); process.exit(1); }

async function main() {
  const qv = toVec(await embedOne(query));
  const sql = postgres(DB!, postgresOptions(DB!, process.env));
  try {
    const [t] = await sql`select id from tenants where slug = ${tenant}`;
    const hits = await sql`
      select id, card_ref, type, title, 1 - (embedding <=> ${qv}::vector) as score
      from cards
      where tenant_id = ${t.id} and embedding is not null
      order by embedding <=> ${qv}::vector
      limit ${K}`;

    console.log(`\nquery: "${query}"   (tenant ${tenant}, model ${EMBED_MODEL})\n`);
    for (const h of hits) {
      console.log(`  ${Number(h.score).toFixed(3)}  ${h.card_ref}  —  ${h.title}`);
      const edges = await sql`
        select r.predicate, coalesce(ct.card_ref, r.to_ext_ref) as target
        from card_relationships r
        left join cards ct on ct.id = r.to_card_id
        where r.from_card_id = ${h.id} and r.predicate <> 'observed_in'
        order by r.predicate`;
      for (const e of edges) console.log(`           └─ ${e.predicate} → ${e.target}`);
    }
    console.log();
  } finally {
    await sql.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
