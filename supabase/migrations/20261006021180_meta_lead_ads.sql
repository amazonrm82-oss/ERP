-- =============================================================================
-- CAP-11: Facebook and Instagram Lead Ads (the Meta webhook)
-- =============================================================================
-- Owner, 4 November 2026, answer (126) א (DECISIONS.md; CLAUDE.md hard rule 5): a new use of the service key, under the
-- conditions of the approved pattern (definer functions granted to service_role only, no direct table access, rate limits,
-- database tests, an independent review before merge), plus: the GET verification answers only the challenge against a
-- secret verify token; the POST is refused before the database, without logging the body, when the X-Hub-Signature-256
-- (App Secret) is not valid; the webhook carries a lead id only and the details are fetched from the Graph API with the
-- page token, stored encrypted (INT-02); `meta_lead_id` unique per business, a repeated lead is taken once; leads that
-- arrived during a failure are fetched by a later sweep; a fake provider until the owner sets the App ID and App Secret.
--
-- What is here (the route, the signature and the Graph provider are in src/features/meta-leads/):
-- * A connection is an INT-02 row of provider 'meta_lead_ads' (external_id = the page id; the page token is its secret).
-- * public.meta_lead_forms: which Meta lead form of a page goes to whom (a fixed person or the business's distribution,
--   with a team), owners/admins only, audited. Every page has one default row (meta_form_id null, "every other form"),
--   made with the connection; a person may switch it off but not remove it. Each row owns one intake form of the new
--   kind 'meta' (forms.meta_lead_form_id), made and kept in step by app.meta_lead_forms_sync_form; a person can neither
--   make nor change one (app.guard_form, forms_meta_lock). Like widget forms, meta forms are not web forms: outside
--   max_forms, intake_form and the forms lists (the app lists kinds form and webhook only).
-- * The lead goes through public.intake_submit itself (the form's owner/team/distribution, notices, repeat inquiries,
--   leads off = a contact), with the source "פייסבוק/אינסטגרם" (lead_sources kind 'meta', made once per business by
--   app.meta_lead_source, like app.qr_lead_source: found by kind so a rename or switch-off keeps it, made again after a
--   delete).
-- * app.meta_lead_arrivals: one row per (business, Meta lead id), ids and codes only (no personal data). The row is the
--   "taken once" rule: a repeated webhook for the same lead adds nothing. A lead of the arrival is created at most once
--   (status done); leads.meta_lead_id (unique per business, partial unique index) is stamped on the lead it made.
-- * Service-role functions (the only ones the route calls):
--   public.meta_lead_receive(page, leads)  records the webhook's lead ids for the page's live connection; 100 per
--                                          call, 1,000 new ones per connection an hour (then {rate_limited}); answers
--                                          only counts and the new arrivals' ids;
--   public.meta_lead_claim(limit, ids)     leases due arrivals (fair: 20 per business a call) and answers, per arrival,
--                                          the Meta lead id, the business and connection ids and the page token's
--                                          ENVELOPE (decrypted on the server with PROVIDER_SECRETS_KEY); gives up on
--                                          arrivals older than 3 days (one `system` notice per business and day);
--   public.meta_lead_finish(arrival, lease, lead, error)
--                                          with the lead's fields: creates it through intake_submit and answers only the
--                                          outcome; with an error code: retries later (5 min, 15 min, then hourly), or
--                                          ends it (not_found), or marks the connection 'error' (token_invalid).
-- * The sweep: pg_cron `crm-meta-leads-sweep` (every 5 minutes) runs app.wake_meta_lead_sweep(), which wakes
--   POST /api/meta/leads/sweep (app.settings meta_leads_sweep_url, else derived from push_dispatch_url; secret
--   push_dispatch_secret) only while an arrival is due.
-- * public.meta_lead_summary(org): the settings screen's counts per VERIFIED connection (owners/admins); an unverified one
--   answers only {verified: false}.
-- * Page ownership (review of 8 November 2026, finding 1, page squatting; lead's choice, no new secret or service-key use):
--   anyone can store a well-shaped envelope for any page id, so a stored secret proves nothing. A page is proven only by a
--   successful lead fetch with the connection's own token: meta_lead_finish then sets integrations.verified_at (server
--   only) and ends every other connection naming the page (status 'error', code page_taken, their pending arrivals ended).
--   Until one is verified, meta_lead_receive records an arrival for every OPEN connection naming the page (verified first,
--   then the older ones); after, only for the verified one. Re-review N1: an unverified connection whose last_error_code is
--   page_taken, token_invalid or secret_unreadable is ended (app.meta_lead_connection_open): receive makes no arrival for
--   it and claim never claims for it; only a new integration_secret_set (which clears the code and goes through the
--   going-live check) opens it again. N3: secret_unreadable, and page_taken decided by another connection's verification,
--   end an unverified connection and its pending arrivals at once; token_invalid only ends the connection (its pending
--   arrivals wait, claimable again after a new token, and are given up 3 days after arrival as usual). Only a verified live
--   connection refuses another business (integration:taken, _provider_secrets.sql). The envelope's additional data binds
--   business, connection and page (src/features/integrations/crypto.ts), and claim answers the page id for it.
-- * Lock order (re-review N2), every path: an arrival row (meta_lead_finish's own, FOR UPDATE), then the page's advisory
--   lock `meta_page:<page id>`, then integration rows. integration_secret_set takes the page lock before its row; a person's
--   status update takes its row first and the page lock in app.integrations_check, so finish never WAITS for a row after
--   the page lock: its own connection's row is taken SKIP LOCKED (busy = try again in a minute), other connections' rows
--   and arrivals are changed SKIP LOCKED (a skipped connection needs nothing: once one is verified, receive sends it nothing,
--   claim leaves it out and the going-live check refuses it). No path takes the page lock before an arrival row: receive and
--   claim never take it, and claim takes arrival rows SKIP LOCKED.
--   Accepted (third review, R1): a person's reconnect (row, then the page lock in app.integrations_check) racing
--   integration_secret_set (page lock, then row) on the same connection can end in 40P01; only that business's own admins
--   can cause it, and the losing action is simply repeated.
-- * Plan key `meta_leads` (owner, 8 November 2026, answer (143) ב; values in _meta_leads_plan.sql): a new Meta connection, a
--   connection that goes live again and a form row switched on (or made on) need it, for every writer (hint
--   feature:meta_leads; definer, outsider guard first); removing, disconnecting and switching off stay allowed. Without it
--   no lead is made: claim and finish end the business's arrivals with the code feature_off (counted as not taken).
-- * Owner (145) א: the three service_role functions are pinned by md5 in tests/db/305-meta-lead-ads-pinned.test.ts; a change
--   needs a fresh independent review. Owner (147) ב: finished arrivals are removed after 12 months by the hand-pasted file
--   _meta_lead_arrivals_retention.sql.
--
-- No destructive statements and no escaped code points; every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- The lead's Meta id, unique per business
-- ----------------------------------------------------------------------------
create unique index if not exists leads_meta_lead_id_uniq on public.leads (organization_id, meta_lead_id)
  where meta_lead_id is not null;

-- ----------------------------------------------------------------------------
-- Which Meta form goes to whom
-- ----------------------------------------------------------------------------
create table if not exists public.meta_lead_forms (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  integration_id  uuid not null,
  meta_form_id    text check (meta_form_id ~ '^[0-9]{1,40}$'),
  name            text not null check (char_length(name) between 1 and 120 and name = btrim(name) and name !~ '[[:cntrl:]]'),
  assign_mode     text not null default 'round_robin' check (assign_mode in ('owner', 'round_robin')),
  owner_id        uuid,
  team_id         uuid,
  is_active       boolean not null default true,
  created_by      uuid default auth.uid() references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  constraint meta_lead_forms_integration_fk foreign key (organization_id, integration_id)
    references public.integrations (organization_id, id) on delete cascade,
  constraint meta_lead_forms_owner_fk foreign key (organization_id, owner_id)
    references public.memberships (organization_id, user_id) on delete set null (owner_id),
  constraint meta_lead_forms_team_fk foreign key (organization_id, team_id)
    references public.teams (organization_id, id) on delete set null (team_id)
);
create unique index if not exists meta_lead_forms_form_uniq
  on public.meta_lead_forms (organization_id, integration_id, coalesce(meta_form_id, ''));
create index if not exists meta_lead_forms_integration_idx on public.meta_lead_forms (organization_id, integration_id);
create index if not exists meta_lead_forms_owner_idx on public.meta_lead_forms (organization_id, owner_id) where owner_id is not null;
create index if not exists meta_lead_forms_team_idx on public.meta_lead_forms (organization_id, team_id) where team_id is not null;

alter table public.meta_lead_forms enable row level security;
revoke all on public.meta_lead_forms from anon, authenticated;
grant select, delete on public.meta_lead_forms to authenticated;
grant insert (organization_id, integration_id, meta_form_id, name, assign_mode, owner_id, team_id, is_active)
  on public.meta_lead_forms to authenticated;
grant update (name, assign_mode, owner_id, team_id, is_active) on public.meta_lead_forms to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'meta_lead_forms' and policyname = 'meta_lead_forms_select') then
    create policy meta_lead_forms_select on public.meta_lead_forms for select to authenticated
      using (app.is_admin(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'meta_lead_forms' and policyname = 'meta_lead_forms_insert') then
    create policy meta_lead_forms_insert on public.meta_lead_forms for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'meta_lead_forms' and policyname = 'meta_lead_forms_update') then
    create policy meta_lead_forms_update on public.meta_lead_forms for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'meta_lead_forms' and policyname = 'meta_lead_forms_delete') then
    create policy meta_lead_forms_delete on public.meta_lead_forms for delete to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

create or replace trigger meta_lead_forms_touch before update on public.meta_lead_forms
  for each row execute function app.touch_row();
create or replace trigger meta_lead_forms_audit after insert or update or delete on public.meta_lead_forms
  for each row execute function app.audit_row();

-- A writer's rules: the connection is a Meta one, the fixed person is an active non-viewer, 50 forms per page.
-- Definer (the count); the outsider guard first.
create or replace function app.meta_lead_forms_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and not (app.is_admin(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;
  if not exists (select 1 from public.integrations i
                  where i.organization_id = new.organization_id and i.id = new.integration_id and i.provider = 'meta_lead_ads') then
    raise exception 'not a Meta connection' using errcode = 'P0001', hint = 'meta_lead_form:integration';
  end if;
  if new.owner_id is not null and (tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id)
     and not exists (select 1 from public.memberships m
                      where m.organization_id = new.organization_id and m.user_id = new.owner_id
                        and m.status = 'active' and m.role <> 'viewer') then
    raise exception 'the leads go to an active member' using errcode = 'P0001', hint = 'meta_lead_form:owner';
  end if;
  -- CAP-11 (143) ב: a form row that takes leads needs the plan key
  if new.is_active and (tg_op = 'INSERT' or not old.is_active) and not app.org_has_feature(new.organization_id, 'meta_leads') then
    raise exception 'Meta Lead Ads are not in the plan' using errcode = 'P0001', hint = 'feature:meta_leads';
  end if;
  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtextextended('meta_lead_forms:' || new.integration_id::text, 0));
    if (select count(*) from public.meta_lead_forms f
         where f.organization_id = new.organization_id and f.integration_id = new.integration_id) >= 50 then
      raise exception 'too many forms on this page' using errcode = 'P0001', hint = 'meta_lead_forms:max';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.meta_lead_forms_check() from public, anon, authenticated;

create or replace trigger meta_lead_forms_check before insert or update on public.meta_lead_forms
  for each row execute function app.meta_lead_forms_check();

-- A person keeps the page's default row (switching it off is the way to stop it). INVOKER: current_user tells a browser
-- write; a cascade from the connection runs deeper and passes.
create or replace function app.meta_lead_forms_keep_default() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'authenticated' and pg_trigger_depth() = 1 and old.meta_form_id is null then
    raise exception 'the default form of a page stays' using errcode = 'P0001', hint = 'meta_lead_form:default';
  end if;
  return old;
end;
$$;
revoke all on function app.meta_lead_forms_keep_default() from public, anon, authenticated;

create or replace trigger meta_lead_forms_keep_default before delete on public.meta_lead_forms
  for each row execute function app.meta_lead_forms_keep_default();

-- ----------------------------------------------------------------------------
-- The source "פייסבוק/אינסטגרם", made once
-- ----------------------------------------------------------------------------
create or replace function app.meta_lead_source(p_org uuid) returns uuid
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_source uuid;
begin
  if p_org is null then
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('meta_source:' || p_org::text, 0));
  select s.id into v_source from public.lead_sources s
   where s.organization_id = p_org
     and (s.kind = 'meta' or btrim(s.name) = 'פייסבוק/אינסטגרם')
   order by s.is_active desc, (s.kind = 'meta') desc, s.created_at
   limit 1;
  if v_source is null then
    insert into public.lead_sources (organization_id, name, kind)
    values (p_org, 'פייסבוק/אינסטגרם', 'meta')
    returning id into v_source;
  end if;
  return v_source;
end;
$$;
revoke all on function app.meta_lead_source(uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Intake forms of kind 'meta'
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.forms'::regclass and conname = 'forms_kind_check'
                  and pg_get_constraintdef(oid) like '%meta%') then
    alter table public.forms drop constraint if exists forms_kind_check;
    alter table public.forms add constraint forms_kind_check check (kind in ('form', 'webhook', 'card', 'widget', 'meta'));
  end if;
end;
$$;

alter table public.forms add column if not exists meta_lead_form_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.forms'::regclass and conname = 'forms_meta_lead_form_fk') then
    alter table public.forms add constraint forms_meta_lead_form_fk foreign key (organization_id, meta_lead_form_id)
      references public.meta_lead_forms (organization_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.forms'::regclass and conname = 'forms_meta_shape') then
    alter table public.forms add constraint forms_meta_shape check ((kind = 'meta') = (meta_lead_form_id is not null));
  end if;
end;
$$;
create unique index if not exists forms_meta_lead_form_idx on public.forms (organization_id, meta_lead_form_id)
  where meta_lead_form_id is not null;

-- app.guard_form: its 020445 body plus the meta branch (a meta form is made only with its Meta form row)
create or replace function app.guard_form() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_limit numeric;
  v_count bigint;
begin
  if new.kind = 'card' then
    if coalesce(current_setting('app.card_form', true), '') <> 'on' then
      raise exception 'a card form is made with its card' using errcode = 'P0001', hint = 'form:card';
    end if;
    return new;
  end if;
  if new.kind = 'widget' then
    if coalesce(current_setting('app.widget_form', true), '') <> 'on' then
      raise exception 'a widget form is made with its widget' using errcode = 'P0001', hint = 'form:widget';
    end if;
    return new;
  end if;
  -- CAP-11 (021180): a Meta Lead Ads form is made and changed with its meta_lead_forms row
  if new.kind = 'meta' then
    if coalesce(current_setting('app.meta_form', true), '') <> 'on' then
      raise exception 'a Meta form is made with its page settings' using errcode = 'P0001', hint = 'form:meta';
    end if;
    return new;
  end if;
  -- RVW-23: a caller the write policy refuses gets RLS's plain 42501, never this business's quota
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  if new.kind = 'webhook' then
    if not app.org_has_feature(new.organization_id, 'api') then
      raise exception 'webhooks are not included in this plan' using errcode = 'P0001', hint = 'feature:api';
    end if;
    return new;
  end if;
  v_limit := app.org_limit(new.organization_id, 'max_forms');
  if v_limit is not null then
    select count(*) into v_count from public.forms f
      where f.organization_id = new.organization_id and f.kind = 'form' and f.id <> new.id;
    if v_count + 1 > v_limit then
      raise exception 'plan limit reached (max_forms = %)', v_limit using errcode = 'P0001', hint = 'limit:max_forms';
    end if;
  end if;
  return new;
end;
$$;

-- A person never changes or removes a meta form (it follows its row; the cascade from the row passes)
create or replace function app.meta_lead_form_exists(p_org uuid, p_row uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.meta_lead_forms f where f.organization_id = p_org and f.id = p_row)
$$;
revoke all on function app.meta_lead_form_exists(uuid, uuid) from public, anon;
grant execute on function app.meta_lead_form_exists(uuid, uuid) to authenticated, service_role;

create or replace function app.forms_meta_lock() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'authenticated' and old.kind = 'meta' then
    if tg_op = 'UPDATE' or app.meta_lead_form_exists(old.organization_id, old.meta_lead_form_id) then
      raise exception 'a Meta form changes with its page settings' using errcode = 'P0001', hint = 'form:meta';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke all on function app.forms_meta_lock() from public, anon, authenticated;

create or replace trigger forms_meta_lock before update or delete on public.forms
  for each row execute function app.forms_meta_lock();

-- The row's form, made and kept in step (name, owner, team, assignment, on/off)
create or replace function app.meta_lead_forms_sync_form() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform set_config('app.meta_form', 'on', true);
  if tg_op = 'INSERT' then
    insert into public.forms (organization_id, kind, name, title, owner_id, team_id, assign_mode, source_id, is_active, meta_lead_form_id)
    values (new.organization_id, 'meta', left('פייסבוק/אינסטגרם: ' || new.name, 120), 'Lead Ads',
            new.owner_id, new.team_id, new.assign_mode, app.meta_lead_source(new.organization_id), new.is_active, new.id);
  elsif new.name is distinct from old.name or new.owner_id is distinct from old.owner_id
        or new.team_id is distinct from old.team_id or new.assign_mode is distinct from old.assign_mode
        or new.is_active is distinct from old.is_active then
    update public.forms f
       set name = left('פייסבוק/אינסטגרם: ' || new.name, 120), owner_id = new.owner_id, team_id = new.team_id,
           assign_mode = new.assign_mode, is_active = new.is_active
     where f.organization_id = new.organization_id and f.meta_lead_form_id = new.id;
  end if;
  perform set_config('app.meta_form', '', true);
  return null;
end;
$$;
revoke all on function app.meta_lead_forms_sync_form() from public, anon, authenticated;

create or replace trigger meta_lead_forms_sync_form after insert or update on public.meta_lead_forms
  for each row execute function app.meta_lead_forms_sync_form();

-- CAP-11 (143) ב: connecting a page, or a page going live again, needs the plan key (every writer; the outsider guard first)
create or replace function app.integrations_meta_plan() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and not (app.is_admin(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;
  if new.provider = 'meta_lead_ads'
     and (tg_op = 'INSERT' or (new.status in ('connected', 'error') and old.status not in ('connected', 'error')))
     and not app.org_has_feature(new.organization_id, 'meta_leads') then
    raise exception 'Meta Lead Ads are not in the plan' using errcode = 'P0001', hint = 'feature:meta_leads';
  end if;
  return new;
end;
$$;
revoke all on function app.integrations_meta_plan() from public, anon, authenticated;

create or replace trigger integrations_meta_plan before insert or update on public.integrations
  for each row execute function app.integrations_meta_plan();

-- Every Meta connection gets its default row ("every other form"), to the business's distribution
create or replace function app.integrations_meta_default_form() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.provider = 'meta_lead_ads' then
    insert into public.meta_lead_forms (organization_id, integration_id, meta_form_id, name, assign_mode)
    values (new.organization_id, new.id, null, 'כל הטפסים בדף', 'round_robin')
    on conflict do nothing;
  end if;
  return null;
end;
$$;
revoke all on function app.integrations_meta_default_form() from public, anon, authenticated;

create or replace trigger integrations_meta_default_form after insert on public.integrations
  for each row execute function app.integrations_meta_default_form();

-- ----------------------------------------------------------------------------
-- Arrivals: one per (business, Meta lead id), ids and codes only
-- ----------------------------------------------------------------------------
create table if not exists app.meta_lead_arrivals (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  integration_id  uuid not null,
  meta_lead_id    text not null check (meta_lead_id ~ '^[0-9]{1,40}$'),
  meta_form_id    text check (meta_form_id ~ '^[0-9]{1,40}$'),
  status          text not null default 'pending' check (status in ('pending', 'done', 'refused', 'given_up')),
  attempts        integer not null default 0,
  next_try_at     timestamptz not null default now(),
  lease           uuid,
  lease_until     timestamptz,
  last_error_code text check (last_error_code ~ '^[a-z_]{1,40}$'),
  outcome         text check (outcome in ('accepted', 'duplicate')),
  lead_id         uuid,
  received_at     timestamptz not null default now(),
  done_at         timestamptz,
  unique (organization_id, meta_lead_id),
  constraint meta_lead_arrivals_integration_fk foreign key (organization_id, integration_id)
    references public.integrations (organization_id, id) on delete cascade,
  constraint meta_lead_arrivals_lead_fk foreign key (organization_id, lead_id)
    references public.leads (organization_id, id) on delete set null (lead_id)
);
create index if not exists meta_lead_arrivals_due_idx on app.meta_lead_arrivals (next_try_at) where status = 'pending';
create index if not exists meta_lead_arrivals_integration_idx on app.meta_lead_arrivals (organization_id, integration_id);
create index if not exists meta_lead_arrivals_lead_idx on app.meta_lead_arrivals (organization_id, lead_id) where lead_id is not null;
alter table app.meta_lead_arrivals enable row level security;
revoke all on app.meta_lead_arrivals from public, anon, authenticated, service_role;

-- New arrivals per connection in the current hour (the receive limit)
create table if not exists app.meta_lead_receive_counts (
  integration_id uuid primary key references public.integrations (id) on delete cascade,
  window_start   timestamptz not null,
  received       integer not null
);
alter table app.meta_lead_receive_counts enable row level security;
revoke all on app.meta_lead_receive_counts from public, anon, authenticated, service_role;

-- One "not taken" notice per business and day
create table if not exists app.meta_lead_notice_days (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  day             date not null,
  primary key (organization_id, day)
);
alter table app.meta_lead_notice_days enable row level security;
revoke all on app.meta_lead_notice_days from public, anon, authenticated, service_role;

create or replace function app.meta_lead_receive_limit() returns integer
language sql immutable
set search_path = ''
as $$ select 1000 $$;
revoke all on function app.meta_lead_receive_limit() from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The webhook's lead ids for a page (service_role only)
-- ----------------------------------------------------------------------------
create or replace function public.meta_lead_receive(p_page_id text, p_leads jsonb) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_int public.integrations;
  v_item jsonb;
  v_lead text;
  v_form text;
  v_count integer;
  v_total integer := 0;
  v_room integer;
  v_used integer;
  v_id uuid;
  v_ids uuid[] := '{}';
  v_limited boolean := false;
  v_found boolean := false;
  v_verified boolean;
begin
  if p_page_id is null or p_page_id !~ '^[0-9]{1,40}$' or jsonb_typeof(p_leads) is distinct from 'array'
     or jsonb_array_length(p_leads) > 100 then
    raise exception 'invalid webhook' using errcode = '22023';
  end if;
  -- review finding 1: once a connection of the page is verified, only it takes the page's leads; until then every live
  -- connection naming the page does (the first successful fetch decides, meta_lead_finish)
  v_verified := exists (select 1 from public.integrations i
                         where i.provider = 'meta_lead_ads' and i.external_id = p_page_id
                           and i.status in ('connected', 'error') and i.verified_at is not null);
  for v_int in
    select * from public.integrations i
     where i.provider = 'meta_lead_ads' and i.external_id = p_page_id
       and app.meta_lead_connection_open(i.status, i.verified_at, i.last_error_code)
       and (not v_verified or i.verified_at is not null)
     -- re-review N1: a verified connection's arrivals first, then the older connections', so the page's real holder
     -- falls inside the webhook's first fetches
     order by (i.verified_at is null), i.created_at, i.id
  loop
    v_found := true;
    -- the connection's hour: how many new arrivals it may still take
    insert into app.meta_lead_receive_counts as c (integration_id, window_start, received)
    values (v_int.id, now(), 0)
    on conflict (integration_id) do update
      set window_start = case when c.window_start > now() - interval '1 hour' then c.window_start else now() end,
          received = case when c.window_start > now() - interval '1 hour' then c.received else 0 end
    returning c.received into v_used;
    v_room := greatest(app.meta_lead_receive_limit() - v_used, 0);
    v_count := 0;

    for v_item in select e.value from jsonb_array_elements(p_leads) e loop
      v_lead := case when jsonb_typeof(v_item -> 'id') = 'string' then v_item ->> 'id' end;
      v_form := case when jsonb_typeof(v_item -> 'form_id') = 'string' then v_item ->> 'form_id' end;
      continue when v_lead is null or v_lead !~ '^[0-9]{1,40}$';
      if v_form is not null and v_form !~ '^[0-9]{1,40}$' then
        v_form := null;
      end if;
      if v_count >= v_room then
        v_limited := true;
        exit;
      end if;
      v_id := null;
      insert into app.meta_lead_arrivals (organization_id, integration_id, meta_lead_id, meta_form_id)
      values (v_int.organization_id, v_int.id, v_lead, v_form)
      on conflict (organization_id, meta_lead_id) do nothing
      returning id into v_id;
      if v_id is not null then
        v_count := v_count + 1;
        v_ids := v_ids || v_id;
      end if;
    end loop;

    update app.meta_lead_receive_counts c set received = c.received + v_count where c.integration_id = v_int.id;
    v_total := v_total + v_count;
  end loop;
  if not v_found then
    return jsonb_build_object('status', 'unknown_page');
  end if;
  return jsonb_build_object('status', case when v_limited then 'rate_limited' else 'ok' end,
                            'new', v_total, 'arrivals', to_jsonb(v_ids));
end;
$$;
revoke all on function public.meta_lead_receive(text, jsonb) from public, anon, authenticated;
grant execute on function public.meta_lead_receive(text, jsonb) to service_role;

-- ----------------------------------------------------------------------------
-- Due arrivals, leased, with the page token's envelope (service_role only)
-- ----------------------------------------------------------------------------
create or replace function public.meta_lead_claim(p_limit integer default 20, p_ids uuid[] default null) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 100));
  v_org uuid;
  v_int uuid;
  v_out jsonb;
begin
  -- give up on what waited three days; the business's owners and admins are told once a day, only about a VERIFIED
  -- connection (an unverified claim on a page learns nothing about the page's leads; review finding 1), and the notice
  -- points at the connection (review finding 8)
  for v_org, v_int in
    with gone as (
      update app.meta_lead_arrivals a
         set status = 'given_up', done_at = now(), lease = null, lease_until = null
       where a.status = 'pending' and a.received_at < now() - interval '3 days'
         and (a.lease_until is null or a.lease_until < now())
      returning a.organization_id, a.integration_id
    )
    select g.organization_id, min(g.integration_id::text)::uuid
      from gone g
      join public.integrations i on i.organization_id = g.organization_id and i.id = g.integration_id
     where i.verified_at is not null
     group by g.organization_id
  loop
    insert into app.meta_lead_notice_days (organization_id, day)
    values (v_org, (now() at time zone coalesce((select o.timezone from public.organizations o where o.id = v_org), 'Asia/Jerusalem'))::date)
    on conflict do nothing;
    if found then
      insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
      select v_org, m.user_id, 'system', 'פניות מפייסבוק/אינסטגרם לא נקלטו',
             'ניסינו במשך שלושה ימים ולא הצלחנו למשוך אותן. כדאי לבדוק את החיבור בהגדרות.', 'integration', v_int
        from public.memberships m
       where m.organization_id = v_org and m.status = 'active' and m.role in ('owner', 'admin');
    end if;
  end loop;

  -- (143) ב: a business without the plan key makes no lead; its due arrivals end, counted as not taken
  update app.meta_lead_arrivals a
     set status = 'refused', last_error_code = 'feature_off', done_at = now(), lease = null, lease_until = null
   where a.status = 'pending' and a.next_try_at <= now()
     and (a.lease_until is null or a.lease_until < now())
     and (p_ids is null or a.id = any (p_ids))
     and not app.org_has_feature(a.organization_id, 'meta_leads');

  with candidates as (
    select a.id, row_number() over (partition by a.organization_id order by a.next_try_at, a.id) as turn, a.next_try_at
      from app.meta_lead_arrivals a
      join public.integrations i on i.organization_id = a.organization_id and i.id = a.integration_id
      join app.integration_secrets s on s.integration_id = i.id
     where a.status = 'pending' and a.next_try_at <= now()
       and (a.lease_until is null or a.lease_until < now())
       and app.meta_lead_connection_open(i.status, i.verified_at, i.last_error_code)
       -- an unverified connection of a page verified elsewhere is never claimed (e.g. skipped by finish's eviction)
       and (i.verified_at is not null
            or not exists (select 1 from public.integrations o
                            where o.provider = 'meta_lead_ads' and o.external_id = i.external_id and o.id <> i.id
                              and o.status in ('connected', 'error') and o.verified_at is not null))
       and (p_ids is null or a.id = any (p_ids))
  ),
  picked as (
    select a.id from app.meta_lead_arrivals a
     where a.id in (select c.id from candidates c where c.turn <= 20 order by c.turn, c.next_try_at limit v_limit)
       and a.status = 'pending'
     for update of a skip locked
  ),
  leased as (
    update app.meta_lead_arrivals a
       set lease = gen_random_uuid(), lease_until = now() + interval '2 minutes', attempts = a.attempts + 1
      from picked p
     where a.id = p.id
    returning a.id, a.lease, a.meta_lead_id, a.organization_id, a.integration_id
  )
  -- what fetching the lead needs: the lease, the Meta lead id, and the envelope with the three values its additional data
  -- binds (business, connection, page)
  select coalesce(jsonb_agg(jsonb_build_object(
           'arrival', l.id, 'lease', l.lease, 'meta_lead_id', l.meta_lead_id,
           'organization_id', l.organization_id, 'integration_id', l.integration_id, 'page_id', i.external_id,
           'ciphertext', s.ciphertext)), '[]'::jsonb)
    into v_out
    from leased l
    join public.integrations i on i.organization_id = l.organization_id and i.id = l.integration_id
    join app.integration_secrets s on s.integration_id = l.integration_id;
  return v_out;
end;
$$;
revoke all on function public.meta_lead_claim(integer, uuid[]) from public, anon, authenticated;
grant execute on function public.meta_lead_claim(integer, uuid[]) to service_role;

-- When to try again after the n-th attempt failed
create or replace function app.meta_lead_retry_at(p_attempts integer) returns timestamptz
language sql volatile
set search_path = ''
as $$
  select now() + case when p_attempts <= 1 then interval '5 minutes'
                      when p_attempts = 2 then interval '15 minutes'
                      else interval '1 hour' end
$$;
revoke all on function app.meta_lead_retry_at(integer) from public, anon, authenticated, service_role;

-- A text of the fetched lead: a string, trimmed, without control characters, cut to its length
create or replace function app.meta_lead_text(p_value jsonb, p_max integer) returns text
language sql immutable
set search_path = ''
as $$
  select case when jsonb_typeof(p_value) = 'string'
              then nullif(btrim(left(regexp_replace(p_value #>> '{}', '[[:cntrl:]]', ' ', 'g'), p_max)), '') end
$$;
revoke all on function app.meta_lead_text(jsonb, integer) from public, anon, authenticated, service_role;

-- Whether a connection may take arrivals and be claimed (re-review N1): live, and not an unverified one that was ended
-- (page_taken, token_invalid, secret_unreadable). A new integration_secret_set clears last_error_code, so it opens again.
create or replace function app.meta_lead_connection_open(p_status text, p_verified_at timestamptz, p_error text) returns boolean
language sql immutable
set search_path = ''
as $$
  select p_status in ('connected', 'error')
     and not (p_verified_at is null and coalesce(p_error, '') in ('page_taken', 'token_invalid', 'secret_unreadable'))
$$;
revoke all on function app.meta_lead_connection_open(text, timestamptz, text) from public, anon, authenticated, service_role;

-- A connection the page is not theirs (review finding 1): it moves to 'error' with the code, and every pending arrival
-- of it ends at once with that code (counted as not taken). Definer, no grants; called only by public.meta_lead_finish,
-- which holds the page lock: rows another transaction holds are SKIPPED, never waited for (re-review N2; a skipped arrival
-- is in another finish, which ends it itself, and a skipped connection is left out by claim and receive).
create or replace function app.meta_lead_end_connection(p_org uuid, p_integration uuid, p_code text) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  update public.integrations i set status = 'error', last_error_code = p_code, last_error_at = now()
   where i.id in (select o.id from public.integrations o
                   where o.organization_id = p_org and o.id = p_integration and o.status in ('connected', 'error')
                   for update skip locked);
  update app.meta_lead_arrivals a
     set status = 'refused', last_error_code = p_code, done_at = now(), lease = null, lease_until = null
   where a.id in (select o.id from app.meta_lead_arrivals o
                   where o.organization_id = p_org and o.integration_id = p_integration and o.status = 'pending'
                   for update skip locked);
end;
$$;
revoke all on function app.meta_lead_end_connection(uuid, uuid, text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The outcome of one fetch (service_role only): the lead through intake_submit, or the error code
-- ----------------------------------------------------------------------------
create or replace function public.meta_lead_finish(p_arrival uuid, p_lease uuid, p_lead jsonb default null, p_error text default null)
returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_arr app.meta_lead_arrivals;
  v_code text;
  v_row public.meta_lead_forms;
  v_token text;
  v_form uuid;
  v_payload jsonb;
  v_platform text;
  v_result jsonb;
  v_state text;
  v_hint text;
  v_lead uuid;
  v_message text;
  v_int public.integrations;
  v_other record;
  v_page text;
begin
  select * into v_arr from app.meta_lead_arrivals a
   where a.id = p_arrival and a.lease = p_lease and a.status = 'pending' and a.lease_until >= now()
   for update;
  if not found then
    return 'stale';
  end if;

  -- (143) ב: no lead without the plan key (lost since the claim)
  if not app.org_has_feature(v_arr.organization_id, 'meta_leads') then
    update app.meta_lead_arrivals a set status = 'refused', last_error_code = 'feature_off', done_at = now(), lease = null, lease_until = null
     where a.id = v_arr.id;
    return 'refused';
  end if;

  -- re-review N2: the page lock BEFORE the connection's row (the order of integration_secret_set); the own row is taken
  -- SKIP LOCKED, so a person's status update (row first, then the page lock in its trigger) never deadlocks with this
  select i.external_id into v_page from public.integrations i
   where i.organization_id = v_arr.organization_id and i.id = v_arr.integration_id;
  perform pg_advisory_xact_lock(hashtextextended('meta_page:' || coalesce(v_page, ''), 0));
  select * into v_int from public.integrations i
   where i.organization_id = v_arr.organization_id and i.id = v_arr.integration_id
   for update skip locked;
  if not found then
    update app.meta_lead_arrivals a
       set next_try_at = now() + interval '1 minute', attempts = greatest(a.attempts - 1, 0), lease = null, lease_until = null
     where a.id = v_arr.id;
    return 'retry';
  end if;

  if p_lead is null or p_error is not null then
    v_code := case when p_error ~ '^[a-z_]{1,40}$' then p_error else 'error' end;
    -- review finding 1 and re-review N3: an UNVERIFIED connection whose envelope does not decrypt ends at once with its
    -- arrivals; one whose token does not open the lead is ended (terminal for receive and claim) but its arrivals wait,
    -- due at once, for a new token (a real owner's expired token loses nothing; the 3-day give-up still applies)
    if v_int.verified_at is null and v_code = 'secret_unreadable' then
      perform app.meta_lead_end_connection(v_arr.organization_id, v_arr.integration_id, v_code);
      return 'refused';
    end if;
    if v_int.verified_at is null and v_code = 'token_invalid' then
      update public.integrations i set status = 'error', last_error_code = v_code, last_error_at = now()
       where i.organization_id = v_arr.organization_id and i.id = v_arr.integration_id and i.status in ('connected', 'error');
      update app.meta_lead_arrivals a
         set last_error_code = v_code, next_try_at = now(), lease = null, lease_until = null
       where a.id = v_arr.id;
      return 'retry';
    end if;
    if v_code = 'not_found' then
      update app.meta_lead_arrivals a set status = 'refused', last_error_code = v_code, done_at = now(), lease = null, lease_until = null
       where a.id = v_arr.id;
      return 'refused';
    end if;
    if v_code = 'token_invalid' then
      update public.integrations i set status = 'error', last_error_code = v_code, last_error_at = now()
       where i.organization_id = v_arr.organization_id and i.id = v_arr.integration_id and i.status = 'connected';
    end if;
    update app.meta_lead_arrivals a
       set last_error_code = v_code, next_try_at = app.meta_lead_retry_at(v_arr.attempts), lease = null, lease_until = null
     where a.id = v_arr.id;
    return 'retry';
  end if;

  if jsonb_typeof(p_lead) <> 'object' then
    raise exception 'invalid lead' using errcode = '22023';
  end if;

  -- review finding 1: a successful fetch with the connection's own token is the proof that the business holds the page.
  -- The first one verifies the connection; every other connection naming the page ends (moved to 'error', its pending
  -- arrivals ended with page_taken). A connection that lost the race (the page verified elsewhere meanwhile) ends itself.
  if v_int.verified_at is null then
    -- the page lock is held since the row was read (re-review N2)
    if exists (select 1 from public.integrations o
                where o.provider = 'meta_lead_ads' and o.external_id = v_int.external_id and o.id <> v_int.id
                  and o.status in ('connected', 'error') and o.verified_at is not null) then
      perform app.meta_lead_end_connection(v_arr.organization_id, v_arr.integration_id, 'page_taken');
      return 'refused';
    end if;
    for v_other in
      select o.organization_id, o.id from public.integrations o
       where o.provider = 'meta_lead_ads' and o.external_id = v_int.external_id and o.id <> v_int.id
         and o.status in ('connected', 'error')
       order by o.id
    loop
      perform app.meta_lead_end_connection(v_other.organization_id, v_other.id, 'page_taken');
    end loop;
    update public.integrations i set verified_at = now()
     where i.organization_id = v_arr.organization_id and i.id = v_arr.integration_id;
  end if;

  -- the form row: this Meta form's, else the page's default ("every other form"), made again if it was removed
  select * into v_row from public.meta_lead_forms f
   where f.organization_id = v_arr.organization_id and f.integration_id = v_arr.integration_id
     and f.meta_form_id = v_arr.meta_form_id;
  if not found then
    select * into v_row from public.meta_lead_forms f
     where f.organization_id = v_arr.organization_id and f.integration_id = v_arr.integration_id and f.meta_form_id is null;
    if not found then
      insert into public.meta_lead_forms (organization_id, integration_id, meta_form_id, name, assign_mode)
      values (v_arr.organization_id, v_arr.integration_id, null, 'כל הטפסים בדף', 'round_robin')
      on conflict do nothing;
      select * into v_row from public.meta_lead_forms f
       where f.organization_id = v_arr.organization_id and f.integration_id = v_arr.integration_id and f.meta_form_id is null;
    end if;
  end if;
  if not v_row.is_active then
    update app.meta_lead_arrivals a set status = 'refused', last_error_code = 'form_off', done_at = now(), lease = null, lease_until = null
     where a.id = v_arr.id;
    return 'refused';
  end if;
  select f.id, f.token into v_form, v_token from public.forms f
   where f.organization_id = v_arr.organization_id and f.meta_lead_form_id = v_row.id;
  -- the source follows the business's "פייסבוק/אינסטגרם" entry (renamed, switched off or made again)
  perform set_config('app.meta_form', 'on', true);
  update public.forms f set source_id = app.meta_lead_source(v_arr.organization_id)
   where f.organization_id = v_arr.organization_id and f.id = v_form
     and f.source_id is distinct from app.meta_lead_source(v_arr.organization_id);
  perform set_config('app.meta_form', '', true);

  -- only the fields the intake knows; everything else the person answered goes into the message
  v_platform := case when p_lead ->> 'platform' = 'ig' then 'instagram' else 'facebook' end;
  v_message := app.meta_lead_text(p_lead -> 'message', 5000);
  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'full_name', app.meta_lead_text(p_lead -> 'full_name', 200),
    'phone', app.meta_lead_text(p_lead -> 'phone', 40),
    'email', app.meta_lead_text(p_lead -> 'email', 254),
    'company_name', app.meta_lead_text(p_lead -> 'company_name', 200),
    'message', v_message,
    'attribution', jsonb_strip_nulls(jsonb_build_object(
      'utm_source', v_platform, 'utm_medium', 'lead_ads',
      'utm_campaign', app.meta_lead_text(p_lead -> 'campaign', 200)))));

  begin
    v_result := public.intake_submit(v_token, 'meta', v_payload, null, 'meta-lead-ads', false);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    if v_hint = 'rate_limited' or v_state not in ('22023', 'P0002', 'P0001') then
      update app.meta_lead_arrivals a
         set last_error_code = case when v_hint = 'rate_limited' then 'rate_limited' else 'intake_error' end,
             next_try_at = app.meta_lead_retry_at(v_arr.attempts), lease = null, lease_until = null
       where a.id = v_arr.id;
      return 'retry';
    end if;
    -- bad data (no name, phone or email; an invalid email), a form switched off, a business that takes no leads
    update app.meta_lead_arrivals a
       set status = 'refused', last_error_code = case when v_state = '22023' then 'invalid' else 'not_taken' end,
           done_at = now(), lease = null, lease_until = null
     where a.id = v_arr.id;
    return 'refused';
  end;

  v_lead := case when v_result ->> 'lead_id' ~ '^[0-9a-f-]{36}$' then (v_result ->> 'lead_id')::uuid end;
  -- the lead it made (or the open lead a repeat inquiry matched) carries the Meta id, once per business
  if v_lead is not null then
    update public.leads l set meta_lead_id = v_arr.meta_lead_id
     where l.organization_id = v_arr.organization_id and l.id = v_lead and l.meta_lead_id is null
       and not exists (select 1 from public.leads o
                        where o.organization_id = v_arr.organization_id and o.meta_lead_id = v_arr.meta_lead_id);
  end if;
  update app.meta_lead_arrivals a
     set status = 'done', outcome = case when v_result ->> 'status' = 'duplicate' then 'duplicate' else 'accepted' end,
         lead_id = v_lead, done_at = now(), last_error_code = null, lease = null, lease_until = null
   where a.id = v_arr.id;
  return case when v_result ->> 'status' = 'duplicate' then 'duplicate' else 'accepted' end;
end;
$$;
revoke all on function public.meta_lead_finish(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.meta_lead_finish(uuid, uuid, jsonb, text) to service_role;

-- ----------------------------------------------------------------------------
-- The settings screen's counts (owners/admins): per connection, no ids of leads
-- ----------------------------------------------------------------------------
create or replace function public.meta_lead_summary(p_org uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if p_org is null or not app.is_admin(p_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  -- review finding 1: an unverified connection shows no counts (only that it waits for its first lead), so a claim on a
  -- page it does not hold learns nothing about that page's leads
  return coalesce((
    select jsonb_object_agg(i.id, case when i.verified_at is null then jsonb_build_object('verified', false) else jsonb_build_object(
             'verified', true,
             'pending', (select count(*) from app.meta_lead_arrivals a where a.integration_id = i.id and a.status = 'pending'),
             'given_up', (select count(*) from app.meta_lead_arrivals a where a.integration_id = i.id and a.status = 'given_up'
                                                                         and a.done_at > now() - interval '30 days'),
             'refused', (select count(*) from app.meta_lead_arrivals a where a.integration_id = i.id and a.status = 'refused'
                                                                        and a.done_at > now() - interval '30 days'),
             'done', (select count(*) from app.meta_lead_arrivals a where a.integration_id = i.id and a.status = 'done'
                                                                     and a.done_at > now() - interval '30 days'),
             'last_received_at', (select max(a.received_at) from app.meta_lead_arrivals a where a.integration_id = i.id)) end)
      from public.integrations i
     where i.organization_id = p_org and i.provider = 'meta_lead_ads'), '{}'::jsonb);
end;
$$;
revoke all on function public.meta_lead_summary(uuid) from public, anon;
grant execute on function public.meta_lead_summary(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The sweep: wake the route while an arrival is due
-- ----------------------------------------------------------------------------
create or replace function app.wake_meta_lead_sweep() returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_url text := coalesce(
    nullif((select s.value from app.settings s where s.key = 'meta_leads_sweep_url'), ''),
    replace(nullif((select s.value from app.settings s where s.key = 'push_dispatch_url'), ''), '/api/push/dispatch', '/api/meta/leads/sweep'));
  v_secret text := nullif((select s.value from app.settings s where s.key = 'push_dispatch_secret'), '');
begin
  if v_url is null or v_secret is null or not exists (select 1 from pg_extension where extname = 'pg_net') then
    return false;
  end if;
  if not exists (select 1 from app.meta_lead_arrivals a
                  where a.status = 'pending' and (a.next_try_at <= now() or a.received_at < now() - interval '3 days')) then
    return false;
  end if;
  execute 'select net.http_post(url := $1, body := ''{}''::jsonb, headers := $2)'
    using v_url, jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret);
  return true;
end;
$$;
revoke all on function app.wake_meta_lead_sweep() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-meta-leads-sweep', '*/5 * * * *', 'select app.wake_meta_lead_sweep();');
  end if;
end;
$$;
