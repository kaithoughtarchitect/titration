// Titration MCP — the card store: the card_search / card_get logic, shared by the
// MCP server, the CLI, and the smoke test. No side effects on import beyond
// opening a (lazy) postgres pool.

import postgres from "postgres";
import { createContextualSql } from "./db-context";
import { postgresOptions } from "./db-connect-core";
import { embedOne, toVec, EMBED_MODEL } from "./embed";
import { dedupeDecision, type DedupeNeighbor, type DedupeCandidate } from "./dedupe-core";
import { assembleNeighborhood, WALK_PREDICATES, type WalkEdge, type RelatedCard } from "./neighborhood-core";
import {
  CARD_REF_PREFIXES,
  canonicalizeCard,
  type CardConfidence,
  type CardSection,
  type CardStatus,
  type CardType,
} from "./card-contract-core";

const DB = process.env.TITRATION_DATABASE_URL;
if (!DB) throw new Error("Set TITRATION_DATABASE_URL.");
// Exported so the baseline store (lib/baseline.ts) shares ONE pool + the same
// tenant-lookup / writable-guard, rather than opening a second connection.
const database = createContextualSql(postgres(DB, postgresOptions(DB, process.env)));
export const sql = database.sql;
export const {
  withDbContext,
  withGuardedSql,
  currentDbContext,
} = database;

export async function tenantId(slug: string): Promise<string> {
  const [t] = await sql`select id from tenants where slug = ${slug}`;
  if (!t) throw new Error(`project '${slug}' has no data yet (a project is created by its first write)`);
  return t.id;
}

// Non-throwing lookup for card-surface reads: an unknown project is not an
// error, it is an EMPTY project — `null` is the caller's signal to short-circuit
// to "no rows here" (base is still merged one layer up, in effective-retrieval.ts)
// rather than surfacing "unknown tenant" for a project nobody has written to yet.
async function tenantIdOrNull(slug: string): Promise<string | null> {
  const [t] = await sql`select id from tenants where slug = ${slug}`;
  return t ? t.id : null;
}

// The write-side counterpart of tenantId: a write to a project that has
// never been seen before CREATES it (idempotent `on conflict do nothing`, so a
// concurrent first-write from two callers races harmlessly to the same row).
// `__base__` is refused BEFORE the insert is attempted — assertWritable is the
// same guard cardCreate/cardRelate/runCapture already call, so this never
// silently writes the curated base.
// `name` mirrors the slug (there is no separate display-name input on any tool);
// a user who wants a friendlier name edits the `tenants` row directly.
export async function tenantIdForWrite(slug: string): Promise<string> {
  assertWritable(slug);
  await sql`
    insert into tenants (slug, name, is_base)
    values (${slug}, ${slug}, false)
    on conflict (slug) do nothing`;
  const [t] = await sql`select id from tenants where slug = ${slug}`;
  if (!t) throw new Error(`failed to resolve or create project '${slug}'`);
  return t.id;
}

async function edgesFor(cardId: string, tenantId: string): Promise<string[]> {
  const rows = await sql`
    select r.predicate, coalesce(ct.card_ref, r.to_ext_ref) as target
    from card_relationships r
    left join cards ct on ct.id = r.to_card_id and ct.tenant_id = ${tenantId}
    where r.from_card_id = ${cardId}
      and r.tenant_id = ${tenantId}
      and (r.to_card_id is null or ct.id is not null)
      and r.predicate <> 'observed_in'
    order by r.predicate`;
  return rows.map((e: any) => `${e.predicate} -> ${e.target}`);
}

export interface CardRelationship {
  predicate: string;
  target: string;
  target_kind: "card" | "run" | "origin" | "doc" | "external" | "ref";
  direction: "outgoing" | "incoming";
}

async function relationshipsFor(cardId: string, tenantId: string): Promise<CardRelationship[]> {
  const rows = await sql`
    select r.predicate, coalesce(ct.card_ref, r.to_ext_ref) as target,
           case when r.to_card_id is not null then 'card' else coalesce(r.to_ext_kind, 'ref') end as target_kind,
           'outgoing' as direction
    from card_relationships r
    left join cards ct on ct.id = r.to_card_id and ct.tenant_id = ${tenantId}
    where r.from_card_id = ${cardId}
      and r.tenant_id = ${tenantId}
      and (r.to_card_id is null or ct.id is not null)
    union all
    select r.predicate, cf.card_ref as target, 'card' as target_kind, 'incoming' as direction
    from card_relationships r
    join cards cf on cf.id = r.from_card_id and cf.tenant_id = ${tenantId}
    where r.to_card_id = ${cardId}
      and r.tenant_id = ${tenantId}
    order by direction, predicate, target`;
  return rows.map((row: any) => ({
    predicate: String(row.predicate ?? ""),
    target: String(row.target ?? ""),
    target_kind: String(row.target_kind ?? "ref") as CardRelationship["target_kind"],
    direction: row.direction === "incoming" ? "incoming" : "outgoing",
  }));
}

// Richer retrieval — two opt-in powers gated behind the optional 4th arg `opts`:
//   • opts.type — restrict results[] to those card types (conditional sql fragment; empty when
//     absent so the default WHERE string is LITERALLY unchanged — byte-identical by construction).
//   • opts.hops:2 — after the (unchanged) results[] are built, walk one bounded extra hop and return
//     an ADDITIVE related[] block. results[] stays byte-identical, so the retrieval gate stays green.
// With `opts` absent, cardSearch is byte-identical to its default behavior (no related key, default WHERE).
export type CardSearchHit = { card_ref: string; type: string; title: string; score: number; edges: string[] };
export type CardSearchRelated = RelatedCard & { type: string; title: string };
export type CardSearchResult = {
  tenant: string;
  model: string;
  query: string;
  results: CardSearchHit[];
  related?: CardSearchRelated[]; // present ONLY when hops===2
};
export interface CardSearchOptions {
  type?: string[];
  hops?: 1 | 2;
  activeOnly?: boolean;
  queryVector?: number[]; // internal reuse seam: effective retrieval embeds once for both layers
}

export async function cardSearch(
  query: string,
  tenant = "__base__",
  k = 5,
  opts?: CardSearchOptions,
): Promise<CardSearchResult> {
  if (!query) throw new Error("query is required");
  // An unknown project reads as EMPTY, never "unknown tenant" — and skips the
  // embed call entirely (there is nothing to search regardless of the query
  // vector), so a caller probing a never-written project pays no embed cost.
  const tid = await tenantIdOrNull(tenant);
  if (tid === null) {
    return opts?.hops === 2
      ? { tenant, model: EMBED_MODEL, query, results: [], related: [] }
      : { tenant, model: EMBED_MODEL, query, results: [] };
  }
  const qv = toVec(opts?.queryVector ?? await embedOne(query));
  // Conditional type filter: empty `sql`` when opts.type is absent ⇒ the default WHERE
  // string is literally unchanged. The `::text` element cast is what dodges the enum-array bind trap —
  // postgres-js cannot bind a JS string[] against a `card_type[]`; this is the array analogue of the
  // single-value `${val}::card_type` enum casts elsewhere (e.g. cardDistill), not a pre-existing
  // text-cast precedent.
  const typeClause = opts?.type?.length ? sql`and type::text = any(${opts.type}::text[])` : sql``;
  // Effective tenant memory is approved-memory only. Keep the historical direct cardSearch default
  // equivalent for existing engine callers while allowing the layered seam to request the
  // stricter active-only contract.
  const statusClause = opts?.activeOnly ? sql`and status = 'active'` : sql`and status <> 'superseded'`;
  const hits = await sql`
    select id, card_ref, type, title, 1 - (embedding <=> ${qv}::vector) as score
    from cards
    where tenant_id = ${tid} and embedding is not null ${statusClause} ${typeClause}
    order by embedding <=> ${qv}::vector
    limit ${Math.min(Math.max(k, 1), 25)}`;
  const results = [];
  // Carry each hit's UUID id alongside its ref/score so the multi-hop walk can fetch edges per-seed
  // by a single from_card_id bind (never a JS-array→UUID bind).
  const seedHits: Array<{ card_ref: string; score: number; id: string }> = [];
  for (const h of hits) {
    const score = Number(Number(h.score).toFixed(3));
    results.push({
      card_ref: h.card_ref, type: h.type, title: h.title,
      score,
      edges: await edgesFor(h.id, tid),
    });
    seedHits.push({ card_ref: h.card_ref, score, id: h.id });
  }

  // ── Bounded multi-hop (opt-in, additive, fail-open) ─────────────────────────────────────
  // results[] above is byte-identical to the direct-search path; the walk ONLY adds a `related` key, and
  // ONLY when hops===2 (at unset/1 the returned object has no `related` key). The whole walk
  // (per-seed edge fetch + assemble + enrich) is wrapped fail-open: any error returns the direct
  // results[] with no `related` key (the walk is optional — an error never loses results or throws).
  if (opts?.hops === 2) {
    try {
      const edges: WalkEdge[] = [];
      const meta = new Map<string, { type: string; title: string }>();
      for (const seed of seedHits) {
        // Per-seed walk fetch: single from_card_id bind; tenant-scoped both
        // sides (defense-in-depth — the schema does not enforce same-tenant edge targets); join cards
        // by the to_card_id UUID so type/title are tenant-correct; exclude superseded neighbors
        // (no back-door revival); walk predicates compared as TEXT (dodges the enum-array bind trap);
        // SQL-bounded (limit 50 — the core caps the OUTPUT, this caps the fetch).
        const neighborStatusClause = opts?.activeOnly ? sql`and ct.status = 'active'` : sql`and ct.status <> 'superseded'`;
        const rows = await sql`
          select r.predicate, ct.card_ref as to_ref, ct.type as to_type, ct.title as to_title
          from card_relationships r
          join cards ct on ct.id = r.to_card_id
          where r.from_card_id = ${seed.id}
            and r.tenant_id = ${tid} and ct.tenant_id = ${tid}
            ${neighborStatusClause}
            and r.predicate::text = any(${[...WALK_PREDICATES]}::text[])
          order by r.predicate, ct.card_ref
          limit 50`;
        for (const e of rows) {
          edges.push({ from: seed.card_ref, predicate: e.predicate, to: e.to_ref });
          // Hydrate from the SAME to_card_id UUID join (tenant-correct — never a global
          // `where card_ref = any(...)`, since a shared ref like T-MET-001 exists in many tenants).
          if (!meta.has(e.to_ref)) meta.set(e.to_ref, { type: e.to_type, title: e.to_title });
        }
      }
      const related = assembleNeighborhood(seedHits, edges).map((r) => {
        const m = meta.get(r.card_ref);
        return { ...r, type: m?.type ?? "", title: m?.title ?? "" };
      });
      return { tenant, model: EMBED_MODEL, query, results, related };
    } catch (err) {
      // Fail-open: a walk fetch/assemble error must never lose the direct results or block
      // the search. Return results[] with NO `related` key; log via console.error.
      console.error(`[cardSearch] multi-hop walk failed for ${tenant} (hops=2); returning direct results without related:`, err instanceof Error ? err.message : err);
      return { tenant, model: EMBED_MODEL, query, results };
    }
  }

  return { tenant, model: EMBED_MODEL, query, results };
}

export interface CardDetail {
  card_ref: string;
  type: CardType;
  title: string;
  body: string;
  sections: CardSection[];
  tags: string[];
  confidence: CardConfidence | null;
  sample_size: string | null;
  reproducibility: string | null;
  status: CardStatus;
  origin_ref: string | null;
  created_at: string;
  updated_at: string;
  contract_version: number;
  edges: string[];
  relationships: CardRelationship[];
}

export async function cardGet(card_ref: string, tenant = "__base__", opts?: { activeOnly?: boolean }): Promise<CardDetail> {
  if (!card_ref) throw new Error("card_ref is required");
  // An unknown project is EMPTY, never "unknown tenant" — surface the exact
  // same "not found in tenant" shape a known-but-empty project would give, so a
  // caller (effective-retrieval.ts's project-then-base fallback) cannot tell the
  // two apart and does not need to.
  const tid = await tenantIdOrNull(tenant);
  if (tid === null) throw new Error(`card '${card_ref}' not found in tenant '${tenant}'`);
  const statusClause = opts?.activeOnly ? sql`and status = 'active'` : sql``;
  const [c] = await sql`
    select id, card_ref, type, title, body, sections, tags, confidence, sample_size,
           reproducibility, status, origin_ref, created_at, updated_at, contract_version
    from cards where tenant_id = ${tid} and card_ref = ${card_ref} ${statusClause}`;
  if (!c) throw new Error(`card '${card_ref}' not found in tenant '${tenant}'`);
  const canonical = canonicalizeCard({
    type: c.type,
    title: c.title,
    body: c.body,
    sections: c.sections,
    tags: c.tags,
    confidence: c.confidence,
    sample_size: c.sample_size,
    reproducibility: c.reproducibility,
    status: c.status,
    origin_ref: c.origin_ref,
    card_ref: c.card_ref,
  });
  return {
    card_ref: String(c.card_ref),
    type: canonical.type,
    title: canonical.title,
    body: String(c.body),
    sections: canonical.sections,
    tags: canonical.tags,
    confidence: canonical.confidence,
    sample_size: canonical.sample_size,
    reproducibility: canonical.reproducibility,
    status: canonical.status,
    origin_ref: canonical.origin_ref,
    created_at: new Date(c.created_at).toISOString(),
    updated_at: new Date(c.updated_at).toISOString(),
    contract_version: Number(c.contract_version ?? 0),
    edges: await edgesFor(c.id, tid),
    relationships: await relationshipsFor(c.id, tid),
  };
}

// ── write path (A5) ──────────────────────────────────────────────────────────

const PREDICATES = new Set([
  "supersedes", "superseded_by", "supports", "contradicts", "complements",
  "extends", "instance_of", "observed_in", "documented_in", "cures",
]);

export function assertWritable(tenant: string) {
  if (tenant === "__base__")
    throw new Error("'__base__' is read-only (curated); write to a project workspace such as 'demo'");
}

export function assertCardWritable(tenant: string) {
  assertWritable(tenant);
}
function extKind(ref: string): string {
  if (ref.startsWith("RUN-")) return "run";
  if (ref.startsWith("ORIGIN-")) return "origin";
  if (ref.startsWith("EXTERNAL-")) return "external";
  if (ref.includes(".md") || ref.startsWith("docs/")) return "doc";
  return "ref";
}

export interface NewCard {
  type: string; title: string; body: string; sections?: CardSection[]; tags?: string[];
  confidence?: string | null; sample_size?: string | null;
  reproducibility?: string | null; status?: string; origin_ref?: string | null; card_ref?: string;
}

// cardCreate's return — additive + backward-compatible. The default path returns just { tenant,
// card_ref } (byte-identical to the no-dedup path). With dedup ON (flywheel auto-capture), a near-dup
// equal/lower-confidence match returns `deduped:"reinforced"` (no insert; card_ref is the EXISTING
// matched ref), and a strictly-higher-confidence near-dup inserts the new card AND surfaces a
// `proposed_supersession` advisory (NO status flip, NO `supersedes` edge).
// The supersede-proposed advisory shape — ONE source of truth (also carried on flywheel's
// CaptureResult). `predicate` is the literal `"supersedes"`: this advisory can name no other edge.
export type ProposedSupersession = { target: string; predicate: "supersedes"; reason: string };

export interface CardCreateResult {
  tenant: string;
  card_ref: string;
  deduped?: "reinforced";
  proposed_supersession?: ProposedSupersession;
}

export async function cardCreate(tenant: string, c: NewCard, opts?: { dedupe?: boolean }): Promise<CardCreateResult> {
  assertCardWritable(tenant);
  // The first write to a never-seen project CREATES it (idempotent).
  const tid = await tenantIdForWrite(tenant);
  const supplied = {
    tags: c.tags !== undefined,
    confidence: c.confidence !== undefined,
    sample_size: c.sample_size !== undefined,
    reproducibility: c.reproducibility !== undefined,
    status: c.status !== undefined,
    origin_ref: c.origin_ref !== undefined,
  };
  const card = canonicalizeCard(c);
  const prefix = CARD_REF_PREFIXES[card.type];

  const autoRef = !card.card_ref;
  let ref: string;
  if (!card.card_ref) {
    const rows = await sql`select card_ref from cards where tenant_id = ${tid} and card_ref like ${prefix + "-%"}`;
    const max = rows.reduce((m: number, r: any) => Math.max(m, parseInt(r.card_ref.split("-").pop(), 10) || 0), 0);
    ref = `${prefix}-${String(max + 1).padStart(3, "0")}`;
  } else {
    ref = card.card_ref;
  }

  // ── Write-time dedup (autoRef-only, opt-in, fail-open) ──────────────────────────────────
  // ON only for the flywheel auto-capture path (the #1 near-duplicate source); OFF by default so
  // direct cardCreate callers stay byte-identical. The decision logic is the pure dedupe-core; this
  // layer does the one embed + the same-type cosine scan and marshals rows into DedupeNeighbor[].
  // The candidate embedding computed HERE is reused for embed-on-write on a `create` (one embed, not
  // two). Any error in the pre-check FALLS OPEN to a plain create: a card is never lost and no
  // exception escapes. The reinforce branch returns early (no insert); supersede-proposed
  // inserts the new card AND surfaces an advisory — it NEVER flips status or creates a `supersedes`
  // edge. The explicit-ref upsert path below is untouched.
  let precomputedVec: string | null = null;
  let proposedSupersession: ProposedSupersession | null = null;
  if (autoRef && opts?.dedupe) {
    try {
      const cand = toVec(await embedOne(`${card.title}\n\n${card.body}`));
      precomputedVec = cand; // reuse for embed-on-write on the `create` outcome (one embed)
      const rows = await sql`
        select card_ref, type, title, 1 - (embedding <=> ${cand}::vector) as score, confidence, sample_size
        from cards
        where tenant_id = ${tid} and status = 'active' and type = ${card.type}::card_type and embedding is not null
        order by embedding <=> ${cand}::vector
        limit 8`;
      const neighbors: DedupeNeighbor[] = rows.map((r: any) => ({
        card_ref: r.card_ref, type: r.type, title: r.title,
        score: Number(r.score), confidence: r.confidence, sample_size: r.sample_size,
      }));
      const candidate: DedupeCandidate = {
        type: card.type, title: card.title, body: card.body,
        confidence: card.confidence, sample_size: card.sample_size,
      };
      const decision = dedupeDecision(candidate, neighbors);
      if (decision.action === "reinforce") {
        // REINFORCE: bump ONLY sample_size + updated_at on the matched card; NEVER touch
        // body/title/tags/confidence (the curated moat). No insert — return the existing ref.
        await sql`
          update cards set sample_size = ${decision.nextSampleSize}, updated_at = now()
          where tenant_id = ${tid} and card_ref = ${decision.targetRef}`;
        return { tenant, card_ref: decision.targetRef, deduped: "reinforced" as const };
      }
      if (decision.action === "supersede-proposed") {
        // Surface the advisory; the new card still inserts below. NO status flip, NO edge.
        proposedSupersession = { target: decision.targetRef, predicate: "supersedes", reason: decision.reason };
      }
      // decision.action === "create" (or supersede-proposed) ⇒ fall through to the normal insert.
    } catch (err) {
      // Fail-open: a transient embed/scan error must never lose the card or block the verdict.
      console.error(`[cardCreate] dedup pre-check failed for ${tenant}/${ref}; falling through to plain create:`, err instanceof Error ? err.message : err);
      precomputedVec = null; // the plain embed-on-write below will run its own embed
    }
  }

  // An EXPLICIT card_ref means "upsert this card" (an intentional update). An AUTO-assigned ref must
  // be NOVEL: if it collides, our scanned max raced a concurrent create (or the store is otherwise
  // inconsistent), and silently overwriting a *different* card via on-conflict is the footgun we are
  // closing. So the auto path uses a plain INSERT (the unique constraint is the race-safe arbiter) and
  // translates a duplicate-key violation into a clear, actionable error instead of clobbering.
  if (autoRef) {
    try {
      await sql`
        insert into cards
          (tenant_id, card_ref, type, title, body, sections, tags, confidence, status,
           sample_size, reproducibility, origin_ref, contract_version)
        values
          (${tid}, ${ref}, ${card.type}::card_type, ${card.title}, ${card.body},
           ${sql.json(card.sections as any)}, ${card.tags}, ${card.confidence}::confidence,
           ${card.status}::card_status, ${card.sample_size}, ${card.reproducibility},
           ${card.origin_ref}, ${card.contract_version})`;
    } catch (err: any) {
      if (err?.code === "23505") {
        throw new Error(
          `auto-assigned ref '${ref}' already exists in '${tenant}' — a concurrent create likely raced, or the store is inconsistent. Refusing to overwrite a different card; pass an explicit card_ref to update a specific card.`
        );
      }
      throw err;
    }
  } else {
    await sql`
      insert into cards
        (tenant_id, card_ref, type, title, body, sections, tags, confidence, status,
         sample_size, reproducibility, origin_ref, contract_version)
      values
        (${tid}, ${ref}, ${card.type}::card_type, ${card.title}, ${card.body},
         ${sql.json(card.sections as any)}, ${card.tags}, ${card.confidence}::confidence,
         ${card.status}::card_status, ${card.sample_size}, ${card.reproducibility},
         ${card.origin_ref}, ${card.contract_version})
      on conflict (tenant_id, card_ref) do update set
        type = excluded.type, title = excluded.title, body = excluded.body,
        sections = excluded.sections,
        tags = case when ${supplied.tags} then excluded.tags else cards.tags end,
        confidence = case when ${supplied.confidence} then excluded.confidence else cards.confidence end,
        status = case when ${supplied.status} then excluded.status else cards.status end,
        sample_size = case when ${supplied.sample_size} then excluded.sample_size else cards.sample_size end,
        reproducibility = case when ${supplied.reproducibility} then excluded.reproducibility else cards.reproducibility end,
        origin_ref = case when ${supplied.origin_ref} then excluded.origin_ref else cards.origin_ref end,
        contract_version = excluded.contract_version, updated_at = now()`;
  }

  // Embed-on-write (best-effort, fail-open). cardSearch filters `embedding is not null`, so an
  // un-embedded card is invisible to retrieval (gotcha #15) — the bug a /t-run hit when card_search
  // missed freshly-created cards. Embed inline with the same title+body text the embed-cards backfill
  // uses, so a fresh create is immediately searchable and a body edit refreshes the vector. A failure
  // never blocks the write — the card persists and embed-cards can backfill the null later. When the
  // dedup pre-check already embedded this candidate (the `create`/`supersede-proposed` outcome), that
  // vector is REUSED here — one embed per write, not two.
  try {
    const vec = precomputedVec ?? toVec(await embedOne(`${card.title}\n\n${card.body}`));
    await sql`update cards set embedding = ${vec}::vector where tenant_id = ${tid} and card_ref = ${ref}`;
  } catch (err) {
    console.error(`[cardCreate] embed-on-write failed for ${tenant}/${ref}; card persisted, embedding deferred:`, err instanceof Error ? err.message : err);
  }

  return proposedSupersession
    ? { tenant, card_ref: ref, proposed_supersession: proposedSupersession }
    : { tenant, card_ref: ref };
}

export async function cardRelate(tenant: string, from_ref: string, predicate: string, to: string) {
  assertCardWritable(tenant);
  if (!PREDICATES.has(predicate)) throw new Error(`invalid predicate '${predicate}'`);
  // The first write to a never-seen project CREATES it (idempotent).
  const tid = await tenantIdForWrite(tenant);
  const [from] = await sql`select id from cards where tenant_id = ${tid} and card_ref = ${from_ref}`;
  if (!from) throw new Error(`from-card '${from_ref}' not found in '${tenant}'`);

  const [toCard] = /^T-[A-Z]+-\d+$/.test(to)
    ? await sql`select id from cards where tenant_id = ${tid} and card_ref = ${to}`
    : [undefined];

  if (toCard) {
    const [ex] = await sql`select 1 from card_relationships where tenant_id=${tid} and from_card_id=${from.id} and predicate=${predicate}::predicate and to_card_id=${toCard.id}`;
    if (!ex) await sql`insert into card_relationships (tenant_id, from_card_id, predicate, to_card_id) values (${tid}, ${from.id}, ${predicate}::predicate, ${toCard.id})`;
    return { tenant, edge: `${from_ref} ${predicate} ${to}`, created: !ex };
  }
  const [ex] = await sql`select 1 from card_relationships where tenant_id=${tid} and from_card_id=${from.id} and predicate=${predicate}::predicate and to_ext_ref=${to}`;
  if (!ex) await sql`insert into card_relationships (tenant_id, from_card_id, predicate, to_ext_ref, to_ext_kind) values (${tid}, ${from.id}, ${predicate}::predicate, ${to}, ${extKind(to)})`;
  return { tenant, edge: `${from_ref} ${predicate} ${to}`, created: !ex };
}

export async function runCapture(tenant: string, ref: string, summary: string | null, cards: string[] = []) {
  assertCardWritable(tenant);
  if (!ref) throw new Error("run ref is required");
  // The first write to a never-seen project CREATES it (idempotent).
  const tid = await tenantIdForWrite(tenant);
  await sql`insert into runs (tenant_id, ref, summary) values (${tid}, ${ref}, ${summary})
            on conflict (tenant_id, ref) do update set summary = excluded.summary`;
  let linked = 0;
  for (const cref of cards) {
    const [c] = await sql`select id from cards where tenant_id = ${tid} and card_ref = ${cref}`;
    if (!c) continue;
    const [ex] = await sql`select 1 from card_relationships where tenant_id=${tid} and from_card_id=${c.id} and predicate='observed_in'::predicate and to_ext_ref=${ref}`;
    if (!ex) { await sql`insert into card_relationships (tenant_id, from_card_id, predicate, to_ext_ref, to_ext_kind) values (${tid}, ${c.id}, 'observed_in', ${ref}, 'run')`; linked++; }
  }
  return { tenant, run: ref, linked_cards: linked };
}

// Read-only aggregate: the on-demand distilled surface over a project's active cards.
export async function cardDistill(tenant: string, opts: { type?: string; tag?: string } = {}) {
  // An unknown project reads as EMPTY, never "unknown tenant".
  const tid = await tenantIdOrNull(tenant);
  if (tid === null) return { tenant, count: 0, filter: opts, by_type: {} as Record<string, Array<{ card_ref: string; title: string; confidence: string | null }>> };
  const rows = await sql`
    select card_ref, type, title, confidence from cards
    where tenant_id = ${tid} and status = 'active'
      and (${opts.type ?? null}::text is null or type = ${opts.type ?? null}::card_type)
      and (${opts.tag ?? null}::text is null or ${opts.tag ?? null} = any(tags))
    order by type, card_ref`;
  const by_type: Record<string, Array<{ card_ref: string; title: string; confidence: string | null }>> = {};
  for (const r of rows) (by_type[r.type] ??= []).push({ card_ref: r.card_ref, title: r.title, confidence: r.confidence });
  return { tenant, count: rows.length, filter: opts, by_type };
}

export async function close() { await sql.end(); }
