-- =============================================================================
-- DOC-16: a sync log for the business's invoice provider connection, and a notice when the connection fails
-- =============================================================================
-- "יומן סנכרון לכל חיבור: הצלחות, כישלונות וניסיון חוזר. התראה למנהל כשחיבור נופל" (SPEC-ADDITIONS, DOC-16).
--
-- INT-03's design (migrations _integration_events.sql / _integration_events_purge.sql) for the DOC-05 connection
-- (public.invoice_provider_settings, one row per business). A table of its own, not public.integration_events: that table
-- is keyed on an INT-02 connection row (`integration_id` / `connection_id`, a composite FK to public.integrations, and a
-- check that they are equal), and the invoice provider has no such row; joining it would need a nullable connection, a new
-- kind list and changes to its pinned INT-03 functions.
--
-- * public.invoice_provider_events: one line per business, provider, kind, code and business day; `hits` counts how often it
--   happened that day and `last_at` is the latest. Ids and codes only: NO payload, NO customer, NO document number, NO
--   amount, NO person. Owners and admins read it (the rule of integration_events_select); no client writes it.
--   Kinds (closed list = INVOICE_PROVIDER_EVENT_KINDS in src/features/invoicing/provider-events.ts):
--     connected / disconnected      the connection's state (public.invoice_provider_connect / _disconnect)
--     check_ok / check_failed       "test the connection" (public.invoice_provider_check_recorded)
--     issued                        a document was issued and recorded (code: the document type)
--     retry                         the provider did not answer and the queue tries again (code: the provider's code)
--     failed                        the provider refused, nothing was issued (code)
--     unrecorded                    ended without a record; may exist at the provider (code)
--     closed / checked              a person closed a request, or marked one checked at the provider
--     stale                         a request waited more than 24 hours
-- * Written from state changes only, by AFTER triggers on public.invoice_provider_settings and app.invoice_issue_requests.
--   The worker's service-role functions (public.invoice_issue_claim / invoice_issue_record, pinned by md5 in test 381) and
--   the three settings functions are NOT changed. Both triggers catch every error, so a log line never fails an issue, a
--   record of the provider's answer or a person's change.
-- * "The connection fell" (app.invoice_provider_connection_failure): the provider refused the business's key (an `auth`
--   failure: the worker sends its code as `auth:<code>`, also `customer_auth:` / `product_auth:` from the DOC-13 upserts),
--   every try of a request could not reach the provider (a request ended `retries_spent` after `unreachable` / `timeout`),
--   or a connection check failed. A single document the provider refused (its details) is a `failed` line, not a fall.
--   Then the business's active owners and admins get ONE `system` notice, at most once per business day
--   (app.invoice_provider_notice_days); the text names no customer, document or person.
-- * Kept 12 months (INT-03's rule): pg_cron `crm-invoice-provider-events-purge` calls app.purge_old_invoice_provider_events(),
--   which does nothing until the owner pastes _invoice_provider_events_purge.sql (its delete lives there: the connector stops
--   on a delete).
--
-- No destructive statements and no escaped code points; every statement is safe to run twice.

create table if not exists public.invoice_provider_events (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  provider        text not null check (provider ~ '^[a-z][a-z0-9_]{1,39}$'),
  kind            text not null,
  code            text,
  day             date not null,
  hits            integer not null default 1 check (hits >= 1),
  created_at      timestamptz not null default now(),
  last_at         timestamptz not null default now(),
  unique (organization_id, id),
  constraint invoice_provider_events_kind check (kind in (
    'connected', 'disconnected', 'check_ok', 'check_failed',
    'issued', 'retry', 'failed', 'unrecorded', 'closed', 'checked', 'stale')),
  -- the shape of app.invoice_issue_requests.error_code (the record's own filter of the provider's code)
  constraint invoice_provider_events_code check (code is null or code ~ '^[A-Za-z0-9_.:-]{1,64}$')
);

comment on table public.invoice_provider_events is
  'DOC-16: what happened to the business''s invoice provider connection (kind, short code, day, count); no payload or personal data; server writes only';

-- one line per business, provider, kind, code and day
create unique index if not exists invoice_provider_events_day
  on public.invoice_provider_events (organization_id, provider, kind, (coalesce(code, '')), day);
-- the settings page reads the newest lines
create index if not exists invoice_provider_events_org_idx on public.invoice_provider_events (organization_id, last_at desc);
-- the 12-month retention reads by age
create index if not exists invoice_provider_events_last_at_idx on public.invoice_provider_events (last_at);

alter table public.invoice_provider_events enable row level security;
revoke all on public.invoice_provider_events from anon, authenticated;
grant select on public.invoice_provider_events to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'invoice_provider_events'
                   and policyname = 'invoice_provider_events_select') then
    -- owners and admins (as integration_events)
    create policy invoice_provider_events_select on public.invoice_provider_events for select to authenticated
      using (app.is_admin(organization_id));
  end if;
end;
$$;

-- One notice per business and business day (schema app: no grants, RLS on, no policies)
create table if not exists app.invoice_provider_notice_days (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  day             date not null,
  primary key (organization_id, day)
);
alter table app.invoice_provider_notice_days enable row level security;
revoke all on app.invoice_provider_notice_days from public, anon, authenticated, service_role;

-- Writes (folds) one line. Definer, no grants; never raises. The day is the business's (app.integration_event_day, INT-03).
create or replace function app.invoice_provider_event_log(p_org uuid, p_provider text, p_kind text, p_code text) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_code text := case when p_code ~ '^[A-Za-z0-9_.:-]{1,64}$' then p_code end;
begin
  if p_org is null or p_provider is null or p_provider !~ '^[a-z][a-z0-9_]{1,39}$' then
    return;
  end if;
  insert into public.invoice_provider_events (organization_id, provider, kind, code, day)
  values (p_org, p_provider, p_kind, v_code, app.integration_event_day(p_org))
  on conflict (organization_id, provider, kind, (coalesce(code, '')), day)
    do update set hits = public.invoice_provider_events.hits + 1, last_at = now();
exception when others then
  raise warning 'invoice provider event not logged (%): %', p_org, sqlstate;
end;
$$;
revoke all on function app.invoice_provider_event_log(uuid, text, text, text) from public, anon, authenticated, service_role;

-- Is a request's code a failure of the connection itself (the key refused), rather than of one document?
-- = isConnectionAuthCode() in src/features/invoicing/provider-events.ts
create or replace function app.invoice_provider_auth_code(p_code text) returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce(p_code ~ '^((customer|product)_)?auth(:|$)', false)
$$;
revoke all on function app.invoice_provider_auth_code(text) from public, anon, authenticated, service_role;

-- A code that says the provider could not be reached (the worker's timeout or a call that threw)
-- = isUnreachableCode() in src/features/invoicing/provider-events.ts
create or replace function app.invoice_provider_unreachable_code(p_code text) returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce(p_code ~ '^((customer|product)_)?(unreachable|timeout)$', false)
$$;
revoke all on function app.invoice_provider_unreachable_code(text) from public, anon, authenticated, service_role;

-- The notice: once per business and business day, to the active owners and admins. Definer, no grants; never raises.
-- p_reason: auth | unreachable | check.
create or replace function app.invoice_provider_connection_failure(p_org uuid, p_reason text) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  insert into app.invoice_provider_notice_days (organization_id, day)
  values (p_org, app.integration_event_day(p_org))
  on conflict do nothing;
  if not found then
    return;
  end if;
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select p_org, m.user_id, 'system', 'החיבור לספק החשבוניות הפסיק לעבוד',
         case p_reason
           when 'auth' then 'הספק לא מקבל את פרטי החיבור של העסק, ולכן לא ניתן להפיק דרכו מסמכים. '
                            || 'כדאי לבדוק את החשבון אצל הספק ולחבר מחדש בהגדרות > ספק חשבוניות.'
           when 'unreachable' then 'לא הצלחנו להגיע לספק החשבוניות בכל הניסיונות של בקשת הפקה. '
                                   || 'כדאי לבדוק את החיבור בהגדרות > ספק חשבוניות, ולבדוק אצל הספק אם המסמך הופק.'
           else 'בדיקת החיבור לספק החשבוניות נכשלה. כדאי לבדוק את החשבון אצל הספק ולנסות שוב בהגדרות > ספק חשבוניות.'
         end,
         'invoice_provider', p_org
    from public.memberships m
   where m.organization_id = p_org and m.status = 'active' and m.role in ('owner', 'admin');
exception when others then
  raise warning 'invoice provider notice not sent (%): %', p_org, sqlstate;
end;
$$;
revoke all on function app.invoice_provider_connection_failure(uuid, text) from public, anon, authenticated, service_role;

-- The connection row's own changes (a person's connect, disconnect and check). Definer: it writes a server-only table and
-- reads only NEW/OLD. A defaults save (default_doc_type, locale, provider_sends_email) writes nothing.
create or replace function app.invoice_provider_settings_events() returns trigger
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_connected boolean;
begin
  if tg_op = 'INSERT' then
    if new.status = 'connected' then
      perform app.invoice_provider_event_log(new.organization_id, new.provider, 'connected', null);
    end if;
    return null;
  end if;
  v_connected := new.status = 'connected'
                 and (old.status is distinct from 'connected' or new.connected_at is distinct from old.connected_at);
  if v_connected then
    perform app.invoice_provider_event_log(new.organization_id, new.provider, 'connected', null);
  elsif new.status = 'disconnected' and old.status = 'connected' then
    perform app.invoice_provider_event_log(new.organization_id, coalesce(new.provider, old.provider), 'disconnected', null);
  elsif new.last_check_at is not null and new.last_check_at is distinct from old.last_check_at then
    -- a check of its own (connecting records its passing check with the connection, logged as `connected` above)
    if new.last_check_ok then
      perform app.invoice_provider_event_log(new.organization_id, new.provider, 'check_ok', null);
    else
      perform app.invoice_provider_event_log(new.organization_id, new.provider, 'check_failed', null);
      perform app.invoice_provider_connection_failure(new.organization_id, 'check');
    end if;
  end if;
  return null;
exception when others then
  raise warning 'invoice provider settings events trigger failed (%): %', new.organization_id, sqlstate;
  return null;
end;
$$;
revoke all on function app.invoice_provider_settings_events() from public, anon, authenticated, service_role;

create or replace trigger invoice_provider_settings_events after insert or update on public.invoice_provider_settings
  for each row execute function app.invoice_provider_settings_events();

-- The requests' outcomes (ids and codes only; nothing of the customer or the document). Every write of a request's status or
-- error_code is one of DOC-07's: the record's retry (pending stays pending with the provider's code), its ends (issued,
-- failed, unrecorded), a person's close or check, and the hourly stale mark. A credit request (DOC-14) is the same request.
create or replace function app.invoice_issue_requests_events() returns trigger
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_type text;
begin
  if new.status = 'pending' and old.status = 'pending' then
    if new.error_code is not null then
      perform app.invoice_provider_event_log(new.organization_id, new.provider, 'retry', new.error_code);
      if app.invoice_provider_auth_code(new.error_code) then
        perform app.invoice_provider_connection_failure(new.organization_id, 'auth');
      end if;
    end if;
    return null;
  end if;
  if new.status is not distinct from old.status and new.error_code is not distinct from old.error_code then
    return null;
  end if;
  if new.status = 'issued' then
    v_type := new.payload ->> 'doc_type';
    perform app.invoice_provider_event_log(new.organization_id, new.provider, 'issued',
                                           case when v_type ~ '^[a-z_]{1,40}$' then v_type end);
  elsif new.status = 'failed' then
    perform app.invoice_provider_event_log(new.organization_id, new.provider, 'failed', new.error_code);
  elsif new.status = 'stale' then
    perform app.invoice_provider_event_log(new.organization_id, new.provider, 'stale', null);
  elsif new.status = 'unrecorded' then
    if new.error_code = 'closed' then
      perform app.invoice_provider_event_log(new.organization_id, new.provider, 'closed', null);
    elsif new.error_code = 'checked' then
      perform app.invoice_provider_event_log(new.organization_id, new.provider, 'checked', null);
    else
      perform app.invoice_provider_event_log(new.organization_id, new.provider, 'unrecorded', new.error_code);
    end if;
  else
    return null;
  end if;
  -- the connection itself fell: its key was refused, or every try of this request could not reach the provider
  if new.status in ('failed', 'unrecorded') then
    if app.invoice_provider_auth_code(new.error_code) then
      perform app.invoice_provider_connection_failure(new.organization_id, 'auth');
    elsif new.error_code = 'retries_spent' and old.status = 'pending' and app.invoice_provider_unreachable_code(old.error_code) then
      perform app.invoice_provider_connection_failure(new.organization_id, 'unreachable');
    end if;
  end if;
  return null;
exception when others then
  raise warning 'invoice issue request events trigger failed: %', sqlstate;
  return null;
end;
$$;
revoke all on function app.invoice_issue_requests_events() from public, anon, authenticated, service_role;

create or replace trigger invoice_issue_requests_events after update of status, error_code on app.invoice_issue_requests
  for each row execute function app.invoice_issue_requests_events();

-- ----------------------------------------------------------------------------
-- Retention: lines older than 12 months are removed by app.invoice_provider_events_purge_rows(limit), which lives in
-- _invoice_provider_events_purge.sql (pasted by hand: it deletes). Until it exists this wrapper does nothing.
-- ----------------------------------------------------------------------------
create or replace function app.purge_old_invoice_provider_events() returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if to_regprocedure('app.invoice_provider_events_purge_rows(integer)') is null then
    return 0;
  end if;
  execute 'select app.invoice_provider_events_purge_rows($1)' into v_count using 10000;
  return coalesce(v_count, 0);
end;
$$;
revoke all on function app.purge_old_invoice_provider_events() from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-invoice-provider-events-purge', '39 2 * * *', 'select app.purge_old_invoice_provider_events();');
  end if;
end;
$$;
