-- =============================================================================
-- INT-01 / INT-03: a sync log per provider connection, a failure notice, and "test connection" with the stored token
-- =============================================================================
-- "יומן סנכרון לכל חיבור, והתראה למנהל כשחיבור נופל או כשטוקן עומד לפוג" (SPEC-ADDITIONS, wave 3).
--
-- * public.integration_events: one line per thing that happened to a connection (INT-02's public.integrations): its
--   time, a kind from a closed list and a short code. NO payload, NO token, NO lead id, NO name, NO personal data. Owners
--   and admins read it (the rule of integrations_select); no client writes: only the definers below write it.
--   Fetch outcomes are folded into one line per connection, kind, code and business day (`hits` counts them, `last_at`
--   is the latest), so a busy page writes a few lines a day, not one per lead.
-- * Kept 12 months, also after the connection is deleted (owner, 10 November 2026, answer (228) ב): `connection_id` keeps
--   the connection's id as a plain value, and `integration_id` is a composite FK `on delete set null (integration_id)`, so a
--   delete leaves the lines (ids and codes only). They are kept for support and the full export; the screen shows only live
--   connections. The deletion time is stamped on the connection's lines (`connection_deleted_at`, server only, AFTER DELETE
--   trigger integrations_events_deleted): a deleted connection's lines are removed 12 months after the DELETION, a live
--   connection's lines 12 months after their own `last_at`. pg_cron `crm-integration-events-purge` calls
--   app.purge_old_integration_events(), a wrapper that does nothing until the owner pastes _integration_events_purge.sql
--   (its delete lives there: the connector stops on a delete).
-- * Written from state changes only. CAP-11's service-role functions (meta_lead_receive / claim / finish and their helpers,
--   pinned by md5 in test 305) are NOT changed: an AFTER trigger on public.integrations logs what they and a person do to
--   the connection row, and an AFTER trigger on app.meta_lead_arrivals logs fetch outcomes, only for a VERIFIED connection
--   (CAP-11: an unverified connection sees no counts) and only when its row is not held by another transaction. Both catch
--   every error, so a log line can never fail a fetch, a token save or a person's change.
-- * Notice: when a connection moves into failure with token_invalid, page_taken or secret_unreadable, its business's active
--   owners and admins get one `system` notice, at most once per connection and business day (app.integration_notice_days).
--   The text names no page, no person and no lead.
-- * Test connection (owner, 10 November 2026, answer (227) ב, a new service-key use): public.integration_test_claim and
--   public.integration_test_finish (definer, service_role only). The server route checks the person's session first; claim
--   checks the person again, counts 5 tests per connection in 10 minutes (app.integration_tests, no IP) and answers the
--   ciphertext and page id of THIS connection only, with a 60-second lease; the server decrypts in memory and runs checkPage;
--   finish writes only `verified_at` / `last_error_code` of the connection, under CAP-11's page-ownership rule (copied from
--   public.meta_lead_finish: verifying a page ends every other connection of it with page_taken; a page verified elsewhere
--   ends this one), and one log line test_ok / test_failed:<code>.
--   A connection ended by a test because the page is verified elsewhere keeps its status ('connected' or 'error'), stays
--   unverified with last_error_code 'page_taken' (so CAP-11 neither claims nor receives for it), gets NO failure notice (the
--   person who pressed the button sees the answer), and its pending arrivals wait until meta_lead_claim gives them up after
--   3 days. Moving its status, as app.meta_lead_end_connection does, is refused by app.integrations_check (integration:taken).
-- * "A token about to expire" (owner, answer (226) ב): NOT built here. It comes with the real Graph provider, which reads the
--   token's expiry (debug_token / expires_at); see the follow-up note in src/features/meta-leads/graph/types.ts.
--
-- No destructive statements and no escaped code points; every statement is safe to run twice.

create table if not exists public.integration_events (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- the live connection; emptied when it is deleted (answer (228) ב), `connection_id` keeps its id
  integration_id  uuid,
  connection_id   uuid not null,
  provider        text not null check (provider ~ '^[a-z_]{1,40}$'),
  kind            text not null,
  code            text,
  day             date not null,
  hits            integer not null default 1 check (hits >= 1),
  created_at      timestamptz not null default now(),
  last_at         timestamptz not null default now(),
  -- when the connection was deleted (server only; the 12 months of a deleted connection's lines count from here)
  connection_deleted_at timestamptz,
  unique (organization_id, id),
  constraint integration_events_kind check (kind in (
    'created', 'connected', 'disconnected', 'token_saved', 'verified',
    'token_invalid', 'page_taken', 'secret_unreadable', 'error',
    'fetch_ok', 'fetch_failed', 'lead_refused', 'lead_given_up',
    'test_ok', 'test_failed')),
  constraint integration_events_code check (code is null or code ~ '^[a-z_]{1,40}$'),
  constraint integration_events_connection check (integration_id is null or integration_id = connection_id),
  constraint integration_events_integration_fk foreign key (organization_id, integration_id)
    references public.integrations (organization_id, id) on delete set null (integration_id)
);

comment on table public.integration_events is
  'INT-03: what happened to a provider connection (kind, short code, time); no payload, token or personal data; server writes only';

-- full index on the foreign key (test 130); the screen reads a connection's newest lines through it
create index if not exists integration_events_integration_idx
  on public.integration_events (organization_id, integration_id, last_at desc);
create index if not exists integration_events_connection_idx
  on public.integration_events (organization_id, connection_id, last_at desc);
-- the 12-month retention reads by age
create index if not exists integration_events_last_at_idx on public.integration_events (last_at) where connection_deleted_at is null;
create index if not exists integration_events_deleted_idx on public.integration_events (connection_deleted_at) where connection_deleted_at is not null;
-- fetch outcomes: one line per connection, kind, code and day
create unique index if not exists integration_events_fetch_day
  on public.integration_events (connection_id, kind, (coalesce(code, '')), day)
  where kind in ('fetch_ok', 'fetch_failed', 'lead_refused', 'lead_given_up');

alter table public.integration_events enable row level security;
revoke all on public.integration_events from anon, authenticated;
grant select on public.integration_events to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'integration_events' and policyname = 'integration_events_select') then
    -- the rule of integrations_select: owners and admins
    create policy integration_events_select on public.integration_events for select to authenticated
      using (app.is_admin(organization_id));
  end if;
end;
$$;

-- One notice per connection and business day (schema app: no grants, RLS on, no policies)
create table if not exists app.integration_notice_days (
  organization_id uuid not null,
  integration_id  uuid not null,
  day             date not null,
  primary key (integration_id, day),
  constraint integration_notice_days_integration_fk foreign key (organization_id, integration_id)
    references public.integrations (organization_id, id) on delete cascade
);
create index if not exists integration_notice_days_org_idx on app.integration_notice_days (organization_id, integration_id);
alter table app.integration_notice_days enable row level security;
revoke all on app.integration_notice_days from public, anon, authenticated, service_role;

-- The business's day now (its time zone, else Israel's)
create or replace function app.integration_event_day(p_org uuid) returns date
language sql stable security definer
set search_path = ''
as $$
  select (now() at time zone coalesce((select o.timezone from public.organizations o where o.id = p_org), 'Asia/Jerusalem'))::date
$$;
revoke all on function app.integration_event_day(uuid) from public, anon, authenticated, service_role;

-- Writes one line (a fetch outcome is folded into its day's line). Definer, no grants; never raises.
create or replace function app.integration_event_log(p_org uuid, p_integration uuid, p_kind text, p_code text) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_code text := case when p_code ~ '^[a-z_]{1,40}$' then p_code end;
  v_day date;
  v_provider text;
begin
  select i.provider into v_provider from public.integrations i where i.organization_id = p_org and i.id = p_integration;
  if not found then
    return;
  end if;
  v_day := app.integration_event_day(p_org);
  if p_kind in ('fetch_ok', 'fetch_failed', 'lead_refused', 'lead_given_up') then
    insert into public.integration_events (organization_id, integration_id, connection_id, provider, kind, code, day)
    values (p_org, p_integration, p_integration, v_provider, p_kind, v_code, v_day)
    on conflict (connection_id, kind, (coalesce(code, '')), day)
      where kind in ('fetch_ok', 'fetch_failed', 'lead_refused', 'lead_given_up')
      do update set hits = public.integration_events.hits + 1, last_at = now();
  else
    insert into public.integration_events (organization_id, integration_id, connection_id, provider, kind, code, day)
    values (p_org, p_integration, p_integration, v_provider, p_kind, v_code, v_day);
  end if;
exception when others then
  raise warning 'integration event not logged (%): %', p_integration, sqlstate;
end;
$$;
revoke all on function app.integration_event_log(uuid, uuid, text, text) from public, anon, authenticated, service_role;

-- The failure notice: once per connection and business day, to the active owners and admins. Definer, no grants; never raises.
create or replace function app.integration_failure_notice(p_org uuid, p_integration uuid, p_code text) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  insert into app.integration_notice_days (organization_id, integration_id, day)
  values (p_org, p_integration, app.integration_event_day(p_org))
  on conflict do nothing;
  if not found then
    return;
  end if;
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select p_org, m.user_id, 'system', 'חיבור לפייסבוק ולאינסטגרם הפסיק לעבוד',
         case p_code
           when 'token_invalid' then 'פייסבוק לא מקבלת את הטוקן של הדף. כדאי להחליף אותו בהגדרות > אינטגרציות.'
           when 'page_taken' then 'הדף מחובר לעסק אחר במקסוז, ולכן פניות ממנו לא ייכנסו כאן.'
           else 'לא הצלחנו לקרוא את הטוקן השמור. כדאי לשמור טוקן חדש בהגדרות > אינטגרציות.'
         end,
         'integration', p_integration
    from public.memberships m
   where m.organization_id = p_org and m.status = 'active' and m.role in ('owner', 'admin');
exception when others then
  raise warning 'integration notice not sent (%): %', p_integration, sqlstate;
end;
$$;
revoke all on function app.integration_failure_notice(uuid, uuid, text) from public, anon, authenticated, service_role;

-- The connection's own changes (a person's and the server's). Definer: it writes a server-only table; it reads only NEW/OLD.
create or replace function app.integrations_events() returns trigger
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform app.integration_event_log(new.organization_id, new.id, 'created', null);
    return null;
  end if;
  if new.secret_set_at is distinct from old.secret_set_at and new.secret_set_at is not null then
    perform app.integration_event_log(new.organization_id, new.id, 'token_saved', null);
  end if;
  if new.verified_at is not null and old.verified_at is null then
    perform app.integration_event_log(new.organization_id, new.id, 'verified', null);
  end if;
  if new.status is distinct from old.status then
    if new.status = 'connected' and new.secret_set_at is not distinct from old.secret_set_at then
      perform app.integration_event_log(new.organization_id, new.id, 'connected', null);
    elsif new.status = 'disconnected' then
      perform app.integration_event_log(new.organization_id, new.id, 'disconnected', null);
    end if;
  end if;
  -- a failure the server recorded (a new last_error_at with a code)
  if new.last_error_code is not null and new.last_error_at is distinct from old.last_error_at then
    if new.last_error_code in ('token_invalid', 'page_taken', 'secret_unreadable') then
      perform app.integration_event_log(new.organization_id, new.id, new.last_error_code, null);
      if new.last_error_code is distinct from old.last_error_code or old.status is distinct from 'error' then
        perform app.integration_failure_notice(new.organization_id, new.id, new.last_error_code);
      end if;
    else
      perform app.integration_event_log(new.organization_id, new.id, 'error', new.last_error_code);
    end if;
  end if;
  return null;
exception when others then
  raise warning 'integration events trigger failed (%): %', new.id, sqlstate;
  return null;
end;
$$;
revoke all on function app.integrations_events() from public, anon, authenticated, service_role;

create or replace trigger integrations_events after insert or update on public.integrations
  for each row execute function app.integrations_events();

-- Answer (228) ב: a deleted connection's lines are kept 12 months from the deletion, so the deletion time is stamped on them.
-- Skipped while the business itself is being deleted (its lines go with it by cascade; updating rows the same cascade then
-- deletes would fail the delete). Never fails the person's delete: an error is one warning, and the lines then fall back to
-- the age rule.
create or replace function app.integrations_events_deleted() returns trigger
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if not app.org_exists(old.organization_id) then
    return null;
  end if;
  update public.integration_events e
     set connection_deleted_at = now()
   where e.organization_id = old.organization_id and e.connection_id = old.id and e.connection_deleted_at is null;
  return null;
exception when others then
  raise warning 'integration log deletion time not stamped (%): %', old.id, sqlstate;
  return null;
end;
$$;
revoke all on function app.integrations_events_deleted() from public, anon, authenticated, service_role;

create or replace trigger integrations_events_deleted after delete on public.integrations
  for each row execute function app.integrations_events_deleted();

-- Fetch outcomes, from the arrivals' state changes (ids and codes only; nothing of the lead).
-- Left out on purpose: arrivals ended because their connection ended (page_taken, secret_unreadable): the connection's own
-- line says it, and app.meta_lead_end_connection touches other connections' rows it may not hold.
create or replace function app.meta_lead_arrivals_events() returns trigger
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_verified timestamptz;
begin
  -- Review finding 2 (lock cycle): the claim's give-up update holds arrival rows while a person's delete of the connection
  -- holds the connection row and cascades to the arrivals. The log line's foreign key needs KEY SHARE on the connection
  -- row, so it is taken here first WITHOUT waiting: a busy (or gone) connection gets no line this time. A finish already
  -- holds its own connection row, so its own lines are never skipped by this.
  select i.verified_at into v_verified
    from public.integrations i
   where i.organization_id = new.organization_id and i.id = new.integration_id
     for key share skip locked;
  if not found then
    return null;
  end if;
  -- Review finding 1: CAP-11 shows no counts to an unverified connection (a business may claim a page it does not hold),
  -- so fetch outcomes are logged only for a verified one; an unverified connection keeps its state lines only.
  if v_verified is null then
    return null;
  end if;
  if old.status = 'pending' and new.status = 'done' then
    perform app.integration_event_log(new.organization_id, new.integration_id, 'fetch_ok', null);
  elsif old.status = 'pending' and new.status = 'refused'
        and coalesce(new.last_error_code, '') not in ('page_taken', 'secret_unreadable') then
    perform app.integration_event_log(new.organization_id, new.integration_id, 'lead_refused', new.last_error_code);
  elsif old.status = 'pending' and new.status = 'given_up' then
    perform app.integration_event_log(new.organization_id, new.integration_id, 'lead_given_up', null);
  elsif new.status = 'pending' and old.lease is not null and new.lease is null
        and new.attempts >= old.attempts and new.last_error_code is not null then
    -- a fetch that failed and will be tried again (a hand-back without a try lowers attempts and is not logged)
    perform app.integration_event_log(new.organization_id, new.integration_id, 'fetch_failed', new.last_error_code);
  end if;
  return null;
exception when others then
  raise warning 'arrival events trigger failed: %', sqlstate;
  return null;
end;
$$;
revoke all on function app.meta_lead_arrivals_events() from public, anon, authenticated, service_role;

create or replace trigger meta_lead_arrivals_events after update of status, lease on app.meta_lead_arrivals
  for each row execute function app.meta_lead_arrivals_events();

-- ----------------------------------------------------------------------------
-- Test connection with the stored token (owner, 10 November 2026, answer (227) ב)
-- ----------------------------------------------------------------------------
-- One row per connection: the 10-minute window's count, and the lease of the test in flight (schema app: no grants, RLS on).
create table if not exists app.integration_tests (
  integration_id    uuid primary key,
  organization_id   uuid not null,
  window_start      timestamptz not null,
  tests             integer not null default 0 check (tests >= 0),
  lease             uuid,
  lease_until       timestamptz,
  secret_updated_at timestamptz,
  constraint integration_tests_integration_fk foreign key (organization_id, integration_id)
    references public.integrations (organization_id, id) on delete cascade
);
create index if not exists integration_tests_org_idx on app.integration_tests (organization_id, integration_id);
alter table app.integration_tests enable row level security;
revoke all on app.integration_tests from public, anon, authenticated, service_role;

create or replace function app.integration_test_limit() returns integer
language sql immutable
set search_path = ''
as $$ select 5 $$;
revoke all on function app.integration_test_limit() from public, anon, authenticated, service_role;

-- The server, after the person's session passed (an active owner or admin of the business), asks for ONE connection's
-- stored ciphertext to test it. Service role only. The person is checked again here by a plain membership read (the route
-- passes the session's own user id). Answers {lease, page_id, ciphertext} or {refused: not_found | read_only | feature |
-- closed | no_secret | rate, retry_seconds}. Nothing of another connection or business is ever answered; a refused call
-- writes nothing. Each answered test counts, 5 per connection in 10 minutes.
create or replace function public.integration_test_claim(p_org uuid, p_integration uuid, p_user uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_int public.integrations;
  v_secret app.integration_secrets;
  v_row app.integration_tests;
  v_lease uuid := gen_random_uuid();
begin
  if p_org is null or p_integration is null or p_user is null
     or not exists (select 1 from public.memberships m
                     where m.organization_id = p_org and m.user_id = p_user
                       and m.status = 'active' and m.role in ('owner', 'admin')) then
    return jsonb_build_object('refused', 'not_found');
  end if;
  select * into v_int from public.integrations i
   where i.organization_id = p_org and i.id = p_integration and i.provider = 'meta_lead_ads';
  if not found or v_int.external_id is null then
    return jsonb_build_object('refused', 'not_found');
  end if;
  if not app.org_writable(p_org) then
    return jsonb_build_object('refused', 'read_only');
  end if;
  if not app.org_has_feature(p_org, 'meta_leads') then
    return jsonb_build_object('refused', 'feature');
  end if;
  -- CAP-11's rule for a live connection: an unverified one ended by page_taken, token_invalid or secret_unreadable is
  -- tested again only after a new token
  if not app.meta_lead_connection_open(v_int.status, v_int.verified_at, v_int.last_error_code) then
    return jsonb_build_object('refused', 'closed');
  end if;
  select * into v_secret from app.integration_secrets s
   where s.organization_id = p_org and s.integration_id = v_int.id;
  if not found then
    return jsonb_build_object('refused', 'no_secret');
  end if;
  insert into app.integration_tests (integration_id, organization_id, window_start, tests)
  values (v_int.id, p_org, now(), 0)
  on conflict (integration_id) do nothing;
  select * into v_row from app.integration_tests t where t.integration_id = v_int.id for update;
  if v_row.window_start <= now() - interval '10 minutes' then
    v_row.window_start := now();
    v_row.tests := 0;
  end if;
  if v_row.tests >= app.integration_test_limit() then
    return jsonb_build_object('refused', 'rate',
      'retry_seconds', greatest(1, ceil(extract(epoch from v_row.window_start + interval '10 minutes' - now())))::integer);
  end if;
  update app.integration_tests t
     set window_start = v_row.window_start, tests = v_row.tests + 1,
         lease = v_lease, lease_until = now() + interval '60 seconds', secret_updated_at = v_secret.updated_at
   where t.integration_id = v_int.id;
  return jsonb_build_object('lease', v_lease, 'page_id', v_int.external_id, 'ciphertext', v_secret.ciphertext);
end;
$$;
revoke all on function public.integration_test_claim(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.integration_test_claim(uuid, uuid, uuid) to service_role;

-- The test's outcome (service role only, the claim's lease, once). p_result: 'ok' or the provider's code (token_invalid,
-- not_found, graph_unavailable, rate_limited, secret_unreadable; anything else is 'error'). Writes only the connection's
-- `verified_at` / `last_error_code` and one log line; on a successful test of an UNVERIFIED connection it applies CAP-11's
-- page-ownership rule exactly as public.meta_lead_finish does (copied, not changed; keep the two in step): a page verified
-- elsewhere ends this connection (last_error_code page_taken, see below), else every other connection of the page ends
-- with page_taken and this one is verified. Lock order as meta_lead_finish: the page advisory lock, then the connection row
-- FOR UPDATE SKIP LOCKED (a person's update or delete of the connection holds the row first and its trigger then takes the
-- page lock: waiting here would deadlock, so a held row answers 'busy' and the lease is kept until it runs out), then the
-- test row. Answers ok | page_taken | changed | closed | expired | busy | the code.
create or replace function public.integration_test_finish(p_org uuid, p_integration uuid, p_lease uuid, p_result text) returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_code text := case when p_result in ('ok', 'token_invalid', 'not_found', 'graph_unavailable', 'rate_limited', 'secret_unreadable')
                      then p_result else 'error' end;
  v_page text;
  v_int public.integrations;
  v_test app.integration_tests;
  v_secret timestamptz;
  v_other record;
begin
  select i.external_id into v_page from public.integrations i
   where i.organization_id = p_org and i.id = p_integration and i.provider = 'meta_lead_ads';
  if v_page is null then
    return 'expired';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('meta_page:' || v_page, 0));
  select * into v_int from public.integrations i
   where i.organization_id = p_org and i.id = p_integration
   for update skip locked;
  if not found then
    return 'busy';
  end if;
  if v_int.external_id is distinct from v_page then
    return 'expired';
  end if;
  select * into v_test from app.integration_tests t
   where t.organization_id = p_org and t.integration_id = p_integration
   for update;
  if not found or p_lease is null or v_test.lease is distinct from p_lease or v_test.lease_until < now() then
    return 'expired';
  end if;
  update app.integration_tests t set lease = null, lease_until = null where t.integration_id = p_integration;

  -- the token tested must still be the stored one, and the connection still live
  select s.updated_at into v_secret from app.integration_secrets s
   where s.organization_id = p_org and s.integration_id = p_integration;
  if v_secret is null or v_secret is distinct from v_test.secret_updated_at then
    perform app.integration_event_log(p_org, p_integration, 'test_failed', 'changed');
    return 'changed';
  end if;
  if not app.meta_lead_connection_open(v_int.status, v_int.verified_at, v_int.last_error_code) then
    perform app.integration_event_log(p_org, p_integration, 'test_failed', 'closed');
    return 'closed';
  end if;

  if v_code = 'ok' then
    if v_int.verified_at is null then
      -- the page lock is held since the row was read (CAP-11's re-review N2)
      if exists (select 1 from public.integrations o
                  where o.provider = 'meta_lead_ads' and o.external_id = v_int.external_id and o.id <> v_int.id
                    and o.status in ('connected', 'error') and o.verified_at is not null) then
        -- Not app.meta_lead_end_connection here: moving this row to 'error' while the page is verified elsewhere is refused
        -- by app.integrations_check (integration:taken, a status change goes through the going-live check). The code alone
        -- ends it for CAP-11 (app.meta_lead_connection_open is false for an unverified connection with page_taken), and it
        -- is one of the two columns this function may write. Its pending arrivals are no longer claimed and are given up
        -- after 3 days by meta_lead_claim.
        update public.integrations i set last_error_code = 'page_taken'
         where i.organization_id = p_org and i.id = p_integration;
        perform app.integration_event_log(p_org, p_integration, 'test_failed', 'page_taken');
        return 'page_taken';
      end if;
      for v_other in
        select o.organization_id, o.id from public.integrations o
         where o.provider = 'meta_lead_ads' and o.external_id = v_int.external_id and o.id <> v_int.id
           and o.status in ('connected', 'error')
         order by o.id
      loop
        perform app.meta_lead_end_connection(v_other.organization_id, v_other.id, 'page_taken');
      end loop;
      update public.integrations i
         set verified_at = now(),
             last_error_code = case when i.last_error_code in ('token_invalid', 'secret_unreadable') then null
                                    else i.last_error_code end
       where i.organization_id = p_org and i.id = p_integration;
    elsif v_int.last_error_code in ('token_invalid', 'secret_unreadable') then
      -- the stored token works again
      update public.integrations i set last_error_code = null
       where i.organization_id = p_org and i.id = p_integration;
    end if;
    perform app.integration_event_log(p_org, p_integration, 'test_ok', null);
    return 'ok';
  end if;

  if v_code in ('token_invalid', 'secret_unreadable') then
    update public.integrations i set last_error_code = v_code
     where i.organization_id = p_org and i.id = p_integration and i.last_error_code is distinct from v_code;
  end if;
  perform app.integration_event_log(p_org, p_integration, 'test_failed', v_code);
  return v_code;
end;
$$;
revoke all on function public.integration_test_finish(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.integration_test_finish(uuid, uuid, uuid, text) to service_role;

-- ----------------------------------------------------------------------------
-- Retention (answer (228) ב): lines older than 12 months are removed by app.integration_events_purge_rows(limit), which
-- lives in _integration_events_purge.sql (pasted by hand: it deletes). Until it exists this wrapper does nothing, so applying
-- this file alone never fails and the nightly job is harmless.
-- ----------------------------------------------------------------------------
create or replace function app.purge_old_integration_events() returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if to_regprocedure('app.integration_events_purge_rows(integer)') is null then
    return 0;
  end if;
  execute 'select app.integration_events_purge_rows($1)' into v_count using 10000;
  return coalesce(v_count, 0);
end;
$$;
revoke all on function app.purge_old_integration_events() from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-integration-events-purge', '41 2 * * *', 'select app.purge_old_integration_events();');
  end if;
end;
$$;
