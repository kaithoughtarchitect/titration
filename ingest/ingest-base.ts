// Titration MCP — ingestion: the curated universal base (the __base__ tenant)
//
// Parses docs/core-learnings/CORE-LEARNINGS-v*.md into `cards` rows
// and `card_relationships` edges under the __base__ tenant. Idempotent: cards
// upsert on (tenant_id, card_ref); base edges are fully re-inserted each run.
//
// Run:  npx tsx ingest/ingest-base.ts (loads the repo-root .env first)
//
// Exported as `ingestBase()` (rather than shelled out to) so scripts/setup.ts can
// call it in-process as the second step of `npm run setup`.

import "../server/bootstrap-env";

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { embedBatch, EMBED_MODEL, toVec } from "../lib/embed";
import { canonicalizeCard } from "../lib/card-contract-core";
import { postgresOptions } from "../lib/db-connect-core";

const DIR = join(process.cwd(), "docs/core-learnings");

const VALID = new Set([
  "supersedes", "superseded_by", "supports", "contradicts", "complements",
  "extends", "instance_of", "observed_in", "documented_in", "cures",
]);
const ALIAS: Record<string, string> = { generalized_by: "superseded_by" };

type Edge = { predicate: string; toRef?: string; toExt?: string };
type Card = {
  ref: string; type: string; title: string; body: string;
  confidence: string | null; tags: string[]; status: string;
  origin: string | null; edges: Edge[];
};

function parseFile(text: string): Card[] {
  const cards: Card[] = [];
  const blocks = text.split(/\n(?=## )/).filter((b) => b.startsWith("## "));
  for (const block of blocks) {
    const lines = block.split("\n");
    const header = lines[0].replace(/^##\s+/, "").trim();
    const hm = header.match(/^(T-[A-Z]+-\d+)\s+—\s+(.+)$/);
    if (!hm) continue; // not a card block (footer note, etc.)
    const ref = hm[1];
    const title = hm[2].trim();

    const metaIdx = lines.findIndex((l) => /\*\*Type:\*\*/.test(l));
    const meta = metaIdx >= 0 ? lines[metaIdx] : "";
    const type = (meta.match(/\*\*Type:\*\*\s*([A-Z_]+)/) || [])[1] || "METHOD";
    const confidence = (meta.match(/\*\*Confidence:\*\*\s*(\w+)/) || [])[1]?.toLowerCase() || null;
    const tagsRaw = (meta.match(/\*\*Tags:\*\*\s*(.+)$/) || [])[1] || "";
    const tags = tagsRaw.split(/,\s*/).map((t) => t.trim()).filter(Boolean);
    const status = tags.includes("candidate") ? "candidate" : "active";

    const relIdx = lines.findIndex((l) => /\*\*Relationships\.\*\*/.test(l));
    const originIdx = lines.findIndex((l) => /\*\*Origin\.\*\*/.test(l));
    const bodyEnd = relIdx >= 0 ? relIdx : originIdx >= 0 ? originIdx : lines.length;
    const body = lines.slice(metaIdx + 1, bodyEnd).join("\n").trim();

    const origin = originIdx >= 0
      ? lines[originIdx].replace(/\*\*Origin\.\*\*\s*/, "").trim().replace(/\.$/, "") || null
      : null;

    const edges: Edge[] = [];
    if (relIdx >= 0) {
      const rel = lines[relIdx].replace(/\*\*Relationships\.\*\*\s*/, "");
      for (const item of rel.split(/\s+·\s+/)) {
        const pm = item.match(/`([a-z_]+)`/);
        if (!pm) continue;
        const pred = ALIAS[pm[1]] || pm[1];
        if (!VALID.has(pred)) continue;
        const refs = item.match(/T-[A-Z]+-\d+/g);
        if (refs && refs.length) {
          for (const r of refs) edges.push({ predicate: pred, toRef: r });
        } else {
          const ext = item.replace(/`[a-z_]+`/, "").trim();
          if (ext) edges.push({ predicate: pred, toExt: ext });
        }
      }
    }
    cards.push({ ref, type, title, body, confidence, tags, status, origin, edges });
  }
  return cards;
}

function assertSourceIntegrity(cards: readonly Card[]): void {
  const refs = new Set<string>();
  const duplicates: string[] = [];
  for (const card of cards) {
    if (refs.has(card.ref)) duplicates.push(card.ref);
    refs.add(card.ref);
  }
  if (duplicates.length > 0) {
    throw new Error(`base source has duplicate card_ref values: ${[...new Set(duplicates)].join(", ")}`);
  }

  const missingTargets = cards.flatMap((card) =>
    card.edges
      .filter((edge) => edge.toRef && !refs.has(edge.toRef))
      .map((edge) => `${card.ref} -[${edge.predicate}]-> ${edge.toRef}`),
  );
  if (missingTargets.length > 0) {
    throw new Error(
      `base source has relationship target(s) absent from the curated corpus: ${missingTargets.join(", ")}`,
    );
  }
}

export async function ingestBase(): Promise<void> {
  const DB = process.env.TITRATION_DATABASE_URL;
  if (!DB) {
    throw new Error("Set TITRATION_DATABASE_URL to the Postgres connection string.");
  }

  const files = readdirSync(DIR).filter((f) => /^CORE-LEARNINGS-v.*\.md$/.test(f)).sort();
  const all: Card[] = [];
  for (const f of files) all.push(...parseFile(readFileSync(join(DIR, f), "utf8")));
  assertSourceIntegrity(all);

  const sql = postgres(DB, postgresOptions(DB, process.env));
  try {
    const [tenant] = await sql`select id from tenants where slug = '__base__'`;
    const tid = tenant.id;

    for (const c of all) {
      const card = canonicalizeCard({
        type: c.type,
        title: c.title,
        body: c.body,
        tags: c.tags,
        confidence: c.confidence,
        status: c.status,
        origin_ref: c.origin,
        card_ref: c.ref,
      });
      await sql`
        insert into cards
          (tenant_id, card_ref, type, title, body, sections, tags, confidence, status,
           sample_size, reproducibility, origin_ref, contract_version)
        values
          (${tid}, ${card.card_ref ?? c.ref}, ${card.type}::card_type, ${card.title}, ${card.body},
           ${sql.json(card.sections as any)}, ${card.tags}, ${card.confidence}::confidence,
           ${card.status}::card_status, ${card.sample_size}, ${card.reproducibility},
           ${card.origin_ref}, ${card.contract_version})
        on conflict (tenant_id, card_ref) do update set
          embedding = case
            when cards.title is distinct from excluded.title or cards.body is distinct from excluded.body then null
            else cards.embedding
          end,
          type = excluded.type, title = excluded.title, body = excluded.body,
          sections = excluded.sections, tags = excluded.tags, confidence = excluded.confidence,
          status = excluded.status, sample_size = excluded.sample_size,
          reproducibility = excluded.reproducibility, origin_ref = excluded.origin_ref,
          contract_version = excluded.contract_version, updated_at = now()
      `;
    }

    await sql`delete from card_relationships where tenant_id = ${tid}`;
    let cardEdges = 0, extEdges = 0, skipped = 0;
    for (const c of all) {
      const [from] = await sql`select id from cards where tenant_id = ${tid} and card_ref = ${c.ref}`;
      for (const e of c.edges) {
        if (e.toRef) {
          const [to] = await sql`select id from cards where tenant_id = ${tid} and card_ref = ${e.toRef}`;
          if (!to) { skipped++; continue; }
          await sql`insert into card_relationships (tenant_id, from_card_id, predicate, to_card_id)
                    values (${tid}, ${from.id}, ${e.predicate}::predicate, ${to.id})`;
          cardEdges++;
        } else if (e.toExt) {
          const kind = /\.md/.test(e.toExt) ? "doc" : "ref";
          await sql`insert into card_relationships (tenant_id, from_card_id, predicate, to_ext_ref, to_ext_kind)
                    values (${tid}, ${from.id}, ${e.predicate}::predicate, ${e.toExt}, ${kind})`;
          extEdges++;
        }
      }
    }

    const [{ count }] = await sql`select count(*)::int as count from cards where tenant_id = ${tid}`;
    console.log(
      `ingested ${all.length} parsed cards (base tenant now has ${count}); ` +
      `edges: ${cardEdges} card→card, ${extEdges} external, ${skipped} skipped (target not in base)`
    );

    // Embed freshly-ingested base cards HERE so `ingest:base` is self-sufficient. A card is INVISIBLE
    // to semantic search until embedded (cardSearch filters `embedding is not null`) — historically a
    // separate `embed-cards.ts` run was required, and forgetting it left a new base card silently
    // unretrievable. Idempotent (only null rows). FAIL-SOFT: the cards are already persisted, so an
    // embed failure (e.g. missing embed key) must NOT fail the ingest — it warns loudly with the exact
    // recovery command instead of silently leaving the card unsearchable. (embed-cards.ts stays for a
    // full both-tenant backfill.)
    try {
      const toEmbed = await sql`select id, title, body from cards where tenant_id = ${tid} and embedding is null order by card_ref`;
      if (toEmbed.length === 0) {
        console.log("all base cards already embedded.");
      } else {
        console.log(`embedding ${toEmbed.length} new base card(s) with ${EMBED_MODEL}...`);
        const BATCH = 32;
        for (let i = 0; i < toEmbed.length; i += BATCH) {
          const chunk = toEmbed.slice(i, i + BATCH);
          const vecs = await embedBatch(chunk.map((r) => `${r.title}\n\n${r.body}`));
          for (let j = 0; j < chunk.length; j++) {
            await sql`update cards set embedding = ${toVec(vecs[j])}::vector where id = ${chunk[j].id}`;
          }
        }
        console.log(`  embedded ${toEmbed.length} — base cards are now searchable.`);
      }
    } catch (e: any) {
      console.warn(
        `⚠ ingest succeeded, but embedding the new base card(s) FAILED (${e?.message ?? e}). ` +
        `The cards are loaded but NOT yet searchable — run \`npx tsx ingest/embed-cards.ts\` to finish.`,
      );
    }
  } finally {
    await sql.end();
  }
}

const isDirectRun =
  Array.isArray(process.argv) &&
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  ingestBase().catch((e) => { console.error(e); process.exit(1); });
}
