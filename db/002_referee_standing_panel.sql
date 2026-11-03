-- ── referee_standing_panel (a human-confirmed panel reused across baselines) ──
-- Created ONLY by the local picker's confirm handler, in the same transaction
-- that confirms the source ticket, when the human ticks "keep this panel".
-- Bounded by max_uses (1..20) and expires_at (<= 24 h after creation);
-- revocable (revoked_at). Each establish_baseline that uses it increments
-- `uses` under a row lock before any judge spend. The confirmed snapshot is the
-- same shape as referee_panel_ticket.confirmation_snapshot. Additive only: no
-- existing table or column changes, so a server built before this migration
-- keeps working against a database that has it.
create table if not exists referee_standing_panel (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  source_ticket_id uuid not null references referee_panel_ticket(id) on delete cascade,
  confirmation_snapshot jsonb not null,
  sut_family text,
  max_uses integer not null,
  uses integer not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz,
  constraint referee_standing_panel_max_uses_bounded check (max_uses between 1 and 20),
  constraint referee_standing_panel_uses_bounded check (uses >= 0 and uses <= max_uses),
  constraint referee_standing_panel_expiry_forward check (expires_at > created_at),
  constraint referee_standing_panel_expiry_bounded check (expires_at <= created_at + interval '24 hours')
);
create unique index if not exists referee_standing_panel_source_ticket_idx
  on referee_standing_panel (source_ticket_id);
create index if not exists referee_standing_panel_tenant_created_idx
  on referee_standing_panel (tenant_id, created_at desc);
