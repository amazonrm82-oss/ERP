-- =============================================================================
-- DQL-03: periodic cleanup suggestions for the manager
-- =============================================================================
-- "הצעות ניקוי תקופתיות למנהל: כפילויות חדשות, לידים בלי בעלים, רשומות בלי אף דרך קשר, וערכי בחירה שכמעט לא
-- בשימוש. מעל מסך המיזוג הקיים." (SPEC-ADDITIONS, wave 3)
--
-- * public.cleanup_suggestions(org, limit) (INVOKER: RLS decides what is counted, as the reports) answers `{allowed: false}`
--   to anyone but owners, admins and managers (canSeeCleanup; the weekly job, with no session, counts the whole business),
--   else `allowed: true` and four groups, each with its count and its first `limit` items (0..100, default 20). It reads
--   each table once under RLS into a materialized set and matches by hash joins on plain keys (review 1, measured by
--   scripts/perf/cleanup-suggestions*.sql):
--   - duplicates: a lead, contact or company made in the last 30 days that has an OLDER live record of the same type
--     with the same key, by the rules of the duplicate checks (DQL-02 / public.import_find_duplicates / CON-01
--     public.contact_channel_matches): leads (live, unconverted) and contacts by phone_e164 or email (ignoring case),
--     contacts also by their further phones and emails (contact_channels); companies by tax id, phone_e164, email or
--     name (ignoring case and outer spaces, sameCompanyName). Each new record once, with its oldest match (the record to
--     keep on the merge screen); two new records that match count once (the newer one).
--   - unowned_leads: live, unconverted leads in an open status with no owner, oldest first.
--   - no_channel: live unconverted leads and live contacts with no phone and no email (a contact's further phones and
--     emails count), newest first.
--   - rare_options: an option of an active select, multi-select or status custom field that fewer than 2 live records
--     hold, while at least 50 live records of that type have the field filled ("almost never used").
--   A switched-off module (LEAD-08) is left out: no leads with leads off, no company duplicates with companies off.
-- * app.send_cleanup_suggestions() (pg_cron crm-cleanup-suggestions, hourly at :35): once a week per business (the week
--   starts on Sunday in the business's zone; the notice is due from 09:00 on that Sunday, or, when the Sunday is a rest day
--   by the business's CAL-03 settings, from 09:00 on the next working day, app.cleanup_week_due; owner (62) א), one `system` notice to
--   every active owner and admin with the four counts only, when any is above zero. The counts are the whole business's
--   (the job runs as the table owner). Businesses take turns (the one served longest ago first), 100 a run, each in its
--   own exception block; a business that fails 3 times in a week is skipped until the next week. Writable businesses only.
--   A run stops taking new businesses once it has worked for app.cleanup_suggestion_budget() (60 seconds; judged after each
--   business, so a run always serves at least one; the rest wait for the next hour, served first).
--   The notice opens the cleanup page (entity `cleanup_suggestions`, id = the business).
-- No delete statement, no drop statement. Safe to run twice.

create or replace function public.cleanup_suggestions(p_org uuid, p_limit integer default 20)
returns jsonb
language plpgsql stable
set search_path = ''
-- JIT compiles this large query for longer than it runs (measured: 4.4 s with, 0.5 s without; off on the hosted project)
set jit = off
as $$
declare
  v_role   public.membership_role;
  v_result jsonb;
begin
  -- review 7: owners, admins and managers only (canSeeCleanup); the weekly job (no session) counts the whole business
  if auth.uid() is not null then
    v_role := app.role_in(p_org);
    if v_role is null or v_role not in ('owner', 'admin', 'manager') then
      return jsonb_build_object('allowed', false);
    end if;
  end if;

  -- Set-based (review 1): each table is read once under the caller's RLS into a materialized set, and every match is a
  -- hash join on plain text keys inside those sets. A duplicate's "oldest match" is the oldest record holding the key
  -- (distinct on per key), so no per-record index walk and no pair explosion on a common key.
  with params as (
    select greatest(0, least(coalesce(p_limit, 20), 100)) as lim,
           now() - interval '30 days' as since,
           coalesce((select m.leads_enabled from public.org_modules m where m.organization_id = p_org), true) as leads_on,
           coalesce((select m.companies_enabled from public.org_modules m where m.organization_id = p_org), true) as companies_on
  ),
  live_leads as materialized (
    select l.id, l.full_name, l.email, l.phone, l.phone_e164, lower(nullif(btrim(l.email), '')) as email_key,
           l.owner_id, l.status_id, l.custom_fields, l.created_at
      from public.leads l
     where l.organization_id = p_org and l.deleted_at is null and l.converted_at is null
       and (select leads_on from params)
  ),
  live_contacts as materialized (
    select c.id, c.full_name, c.email, c.phone, c.phone_e164, lower(nullif(btrim(c.email), '')) as email_key,
           c.custom_fields, c.created_at
      from public.contacts c
     where c.organization_id = p_org and c.deleted_at is null
  ),
  live_channels as materialized (
    select ch.contact_id, ch.kind,
           case when ch.kind = 'phone' then ch.value_e164 else lower(nullif(btrim(ch.value), '')) end as k
      from public.contact_channels ch
     where ch.organization_id = p_org
  ),
  live_companies as materialized (
    select c.id, c.name, c.phone_e164, lower(nullif(btrim(c.email), '')) as email_key,
           nullif(btrim(c.tax_id), '') as tax_key, lower(nullif(btrim(c.name), '')) as name_key,
           c.custom_fields, c.created_at
      from public.companies c
     where c.organization_id = p_org and c.deleted_at is null
       and (select companies_on from params)
  ),
  -- ---------------------------------------------------------------- duplicates
  -- leads (live, unconverted): phone_e164 or email ignoring case
  lead_keys as (
    select id, created_at, 'phone'::text as kind, phone_e164 as k from live_leads where phone_e164 is not null
    union all
    select id, created_at, 'email', email_key from live_leads where email_key is not null
  ),
  lead_first as (
    select distinct on (kind, k) kind, k, id, created_at from lead_keys order by kind, k, created_at, id
  ),
  lead_dups as (
    select distinct on (n.id) 'lead'::text as type, n.id, n.created_at, f.id as other_id, f.kind as match
      from lead_keys n
      join lead_first f on f.kind = n.kind and f.k = n.k and f.id <> n.id
     where n.created_at >= (select since from params)
     order by n.id, f.created_at, f.id, f.kind desc
  ),
  -- contacts: every primary and further phone (E.164) and email (lower case) (CON-01), each once per contact
  contact_keys as (
    select id, created_at, 'phone'::text as kind, phone_e164 as k from live_contacts where phone_e164 is not null
    union
    select id, created_at, 'email', email_key from live_contacts where email_key is not null
    union
    select c.id, c.created_at, ch.kind, ch.k
      from live_channels ch join live_contacts c on c.id = ch.contact_id
     where ch.kind in ('phone', 'email') and ch.k is not null
  ),
  contact_first as (
    select distinct on (kind, k) kind, k, id, created_at from contact_keys order by kind, k, created_at, id
  ),
  contact_dups as (
    select distinct on (n.id) 'contact'::text as type, n.id, n.created_at, f.id as other_id, f.kind as match
      from contact_keys n
      join contact_first f on f.kind = n.kind and f.k = n.k and f.id <> n.id
     where n.created_at >= (select since from params)
     order by n.id, f.created_at, f.id, f.kind desc
  ),
  -- companies: tax id, phone_e164, email, or name ignoring case and outer spaces (sameCompanyName)
  company_keys as (
    select id, created_at, 'tax_id'::text as kind, tax_key as k, 4 as pref from live_companies where tax_key is not null
    union all
    select id, created_at, 'phone', phone_e164, 3 from live_companies where phone_e164 is not null
    union all
    select id, created_at, 'email', email_key, 2 from live_companies where email_key is not null
    union all
    select id, created_at, 'name', name_key, 1 from live_companies where name_key is not null
  ),
  company_first as (
    select distinct on (kind, k) kind, k, id, created_at, pref from company_keys order by kind, k, created_at, id
  ),
  company_dups as (
    select distinct on (n.id) 'company'::text as type, n.id, n.created_at, f.id as other_id, f.kind as match
      from company_keys n
      join company_first f on f.kind = n.kind and f.k = n.k and f.id <> n.id
     where n.created_at >= (select since from params)
     order by n.id, f.created_at, f.id, f.pref desc
  ),
  dups as (
    select d.type, d.id, d.created_at, d.other_id, d.match,
           coalesce(nullif(btrim(a.full_name), ''), a.email, a.phone) as name,
           coalesce(nullif(btrim(b.full_name), ''), b.email, b.phone) as other_name
      from lead_dups d join live_leads a on a.id = d.id join live_leads b on b.id = d.other_id
    union all
    select d.type, d.id, d.created_at, d.other_id, d.match,
           coalesce(a.full_name, a.email, a.phone), coalesce(b.full_name, b.email, b.phone)
      from contact_dups d join live_contacts a on a.id = d.id join live_contacts b on b.id = d.other_id
    union all
    select d.type, d.id, d.created_at, d.other_id, d.match, a.name, b.name
      from company_dups d join live_companies a on a.id = d.id join live_companies b on b.id = d.other_id
  ),
  -- ---------------------------------------------------------------- leads with no owner
  unowned as (
    select l.id, coalesce(nullif(btrim(l.full_name), ''), l.email, l.phone) as name, l.created_at
      from live_leads l
      join public.lead_statuses s on s.organization_id = p_org and s.id = l.status_id and s.kind = 'open'
     where l.owner_id is null
  ),
  -- ---------------------------------------------------------------- no phone and no email
  no_channel as (
    select 'lead'::text as type, l.id, l.full_name as name, l.created_at
      from live_leads l
     where nullif(btrim(l.phone), '') is null and l.email_key is null
    union all
    select 'contact', c.id, c.full_name, c.created_at
      from live_contacts c
     where nullif(btrim(c.phone), '') is null and c.email_key is null
       and not exists (select 1 from live_channels ch where ch.contact_id = c.id)
  ),
  -- ---------------------------------------------------------------- select options almost never used
  fields as (
    select f.object_type, f.key, f.label, f.field_type, f.options, f.position
      from public.field_definitions f, params p
     where f.organization_id = p_org and f.is_active
       and f.field_type in ('select', 'multi_select', 'status')
       and jsonb_typeof(f.options) = 'array' and jsonb_array_length(f.options) > 0
       and (f.object_type <> 'lead' or p.leads_on)
       and (f.object_type <> 'company' or p.companies_on)
  ),
  -- the live records of the types that have such a field (deals are read only when a deal field exists)
  recs as (
    select 'lead'::text as t, l.id, l.custom_fields as cf from live_leads l
     where l.custom_fields <> '{}'::jsonb and exists (select 1 from fields f where f.object_type = 'lead')
    union all
    select 'contact', c.id, c.custom_fields from live_contacts c
     where c.custom_fields <> '{}'::jsonb and exists (select 1 from fields f where f.object_type = 'contact')
    union all
    select 'company', c.id, c.custom_fields from live_companies c
     where c.custom_fields <> '{}'::jsonb and exists (select 1 from fields f where f.object_type = 'company')
    union all
    select 'deal', d.id, d.custom_fields from public.deals d
     where exists (select 1 from fields f where f.object_type = 'deal')
       and d.organization_id = p_org and d.deleted_at is null and d.custom_fields <> '{}'::jsonb
  ),
  -- each record's value(s) of each field: one for a select or status, each item of a multi-select (one pass, linear)
  vals as (
    select f.object_type, f.key, r.id, v.value as v
      from fields f
      join recs r on r.t = f.object_type
      cross join lateral jsonb_array_elements_text(
        case jsonb_typeof(r.cf -> f.key)
          when 'array' then r.cf -> f.key
          when 'string' then jsonb_build_array(r.cf -> f.key)
          else '[]'::jsonb end) v(value)
     where v.value <> ''
  ),
  filled as (
    select object_type, key, count(distinct id) as n from vals group by object_type, key
  ),
  used as (
    -- a multi-select lists an option once per record
    select object_type, key, v, count(distinct id) as n from vals group by object_type, key, v
  ),
  rare as (
    select f.object_type, f.key, f.label, o.option, coalesce(u.n, 0) as used, fl.n as filled, f.position, o.ord
      from fields f
      join filled fl on fl.object_type = f.object_type and fl.key = f.key and fl.n >= 50
      cross join lateral jsonb_array_elements_text(f.options) with ordinality o(option, ord)
      left join used u on u.object_type = f.object_type and u.key = f.key and u.v = o.option
     where coalesce(u.n, 0) < 2
  )
  select jsonb_build_object(
    'allowed', true,
    'since', (select since from params),
    'duplicates', jsonb_build_object(
      'count', (select count(*) from dups),
      'items', coalesce((
        select jsonb_agg(jsonb_build_object('type', d.type, 'id', d.id, 'name', d.name, 'created_at', d.created_at,
                                            'other_id', d.other_id, 'other_name', d.other_name, 'match', d.match)
                         order by d.created_at desc, d.id)
          from (select * from dups order by created_at desc, id limit (select lim from params)) d), '[]'::jsonb)),
    'unowned_leads', jsonb_build_object(
      'count', (select count(*) from unowned),
      'items', coalesce((
        select jsonb_agg(jsonb_build_object('id', u.id, 'name', u.name, 'created_at', u.created_at) order by u.created_at, u.id)
          from (select * from unowned order by created_at, id limit (select lim from params)) u), '[]'::jsonb)),
    'no_channel', jsonb_build_object(
      'count', (select count(*) from no_channel),
      'leads', (select count(*) from no_channel where type = 'lead'),
      'contacts', (select count(*) from no_channel where type = 'contact'),
      'items', coalesce((
        select jsonb_agg(jsonb_build_object('type', c.type, 'id', c.id, 'name', c.name, 'created_at', c.created_at)
                         order by c.created_at desc, c.id)
          from (select * from no_channel order by created_at desc, id limit (select lim from params)) c), '[]'::jsonb)),
    'rare_options', jsonb_build_object(
      'count', (select count(*) from rare),
      'min_filled', 50,
      'max_used', 1,
      'items', coalesce((
        select jsonb_agg(jsonb_build_object('object_type', r.object_type, 'field_key', r.key, 'field_label', r.label,
                                            'option', r.option, 'used', r.used, 'filled', r.filled)
                         order by r.object_type, r.position, r.key, r.ord)
          from (select * from rare order by object_type, position, key, ord limit (select lim from params)) r), '[]'::jsonb)))
    into v_result;
  return v_result;
end;
$$;
revoke all on function public.cleanup_suggestions(uuid, integer) from public, anon;
grant execute on function public.cleanup_suggestions(uuid, integer) to authenticated;

-- ----------------------------------------------------------------------------
-- The weekly notice
-- ----------------------------------------------------------------------------
-- One row per business and week (the Sunday it starts on, in the business's zone); no grants, RLS on (schema app rule)
create table if not exists app.cleanup_suggestion_weeks (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  week_start      date not null,
  done_at         timestamptz,
  notified        boolean not null default false,
  failures        integer not null default 0,
  last_attempt_at timestamptz,
  primary key (organization_id, week_start)
);
alter table app.cleanup_suggestion_weeks enable row level security;
revoke all on app.cleanup_suggestion_weeks from public, anon, authenticated;

-- How long one run may keep taking businesses (setting app.cleanup_suggestion_budget_ms; tests lower it)
create or replace function app.cleanup_suggestion_budget() returns interval
language sql stable
set search_path = ''
as $$
  select make_interval(secs => coalesce(nullif(current_setting('app.cleanup_suggestion_budget_ms', true), '')::numeric, 60000) / 1000)
$$;
revoke all on function app.cleanup_suggestion_budget() from public, anon, authenticated;

-- the businesses one run serves (lowered by tests in their own transaction)
create or replace function app.cleanup_suggestion_limit() returns integer
language sql stable
set search_path = ''
as $$
  select coalesce(nullif(current_setting('app.cleanup_suggestion_limit', true), '')::integer, 100)
$$;
revoke all on function app.cleanup_suggestion_limit() from public, anon, authenticated;

-- The week a business's notice is due for, at its local time p_local: the week's Sunday when the notice is due by now (09:00
-- on the Sunday, or on the next working day when the Sunday is a rest day: app.add_business_days(org, sunday, 0), the CAL-03
-- rule of app.rest_day_with), else null. A send day that falls in the next week skips this week. A business whose calendar
-- cannot be read (add_business_days raises) is skipped for the run with one warning line (org and SQLSTATE), never failing
-- the others.
create or replace function app.cleanup_week_due(p_org uuid, p_local timestamp) returns date
language plpgsql stable
set search_path = ''
as $$
declare
  v_week date := p_local::date - extract(dow from p_local)::integer;
  v_day  date;
begin
  begin
    v_day := app.add_business_days(p_org, v_week, 0);
  exception when others then
    raise warning 'crm-cleanup-suggestions: the calendar of organization % cannot be read (SQLSTATE %)', p_org, sqlstate;
    return null;
  end;
  if p_local::date > v_day or (p_local::date = v_day and p_local::time >= time '09:00') then
    return v_week;
  end if;
  return null;
end;
$$;
revoke all on function app.cleanup_week_due(uuid, timestamp) from public, anon, authenticated;

-- The notice's body: the four counts only (no names, no record words: the bell shows it as stored)
create or replace function app.cleanup_notice_body(p_dups bigint, p_unowned bigint, p_no_channel bigint, p_rare bigint) returns text
language sql immutable
set search_path = ''
as $$
  select concat_ws(' · ',
    'כפילויות חדשות: ' || p_dups,
    'בלי אחראי: ' || p_unowned,
    'בלי טלפון ובלי אימייל: ' || p_no_channel,
    'ערכי בחירה שכמעט לא בשימוש: ' || p_rare)
$$;
revoke all on function app.cleanup_notice_body(bigint, bigint, bigint, bigint) from public, anon, authenticated;

create or replace function app.send_cleanup_suggestions(p_orgs uuid[] default null) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_counts jsonb;
  v_dups bigint;
  v_unowned bigint;
  v_no_channel bigint;
  v_rare bigint;
  v_sent integer := 0;
  v_started timestamptz := clock_timestamp();
begin
  for v_row in
    select o.id as organization_id, w.week_start, s.done_at, s.failures, last.served_at
      from public.organizations o
      cross join lateral (select (now() at time zone app.intake_zone(o.timezone)) as local_now) z
      cross join lateral (select app.cleanup_week_due(o.id, z.local_now) as week_start) w
      left join app.cleanup_suggestion_weeks s on s.organization_id = o.id and s.week_start = w.week_start
      left join lateral (
        select max(x.last_attempt_at) as served_at from app.cleanup_suggestion_weeks x where x.organization_id = o.id) last on true
     where (p_orgs is null or o.id = any (p_orgs))
       -- due this week (09:00 on Sunday, or on the next working day when Sunday is a rest day)
       and w.week_start is not null
       and (s.organization_id is null or (s.done_at is null and s.failures < 3))
       and app.org_writable(o.id)
     -- businesses take turns: the one served longest ago first
     order by last.served_at nulls first, o.id
     limit app.cleanup_suggestion_limit()
  loop
    begin
      v_counts := public.cleanup_suggestions(v_row.organization_id, 0);
      v_dups := coalesce((v_counts #>> '{duplicates,count}')::bigint, 0);
      v_unowned := coalesce((v_counts #>> '{unowned_leads,count}')::bigint, 0);
      v_no_channel := coalesce((v_counts #>> '{no_channel,count}')::bigint, 0);
      v_rare := coalesce((v_counts #>> '{rare_options,count}')::bigint, 0);
      if v_dups + v_unowned + v_no_channel + v_rare > 0 then
        insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
        select m.organization_id, m.user_id, 'system', 'הצעות ניקוי לשבוע הזה',
               app.cleanup_notice_body(v_dups, v_unowned, v_no_channel, v_rare),
               'cleanup_suggestions', v_row.organization_id
          from public.memberships m
         where m.organization_id = v_row.organization_id and m.status = 'active' and m.role in ('owner', 'admin');
      end if;
      insert into app.cleanup_suggestion_weeks (organization_id, week_start, done_at, notified, last_attempt_at)
      values (v_row.organization_id, v_row.week_start, now(), v_dups + v_unowned + v_no_channel + v_rare > 0, now())
      on conflict (organization_id, week_start)
        do update set done_at = excluded.done_at, notified = excluded.notified, last_attempt_at = excluded.last_attempt_at;
      v_sent := v_sent + 1;
    exception when others then
      insert into app.cleanup_suggestion_weeks (organization_id, week_start, failures, last_attempt_at)
      values (v_row.organization_id, v_row.week_start, 1, now())
      on conflict (organization_id, week_start)
        do update set failures = app.cleanup_suggestion_weeks.failures + 1, last_attempt_at = excluded.last_attempt_at;
      raise warning 'cleanup suggestions failed for organization %: %', v_row.organization_id, sqlerrm;
    end;
    -- a time budget across businesses, judged after each one, so every run serves at least one; the rest are served first
    -- next hour (they were not stamped)
    exit when clock_timestamp() - v_started > app.cleanup_suggestion_budget();
  end loop;
  return v_sent;
end;
$$;
revoke all on function app.send_cleanup_suggestions(uuid[]) from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-cleanup-suggestions', '35 * * * *', 'select app.send_cleanup_suggestions();');
  end if;
end;
$$;
