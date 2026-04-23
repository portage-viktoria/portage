-- ============================================================
-- Portage database schema
-- Run this in Supabase SQL Editor (Project → SQL Editor → New query)
-- ============================================================

-- Portal connections: one row per HubSpot portal connected to Portage
create table public.portal_connections (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  hub_id          bigint not null,
  portal_name     text,
  portal_domain   text,
  -- Encrypted refresh token (envelope-encrypted; never store plaintext)
  refresh_token_ciphertext  text not null,
  refresh_token_iv          text not null,
  refresh_token_auth_tag    text not null,
  scopes          text[] not null default '{}',
  connected_at    timestamptz not null default now(),
  last_refreshed_at timestamptz,
  revoked_at      timestamptz,
  -- One user can connect the same portal only once (soft-unique; revoked rows allowed)
  unique (user_id, hub_id)
);

create index portal_connections_user_id_idx on public.portal_connections(user_id);
create index portal_connections_hub_id_idx on public.portal_connections(hub_id);

-- OAuth state tokens: short-lived CSRF protection for the authorization flow
-- A row is created when the user clicks "Connect HubSpot" and consumed on callback
create table public.oauth_states (
  state           text primary key,
  user_id         uuid references auth.users(id) on delete cascade,
  created_at      timestamptz not null default now(),
  -- States expire after 10 minutes; expired rows are cleaned up by a scheduled job
  expires_at      timestamptz not null default (now() + interval '10 minutes'),
  consumed_at     timestamptz
);

create index oauth_states_expires_at_idx on public.oauth_states(expires_at);

-- Audit log: every write operation to any connected portal
-- Immutable after insert; retention handled by a separate scheduled cleanup
create table public.audit_log (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users(id) on delete set null,
  hub_id          bigint,
  action          text not null,       -- e.g., "portal.connected", "page.created", "file.uploaded"
  resource_type   text,                 -- e.g., "page", "file", "module"
  resource_id     text,
  metadata        jsonb,                -- action-specific context, sanitized (no secrets)
  ip_address      inet,
  user_agent      text,
  created_at      timestamptz not null default now()
);

create index audit_log_user_id_idx on public.audit_log(user_id);
create index audit_log_hub_id_idx on public.audit_log(hub_id);
create index audit_log_created_at_idx on public.audit_log(created_at desc);
create index audit_log_action_idx on public.audit_log(action);

-- Row-level security: users can only see their own connections and audit entries
alter table public.portal_connections enable row level security;
alter table public.audit_log enable row level security;
alter table public.oauth_states enable row level security;

create policy "users see own portal connections"
  on public.portal_connections for select
  using (auth.uid() = user_id);

create policy "users see own audit log"
  on public.audit_log for select
  using (auth.uid() = user_id);

-- Writes happen only from server-side code using the service role key,
-- which bypasses RLS. So no insert/update/delete policies needed here.