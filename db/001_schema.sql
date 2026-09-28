-- Titration (self-hosted) — engine baseline schema (migration 001)
--
-- ONE fresh migration for the OSS engine. Consolidated from the internal product's
-- migrations 001-006, 010, 016, 022, 023, 026, 027, 040, 048 — engine tables only.
-- Deliberately NOT ported (see db/README.md for the full list): roles, RLS, grants,
-- policies, `organization_id` / `access_class` / `is_default_workspace`, a retired
-- reserved tenant, web-UI tables (e.g. `prompt_content`, `verdict_log`), and
-- the 027 `prompt_content` backfill (there is no `prompt_content` table here for it
-- to read from).
--
-- Idempotent: every statement is create-if-not-exists / add-if-not-exists / seed
-- on-conflict-do-nothing, safe to re-run. scripts/migrate.ts applies this file's
-- body inside its own transaction (see LEDGER_SQL + `apply()`), so no begin/commit
-- here.

create extension if not exists vector;

-- ── tenants ──────────────────────────────────────────────────────────────────
create table if not exists tenants (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,
  name        text not null,
  is_base     boolean not null default false,   -- the read-only universal-base tenant
  created_at  timestamptz not null default now()
);

-- Seeds: the universal base (read-only, curated) and one ready-to-use project
-- workspace so a fresh install has somewhere to write on the first `card_create`.
insert into tenants (slug, name, is_base) values
  ('__base__', 'Universal base (curated core-learnings)', true)
on conflict (slug) do nothing;

insert into tenants (slug, name, is_base) values
  ('default', 'Default project workspace', false)
on conflict (slug) do nothing;

-- ── enums ────────────────────────────────────────────────────────────────────
do $$ begin
  create type card_type as enum
    ('METHOD','FINDING','REGRESSION','MODEL_PROFILE','PROMPT_BEHAVIOR','DATASET_NOTE');
exception when duplicate_object then null; end $$;

do $$ begin
  create type card_status as enum ('active','candidate','superseded','archived');
exception when duplicate_object then null; end $$;

do $$ begin
  create type confidence as enum ('low','medium','high','critical');
exception when duplicate_object then null; end $$;

do $$ begin
  create type predicate as enum
    ('supersedes','superseded_by','supports','contradicts','complements',
     'extends','instance_of','observed_in','documented_in','cures');
exception when duplicate_object then null; end $$;

-- ── cards (relational core + embedding + card-contract v1) ──────────────────
-- `body` stays the retrieval/backwards-compatible Markdown representation.
-- `sections` is the ordered presentation contract (card-contract-core.ts);
-- `contract_version` distinguishes cards normalized under it (1) from legacy (0).
create table if not exists cards (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id),
  card_ref          text not null,                 -- human ID, e.g. 'T-MET-001'
  type              card_type not null,
  title             text not null,
  body              text not null,                 -- the card markdown content
  sections          jsonb not null default '[]'::jsonb,
  contract_version  smallint not null default 0,
  tags              text[] not null default '{}',
  confidence        confidence,
  sample_size       text,                          -- free-form: 'n=186', '5 x 7 cards'
  reproducibility   text,
  status            card_status not null default 'active',
  origin_ref        text,                          -- source card in the originating ledger (traceability)
  embedding         vector(1536),                  -- openai/text-embedding-3-small (see lib/embed.ts)
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, card_ref),
  constraint cards_sections_array_check check (jsonb_typeof(sections) = 'array'),
  constraint cards_contract_version_check check (contract_version in (0, 1))
);
create index if not exists cards_tenant_type_status_idx on cards (tenant_id, type, status);
create index if not exists cards_tags_idx on cards using gin (tags);
-- hnsw builds incrementally (no training data needed) and is exact-enough at this
-- corpus size; cosine ops because text-embedding-3-small is normalized.
create index if not exists cards_embedding_idx
  on cards using hnsw (embedding vector_cosine_ops);

-- ── card_relationships (the typed graph) ─────────────────────────────────────
create table if not exists card_relationships (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  from_card_id  uuid not null references cards(id) on delete cascade,
  predicate     predicate not null,
  to_card_id    uuid references cards(id) on delete cascade,   -- card -> card edge
  to_ext_ref    text,                                          -- OR external target...
  to_ext_kind   text,                                          -- 'run' | 'doc' | 'ref'
  created_at    timestamptz not null default now(),
  -- exactly one target: another card, or an external ref
  constraint card_rel_one_target check ((to_card_id is not null) <> (to_ext_ref is not null))
);
create index if not exists card_rel_from_idx on card_relationships (from_card_id, predicate);
create index if not exists card_rel_to_idx   on card_relationships (to_card_id);

-- ── runs (observed_in provenance) ────────────────────────────────────────────
create table if not exists runs (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  ref         text not null,                     -- 'RUN-2026-06-11_dialogue-purity-validation'
  summary     text,
  created_at  timestamptz not null default now(),
  unique (tenant_id, ref)
);

-- ── baselines (the frozen measuring stick; insert-only by contract) ─────────
-- Every column is read structurally by `verify` (it diffs the candidate's graded
-- rates against the frozen baseline under the SAME rubric_hash) or is part of the
-- seal. Insert-only: the store exposes no update path; a re-grade is a new row.
create table if not exists baselines (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  goal          text not null,                 -- what behavior is wanted / what the bug is
  system_ref    text,                          -- the system-under-test identifier (free-form)
  corpus_ref    text,                          -- the corpus identifier (free-form; outputs ship inline)
  rubric_text   text not null,                 -- the frozen grading rubric (semantic; applied by the judges)
  rubric_hash   text not null,                 -- sha256 of the normalized rubric — the mechanical seal
  baseline_rate double precision not null,     -- aggregate failure (bug-present) rate; verify diffs against it
  effective_n   integer not null,              -- scorable rows (consensus reached; inconclusive rows dropped)
  agreement     double precision not null,     -- mean inter-judge agreement → noise floor = 1 - agreement
  per_mode      jsonb not null default '{}',   -- { "<mode>": { "rate": <0..1>, "n": <int> } }
  -- per-judge calibration (verify compares each judge's candidate rate to its OWN
  -- baseline rate, not the consensus rate, so a stricter judge never reads as a false regressor):
  -- { "<judge_id>": { "rate": <0..1>, "n": <int> } }
  per_judge     jsonb not null default '{}'::jsonb,
  -- exact judge vendor/transport/model/effort snapshot captured when the baseline was graded
  judge_panel   jsonb not null default '{}'::jsonb,
  -- opt-in per-row grade retention (EstablishArgs.retain_rows). NULLABLE with NO
  -- DEFAULT — NULL is the load-bearing "not retained" signal.
  per_row       jsonb,
  reproduced    boolean not null,              -- the load-bearing precondition (always true for stored rows)
  created_at    timestamptz not null default now()
);
create index if not exists baselines_tenant_idx on baselines (tenant_id, created_at desc);

-- ── jobs (the shared async job store) ───────────────────────────────────────
create table if not exists jobs (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id),
  kind         text not null check (kind in ('verify', 'establish_baseline', 'goal_titrate')),
  status       text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed')),
  input        jsonb not null default '{}',   -- lightweight request summary (NOT the full corpus)
  result       jsonb,                         -- terminal VerifyResult/EstablishResult (null until succeeded)
  error        text,                          -- failure message (null unless status = 'failed')
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  terminal_at  timestamptz                    -- set when status becomes succeeded/failed
);
create index if not exists jobs_tenant_idx on jobs (tenant_id, created_at desc);
create index if not exists jobs_live_idx on jobs (status) where status in ('queued', 'running');

-- ── goal_titrate_turns (the per-turn loop store; append-only) ───────────────
create table if not exists goal_titrate_turns (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references jobs(id),     -- the goal_titrate run this turn belongs to
  tenant_id   uuid not null references tenants(id),  -- denormalized for direct tenant-scoped reads
  turn_no     integer not null,                      -- 1-based turn index within the run
  verdict     jsonb not null default '{}',           -- the VerifyResult for this turn (graded candidate vs frozen baseline)
  outcome     jsonb not null default '{}',           -- the pure turn decision: sub-objective snapshot + stall + continue/converge/stop
  created_at  timestamptz not null default now(),
  unique (job_id, turn_no)                            -- one row per (run, turn): append-only + ordering + idempotency guard
);
create index if not exists goal_titrate_turns_job_idx on goal_titrate_turns (job_id, turn_no);

-- ── knowledge_review_queue (the human-approval inbox for memory writes) ─────
create table if not exists knowledge_review_queue (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  type            text not null check (type in ('learning','relationship','rubric_improvement','harness_improvement','failed_edit_memory','promotion_candidate')),
  status          text not null default 'pending' check (status in ('pending','approved','rejected','needs_more_evidence')),
  source_kind     text not null check (source_kind in ('goal_titrate','verify','classify','harness','trace_batch','manual')),
  source_ref      text,
  source_label    text not null,
  title           text not null,
  rationale       text not null,
  payload         jsonb not null default '{}',  -- card fields (learning) | {from_ref,predicate,to} (relationship) | generic
  evidence        jsonb not null default '{}',  -- run/baseline/turn summary
  high_stakes     boolean not null default false,
  decision_reason text,
  applied_ref     text,                         -- idempotency: the card_ref/edge id the side effect produced
  created_at      timestamptz not null default now(),
  decided_at      timestamptz
);
create index if not exists knowledge_review_queue_tenant_status_idx
  on knowledge_review_queue (tenant_id, status, created_at desc);

-- ── goal_titrate_change_note (per-cycle declared "what I changed" note) ─────
-- Written by the local evolution-capture adapter (lib/evolution-local.ts).
-- `job_id`/`turn_no` match the engine's `jobs.id` / `goal_titrate_turns.turn_no`
-- BY VALUE (no FK).
create table if not exists goal_titrate_change_note (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id) on delete cascade,
  job_id                uuid not null,
  turn_no               int  not null,
  note                  text not null,                      -- the short declared change-note; NEVER prompt content
  artifact_kind         text not null default 'legacy',
  prompt_required       boolean not null default false,
  capture_source        text not null default 'legacy',
  expected_prompt_hash  text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (job_id, turn_no)
);
create index if not exists goal_titrate_change_note_job_idx on goal_titrate_change_note (tenant_id, job_id);

-- ── referee_panel_ticket (workspace-bound one-use picker tickets) ───────────
-- Persist only the SHA-256 digest (32-byte bytea), never the browser secret. TTL
-- is application-enforced; SQL only requires expires_at > created_at.
-- used_for_baseline_id is by-value (no FK). No RLS/roles/grants here (single-user
-- self-hosted; the private product's workspace-membership roles do not exist).
create table if not exists referee_panel_ticket (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  secret_digest bytea not null unique,
  status text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  confirmation_snapshot jsonb,
  establish_claimed_at timestamptz,
  used_for_baseline_id uuid,
  constraint referee_panel_ticket_sha256_digest check (
    octet_length(secret_digest) = 32
  ),
  constraint referee_panel_ticket_status_closed check (
    status in ('pending', 'confirmed', 'expired')
  ),
  constraint referee_panel_ticket_expiry_forward check (
    expires_at > created_at
  ),
  constraint referee_panel_ticket_pending_or_expired_clean check (
    status not in ('pending', 'expired')
    or (
      consumed_at is null
      and confirmation_snapshot is null
      and establish_claimed_at is null
      and used_for_baseline_id is null
    )
  ),
  constraint referee_panel_ticket_confirmed_receipt check (
    status <> 'confirmed'
    or (
      consumed_at is not null
      and confirmation_snapshot is not null
    )
  ),
  constraint referee_panel_ticket_claimed_consistent check (
    establish_claimed_at is null
    or (
      status = 'confirmed'
      and consumed_at is not null
      and confirmation_snapshot is not null
    )
  ),
  constraint referee_panel_ticket_frozen_consistent check (
    used_for_baseline_id is null
    or (
      status = 'confirmed'
      and establish_claimed_at is not null
      and consumed_at is not null
      and confirmation_snapshot is not null
    )
  )
);
create index if not exists referee_panel_ticket_tenant_created_idx
  on referee_panel_ticket (tenant_id, created_at desc);

-- Refuse the reserved __base__ tenant by slug via trigger (tenant_id FK alone
-- cannot see slug) — a manually recreated/aliased base tenant must not accept a
-- picker ticket.
create or replace function referee_panel_ticket_refuse_base()
returns trigger
language plpgsql
as $$
declare
  tenant_slug text;
begin
  select slug into tenant_slug from tenants where id = new.tenant_id;
  if tenant_slug is null then
    raise exception 'referee_panel_ticket: unknown tenant_id';
  end if;
  if tenant_slug = '__base__' then
    raise exception 'referee_panel_ticket: writes to __base__ are refused';
  end if;
  return new;
end;
$$;

drop trigger if exists referee_panel_ticket_refuse_base_trg on referee_panel_ticket;
create trigger referee_panel_ticket_refuse_base_trg
  before insert or update of tenant_id
  on referee_panel_ticket
  for each row execute function referee_panel_ticket_refuse_base();
