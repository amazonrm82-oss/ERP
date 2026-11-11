-- =============================================================================
-- MNY-04: anomaly alerts
-- =============================================================================
-- "התראה על חריגה: ירידה חדה בלידים ממקור קבוע, נציג שלא עדכן רשומות כמה ימים, טופס שהפסיק לקבל פניות, וקמפיין שהעלות
-- לליד שלו קפצה" (SPEC-ADDITIONS, wave 3). Owner (273): every plan, no plan key. Spec 22.9: a sharp drop is 50% below the
-- average of the four weeks before.
--
-- * app.send_anomaly_alerts(orgs, now) (pg_cron crm-anomaly-alerts, hourly at :47): once a business day (its local date), from
--   08:00 in the business's zone, for writable businesses only, it looks for four kinds of anomaly and tells every active
--   owner and admin with one `system` notice per kind, counts only (no source, form, campaign or person named; the notice
--   opens the report or settings page where the business sees which). The counts are the whole business's (the job runs as
--   the table owner, as DQL-03's weekly notice). A source, a person or a form is told at most once a week (the week starts
--   on Sunday in the business's zone); a campaign key is told once per month and key, whatever the week
--   (app.anomaly_alerts_sent). A notice counts only the targets not told yet, and none is sent when there are none; when
--   targets of the same kind were already told this week, it says "נוסף" / "נוספים". Businesses take turns (the one served
--   longest ago first), app.anomaly_alert_limit() (100) a run, each in its own exception block; a business that fails 3
--   times in a day is skipped until the next day. A run stops taking new businesses once it has worked for
--   app.anomaly_alert_budget() (60 seconds, judged after each business, so a run always serves at least one).
--   Thresholds (lead's interim choices; "today" is the business's local date, every day boundary in its zone):
--   - Rest days (CAL-03, app.org_rest_day): lead_drop and quiet_form are skipped for the day when the last 7 days hold fewer
--     working days of the business than the fullest of the 4 weeks before (a holiday week is not compared with normal ones).
--   - lead_drop (only while leads are on, LEAD-08): an active lead source whose live, not imported, not sample leads of the
--     4 weeks before the last 7 days (days -35..-8) are at least 20 and fall in each of those 4 weeks ("a regular source"),
--     while the last 7 days (-7..-1) brought fewer than half of their weekly average (recent * 8 < the 4 weeks' total).
--   - idle_rep: an active full-seat member or manager (not owners or admins), a member for more than 14 days before the
--     window, who made at least 5 changes in the 30 days before the window and none in it. The window is the person's own
--     last 3 working days before today (app.anomaly_member_works: a business working day, CAL-03, on which the person is not
--     on leave and their CAP-09 hours, profiles.working_hours, else the business's, cover some time, asked through
--     app.member_in_hours). A person whose window holds a time the business was not writable (a status change of the
--     business since the window began from or to a status app.org_writable refuses, i.e. not trial, active or past_due;
--     or a BIL-09 suspension overlapping it) is skipped. A change is an audited write by
--     the person (audit_log.actor_id) on leads, contacts, companies, deals, tasks, meetings, quotes, orders, payments,
--     accounting documents or files (so payments and documents they recorded and files they uploaded count), an activity
--     they logged (activities.created_by), or a message they queued from a record card or an automation button
--     (app.jobs payload reply_to_user_id, sent_by_user_id or pressed_by_user_id).
--   - quiet_form: an active web form or webhook (kinds the intake settings list: form, webhook) made more than 35 days ago
--     that took at least 4 inquiries that were not spam in days -35..-8, in at least 3 of those 4 weeks, and none that was
--     not spam in the last 7 days.
--   - campaign_jump (only with the plan key campaign_costs and leads on): a SEG-03 cost key (source and/or campaign, as
--     report_campaign_roi groups them) with a cost in last month, a cost and at least one lead in each of the 3 months before
--     and at least 10 leads in those 3 months together, whose cost per lead last month was at least double the 3 months'
--     (their costs over their leads), or whose last month brought no lead at all. Costs before VAT (report_campaign_roi's
--     rule). Leads are live leads by created_at with that source and/or campaign (ignoring case and outer spaces), and,
--     unlike report_campaign_roi, imported and sample leads are left out (as lead_drop), so an import does not hide a jump.
--     The recipients are owners and admins, who may always see costs (app.can_view_costs by role).
-- * New index activities_org_created_idx (organization_id, created_at) for the idle_rep read. The message jobs are read
--   through their existing partial sender indexes. No new index on audit_log (organization_id, actor_id, created_at): it
--   would be built without `concurrently` (apply_migration runs in a transaction), locking every audited write of every
--   business while it builds over the whole audit table; the per-person read uses audit_log_org_time_idx over the
--   business's last 33 days instead. The lead may add it in its own migration after checking the table's size on hosted.
-- Follow-ups: app.anomaly_alerts_sent and app.anomaly_alert_days keep their rows (removing them needs a hand-pasted delete).
-- No delete statement, no drop statement. Safe to run twice.

create table if not exists app.anomaly_alert_days (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  day             date not null,
  done_at         timestamptz,
  failures        integer not null default 0,
  last_attempt_at timestamptz,
  primary key (organization_id, day)
);
alter table app.anomaly_alert_days enable row level security;
revoke all on app.anomaly_alert_days from public, anon, authenticated;

-- One row per told target. week_start is the week's Sunday, except for campaign_jump, whose key already names its month:
-- it is stored with the fixed day 1970-01-04, so a key is told once whatever the week.
create table if not exists app.anomaly_alerts_sent (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  kind            text not null check (kind in ('lead_drop', 'idle_rep', 'quiet_form', 'campaign_jump')),
  target_key      text not null check (char_length(target_key) between 1 and 300),
  week_start      date not null,
  sent_at         timestamptz not null default now(),
  primary key (organization_id, kind, target_key, week_start)
);
alter table app.anomaly_alerts_sent enable row level security;
revoke all on app.anomaly_alerts_sent from public, anon, authenticated;

create index if not exists activities_org_created_idx on public.activities (organization_id, created_at);

-- the businesses one run serves (lowered by tests in their own transaction)
create or replace function app.anomaly_alert_limit() returns integer
language sql stable
set search_path = ''
as $$
  select coalesce(nullif(current_setting('app.anomaly_alert_limit', true), '')::integer, 100)
$$;
revoke all on function app.anomaly_alert_limit() from public, anon, authenticated;

-- how long one run may keep taking businesses (setting app.anomaly_alert_budget_ms; tests lower it)
create or replace function app.anomaly_alert_budget() returns interval
language sql stable
set search_path = ''
as $$
  select make_interval(secs => coalesce(nullif(current_setting('app.anomaly_alert_budget_ms', true), '')::numeric, 60000) / 1000)
$$;
revoke all on function app.anomaly_alert_budget() from public, anon, authenticated;

-- The start of a local day in the zone, as a time (stable: it reads the time zone rules)
create or replace function app.anomaly_day_start(p_day date, p_zone text) returns timestamptz
language sql stable
set search_path = ''
as $$
  select (p_day::timestamp) at time zone p_zone
$$;
revoke all on function app.anomaly_day_start(date, text) from public, anon, authenticated;

-- The business's working days (CAL-03) from p_from to p_to, both included
create or replace function app.anomaly_working_days(p_org uuid, p_from date, p_to date) returns integer
language sql stable security definer
set search_path = ''
as $$
  select count(*)::integer
    from generate_series(p_from, p_to, interval '1 day') d
   where not app.org_rest_day(p_org, d::date)
$$;
revoke all on function app.anomaly_working_days(uuid, date, date) from public, anon, authenticated, service_role;

-- Whether the last 7 days hold as many working days as the fullest of the 4 weeks before (days -35..-8)
create or replace function app.anomaly_full_week(p_org uuid, p_today date) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select app.anomaly_working_days(p_org, p_today - 7, p_today - 1)
         >= (select max(app.anomaly_working_days(p_org, p_today - 35 + 7 * w, p_today - 29 + 7 * w)) from generate_series(0, 3) w)
$$;
revoke all on function app.anomaly_full_week(uuid, date) from public, anon, authenticated, service_role;

-- Whether a day is one of the person's working days: a business working day (CAL-03) on which app.member_in_hours (CAP-09,
-- leave included) holds at the start of one of the person's ranges that day (their own hours, else the business's), or at
-- noon when neither has hours.
create or replace function app.anomaly_member_works(p_org uuid, p_user uuid, p_day date, p_org_zone text) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_hours jsonb;
  v_zone text;
  v_day_hours jsonb;
  v_range jsonb;
begin
  if app.org_rest_day(p_org, p_day) then
    return false;
  end if;
  select p.working_hours, case when p.timezone is null then null else app.intake_zone(p.timezone) end
    into v_hours, v_zone
    from public.profiles p where p.id = p_user;
  v_zone := coalesce(v_zone, p_org_zone);
  if v_hours is null then
    select c.working_hours into v_hours from public.org_calendar_settings c where c.organization_id = p_org;
    if v_hours is not null then
      v_zone := p_org_zone;
    end if;
  end if;
  if v_hours is null then
    return app.member_in_hours(p_org, p_user, app.anomaly_day_start(p_day, v_zone) + interval '12 hours');
  end if;
  v_day_hours := v_hours -> (array['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'])[extract(dow from p_day)::int + 1];
  if v_day_hours is null then
    return false;
  end if;
  for v_range in
    select r.value from jsonb_array_elements(case when jsonb_typeof(v_day_hours) = 'array' then v_day_hours
                                                  else jsonb_build_array(v_day_hours) end) r
  loop
    if app.member_in_hours(p_org, p_user, (p_day + (v_range ->> 'start')::time) at time zone v_zone) then
      return true;
    end if;
  end loop;
  return false;
end;
$$;
revoke all on function app.anomaly_member_works(uuid, uuid, date, text) from public, anon, authenticated, service_role;

-- A person's changes from p_from (included) to p_to (excluded), counted up to p_cap (see the header for what counts)
-- The message jobs are read through their partial sender indexes (jobs_record_email_sender_idx, jobs_record_sms_sender_idx,
-- jobs_record_sms_presser_idx): each condition repeats the index's own predicate (kind and payload ? key) and its key.
create or replace function app.anomaly_person_changes(p_org uuid, p_user uuid, p_from timestamptz, p_to timestamptz, p_cap integer)
returns integer
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if p_cap <= 1 then
    -- is there any change at all: stop at the first one found
    return case when exists (select 1
                               from public.audit_log a
                              where a.organization_id = p_org
                                and a.created_at >= p_from and a.created_at < p_to
                                and a.actor_id = p_user
                                and a.entity_type in ('leads', 'contacts', 'companies', 'deals', 'tasks', 'meetings', 'quotes',
                                                      'orders', 'payments', 'accounting_documents', 'files'))
                  or exists (select 1
                               from public.activities x
                              where x.organization_id = p_org
                                and x.created_at >= p_from and x.created_at < p_to
                                and x.created_by = p_user)
                  or exists (select 1 from app.jobs j
                 where j.organization_id = p_org and j.kind = 'message.send' and j.payload ? 'reply_to_user_id'
                   and (j.payload ->> 'reply_to_user_id') = p_user::text
                   and j.created_at >= p_from and j.created_at < p_to)
                  or exists (select 1 from app.jobs j
                 where j.organization_id = p_org and j.kind = 'message.send' and j.payload ? 'sent_by_user_id'
                   and (j.payload ->> 'sent_by_user_id') = p_user::text
                   and j.created_at >= p_from and j.created_at < p_to)
                  or exists (select 1 from app.jobs j
                 where j.organization_id = p_org and j.kind = 'message.send' and j.payload ? 'pressed_by_user_id'
                   and (j.payload ->> 'pressed_by_user_id') = p_user::text
                   and j.created_at >= p_from and j.created_at < p_to)
                then 1 else 0 end;
  end if;
  select count(*)::integer into v_n from (
    (select 1
       from public.audit_log a
      where a.organization_id = p_org
        and a.created_at >= p_from and a.created_at < p_to
        and a.actor_id = p_user
        and a.entity_type in ('leads', 'contacts', 'companies', 'deals', 'tasks', 'meetings', 'quotes', 'orders',
                              'payments', 'accounting_documents', 'files')
      limit p_cap)
    union all
    (select 1
       from public.activities x
      where x.organization_id = p_org
        and x.created_at >= p_from and x.created_at < p_to
        and x.created_by = p_user
      limit p_cap)
    union all
    (select 1 from app.jobs j
                 where j.organization_id = p_org and j.kind = 'message.send' and j.payload ? 'reply_to_user_id'
                   and (j.payload ->> 'reply_to_user_id') = p_user::text
                   and j.created_at >= p_from and j.created_at < p_to limit p_cap)
    union all
    (select 1 from app.jobs j
                 where j.organization_id = p_org and j.kind = 'message.send' and j.payload ? 'sent_by_user_id'
                   and (j.payload ->> 'sent_by_user_id') = p_user::text
                   and j.created_at >= p_from and j.created_at < p_to limit p_cap)
    union all
    (select 1 from app.jobs j
                 where j.organization_id = p_org and j.kind = 'message.send' and j.payload ? 'pressed_by_user_id'
                   and (j.payload ->> 'pressed_by_user_id') = p_user::text
                   and j.created_at >= p_from and j.created_at < p_to limit p_cap)
  ) c;
  return v_n;
end;
$$;
revoke all on function app.anomaly_person_changes(uuid, uuid, timestamptz, timestamptz, integer) from public, anon, authenticated, service_role;

-- lead_drop: the active sources whose leads fell sharply (see the header)
create or replace function app.anomaly_lead_drops(p_org uuid, p_today date, p_zone text) returns setof uuid
language sql stable security definer
set search_path = ''
as $$
  with c as (
    select l.source_id,
           count(*) filter (where l.created_at >= app.anomaly_day_start(p_today - 7, p_zone)) as recent,
           count(*) filter (where l.created_at < app.anomaly_day_start(p_today - 7, p_zone)) as base,
           count(distinct (((l.created_at at time zone p_zone)::date - (p_today - 35)) / 7))
             filter (where l.created_at < app.anomaly_day_start(p_today - 7, p_zone)) as weeks
      from public.leads l
     where l.organization_id = p_org
       and l.deleted_at is null
       and l.source_id is not null
       and l.import_job_id is null
       and l.created_at >= app.anomaly_day_start(p_today - 35, p_zone)
       and l.created_at < app.anomaly_day_start(p_today, p_zone)
       and not exists (select 1 from app.sample_records s where s.organization_id = p_org and s.lead_id = l.id)
     group by l.source_id
  )
  select c.source_id
    from c
    join public.lead_sources s on s.organization_id = p_org and s.id = c.source_id and s.is_active
   where c.weeks = 4 and c.base >= 20 and c.recent * 8 < c.base
$$;
revoke all on function app.anomaly_lead_drops(uuid, date, text) from public, anon, authenticated, service_role;

-- idle_rep: members and managers who stopped changing records (see the header)
create or replace function app.anomaly_idle_reps(p_org uuid, p_today date, p_zone text) returns setof uuid
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_m record;
  v_day date;
  v_found integer;
  v_start timestamptz;
  -- the window ends where today begins: what the person does today does not matter yet
  v_end timestamptz := app.anomaly_day_start(p_today, p_zone);
begin
  for v_m in
    select m.user_id, m.created_at
      from public.memberships m
     where m.organization_id = p_org
       and m.status = 'active'
       and m.seat_type = 'full'
       and m.role in ('manager', 'member')
  loop
    -- the person's own last 3 working days before today (at most 60 days back)
    v_day := p_today;
    v_found := 0;
    while v_found < 3 and v_day > p_today - 60 loop
      v_day := v_day - 1;
      if app.anomaly_member_works(p_org, v_m.user_id, v_day, p_zone) then
        v_found := v_found + 1;
      end if;
    end loop;
    continue when v_found < 3;
    v_start := app.anomaly_day_start(v_day, p_zone);
    continue when v_m.created_at >= v_start - interval '14 days';
    -- the business was writable through the whole window: no status change since it began, no suspension overlapping it
    continue when exists (
      select 1 from public.audit_log a
       where a.organization_id = p_org and a.entity_type = 'organizations' and a.entity_id = p_org
         and a.created_at >= v_start and a.created_at < v_end and a.changes ? 'status'
         -- only a change from or to a status app.org_writable refuses (trial -> active and the like keep it writable)
         and (coalesce(a.changes #>> '{status,old}', '') not in ('trial', 'active', 'past_due')
              or coalesce(a.changes #>> '{status,new}', '') not in ('trial', 'active', 'past_due')));
    continue when exists (
      select 1 from app.org_suspensions s
       where s.organization_id = p_org and s.suspended_at < v_end and coalesce(s.ended_at, 'infinity'::timestamptz) > v_start);
    continue when app.anomaly_person_changes(p_org, v_m.user_id, v_start, v_end, 1) > 0;
    continue when app.anomaly_person_changes(p_org, v_m.user_id, v_start - interval '30 days', v_start, 5) < 5;
    return next v_m.user_id;
  end loop;
end;
$$;
revoke all on function app.anomaly_idle_reps(uuid, date, text) from public, anon, authenticated, service_role;

-- quiet_form: web forms and webhooks that took inquiries regularly and stopped (see the header)
create or replace function app.anomaly_quiet_forms(p_org uuid, p_today date, p_zone text) returns setof uuid
language sql stable security definer
set search_path = ''
as $$
  select f.id
    from public.forms f
    cross join lateral (
      select count(*) filter (where s.created_at < app.anomaly_day_start(p_today - 7, p_zone)) as base,
             count(distinct (((s.created_at at time zone p_zone)::date - (p_today - 35)) / 7))
               filter (where s.created_at < app.anomaly_day_start(p_today - 7, p_zone)) as weeks,
             count(*) filter (where s.created_at >= app.anomaly_day_start(p_today - 7, p_zone)) as recent
        from public.form_submissions s
       where s.form_id = f.id
         and s.organization_id = p_org
         and s.status <> 'spam'
         and s.created_at >= app.anomaly_day_start(p_today - 35, p_zone)
         and s.created_at < app.anomaly_day_start(p_today, p_zone)
    ) c
   where f.organization_id = p_org
     and f.kind in ('form', 'webhook')
     and f.is_active
     and f.created_at < app.anomaly_day_start(p_today - 35, p_zone)
     and c.base >= 4 and c.weeks >= 3 and c.recent = 0
$$;
revoke all on function app.anomaly_quiet_forms(uuid, date, text) from public, anon, authenticated, service_role;

-- campaign_jump: SEG-03 cost keys whose cost per lead last month at least doubled (see the header). Answers each key as
-- '<source id or empty>|<campaign in lower case or empty>|<the month>'.
create or replace function app.anomaly_campaign_jumps(p_org uuid, p_today date, p_zone text) returns setof text
language sql stable security definer
set search_path = ''
as $$
  with m as (
    select (date_trunc('month', p_today::timestamp) - interval '1 month')::date as last_month
  ), costs as (
    select c.source_id, lower(c.campaign) as ckey, c.month,
           sum(case when c.amount_includes_vat
                    then coalesce(app.amount_before_vat(c.amount_agorot, app.vat_rate_at(c.month)), c.amount_agorot)
                    else c.amount_agorot end)::bigint as cost
      from public.campaign_costs c, m
     where c.organization_id = p_org
       and c.month between (m.last_month - interval '3 months')::date and m.last_month
       and (c.source_id is not null or c.campaign is not null)
     group by c.source_id, lower(c.campaign), c.month
  ), keys as (
    select distinct c.source_id, c.ckey from costs c, m where c.month = m.last_month and c.cost > 0
  ), lead_months as (
    select l.source_id, lower(nullif(btrim(l.campaign), '')) as ckey,
           date_trunc('month', l.created_at at time zone p_zone)::date as month, count(*)::bigint as n
      from public.leads l, m
     where l.organization_id = p_org
       and l.deleted_at is null
       and l.import_job_id is null
       and l.created_at >= app.anomaly_day_start((m.last_month - interval '3 months')::date, p_zone)
       and l.created_at < app.anomaly_day_start((m.last_month + interval '1 month')::date, p_zone)
       and not exists (select 1 from app.sample_records s where s.organization_id = p_org and s.lead_id = l.id)
     group by 1, 2, 3
  ), per as (
    select k.source_id, k.ckey, c.month, c.cost,
           (select coalesce(sum(x.n), 0) from lead_months x
             where x.month = c.month
               and (k.source_id is null or x.source_id = k.source_id)
               and (k.ckey is null or x.ckey = k.ckey))::bigint as leads
      from keys k
      join costs c on c.source_id is not distinct from k.source_id and c.ckey is not distinct from k.ckey
  )
  select coalesce(p.source_id::text, '') || '|' || coalesce(p.ckey, '') || '|' || to_char(m.last_month, 'YYYY-MM')
    from per p, m
   group by p.source_id, p.ckey, m.last_month
  having count(*) filter (where p.month < m.last_month and p.cost > 0 and p.leads > 0) = 3
     and sum(p.leads) filter (where p.month < m.last_month) >= 10
     and (max(p.leads) filter (where p.month = m.last_month) = 0
          or max(p.cost) filter (where p.month = m.last_month)::numeric * sum(p.leads) filter (where p.month < m.last_month)
             >= 2 * sum(p.cost) filter (where p.month < m.last_month)::numeric * max(p.leads) filter (where p.month = m.last_month))
$$;
revoke all on function app.anomaly_campaign_jumps(uuid, date, text) from public, anon, authenticated, service_role;

-- One notice for a kind: marks the targets not told yet and, when there is any, tells every active owner and admin with
-- their count ("נוסף" / "נוספים" when targets of the kind were already told since the week began). Answers how many
-- targets were new.
create or replace function app.anomaly_alert_notify(p_org uuid, p_kind text, p_week date, p_zone text, p_keys text[])
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_new text[];
  v_n integer;
  v_more boolean;
  v_title text;
  v_body text;
  v_entity text;
begin
  with ins as (
    insert into app.anomaly_alerts_sent (organization_id, kind, target_key, week_start)
    select p_org, p_kind, k, case when p_kind = 'campaign_jump' then date '1970-01-04' else p_week end
      from unnest(p_keys) k where k is not null
    on conflict do nothing
    returning target_key
  )
  select coalesce(array_agg(target_key), '{}') into v_new from ins;
  v_n := cardinality(v_new);
  if v_n = 0 then
    return 0;
  end if;
  v_more := exists (
    select 1 from app.anomaly_alerts_sent s
     where s.organization_id = p_org and s.kind = p_kind
       and s.sent_at >= app.anomaly_day_start(p_week, p_zone)
       and s.target_key <> all (v_new));
  case p_kind
    when 'lead_drop' then
      v_title := 'ירידה חדה בפניות ממקור קבוע';
      v_body := case when v_n = 1 then case when v_more then 'מקור נוסף' else 'מקור אחד' end
                         || ': ב-7 הימים האחרונים הגיעו ממנו פחות ממחצית הממוצע השבועי של 4 השבועות שלפניהם'
                     else v_n || case when v_more then ' מקורות נוספים' else ' מקורות' end
                         || ': ב-7 הימים האחרונים הגיעו מהם פחות ממחצית הממוצע השבועי של 4 השבועות שלפניהם' end;
      v_entity := 'anomaly_lead_drop';
    when 'idle_rep' then
      v_title := 'חברי צוות שלא עדכנו רשומות';
      v_body := case when v_n = 1 then case when v_more then 'חבר צוות נוסף' else 'חבר צוות אחד' end
                         || ' לא עדכן אף רשומה ב-3 ימי העבודה האחרונים שלו'
                     else v_n || case when v_more then ' חברי צוות נוספים' else ' חברי צוות' end
                         || ' לא עדכנו אף רשומה ב-3 ימי העבודה האחרונים שלהם' end;
      v_entity := 'anomaly_idle_rep';
    when 'quiet_form' then
      v_title := 'טופס שהפסיק לקבל פניות';
      v_body := case when v_n = 1 then case when v_more then 'טופס נוסף' else 'טופס אחד' end
                         || ' לא קיבל אף פנייה ב-7 הימים האחרונים, אחרי שקיבל פניות קבועות בחודש שלפני'
                     else v_n || case when v_more then ' טפסים נוספים' else ' טפסים' end
                         || ' לא קיבלו אף פנייה ב-7 הימים האחרונים, אחרי שקיבלו פניות קבועות בחודש שלפני' end;
      v_entity := 'anomaly_quiet_form';
    else
      v_title := 'העלות לפנייה קפצה';
      v_body := case when v_n = 1 then case when v_more then 'קמפיין או מקור נוסף' else 'קמפיין או מקור אחד' end
                     else v_n || case when v_more then ' קמפיינים או מקורות נוספים' else ' קמפיינים או מקורות' end end
                || ': בחודש שעבר העלות לפנייה הייתה לפחות כפולה מהממוצע של 3 החודשים שלפניו';
      v_entity := 'anomaly_campaign_jump';
  end case;
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select m.organization_id, m.user_id, 'system', v_title, v_body, v_entity, p_org
    from public.memberships m
   where m.organization_id = p_org and m.status = 'active' and m.role in ('owner', 'admin');
  return v_n;
end;
$$;
revoke all on function app.anomaly_alert_notify(uuid, text, date, text, text[]) from public, anon, authenticated, service_role;

create or replace function app.send_anomaly_alerts(p_orgs uuid[] default null, p_now timestamptz default now()) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_week date;
  v_full_week boolean;
  v_served integer := 0;
  v_started timestamptz := clock_timestamp();
begin
  for v_row in
    select o.id as organization_id, z.zone, (p_now at time zone z.zone)::date as today
      from public.organizations o
      cross join lateral (select app.intake_zone(o.timezone) as zone) z
      left join app.anomaly_alert_days s
        on s.organization_id = o.id and s.day = (p_now at time zone z.zone)::date
      left join lateral (
        select max(x.last_attempt_at) as served_at from app.anomaly_alert_days x where x.organization_id = o.id) last on true
     where (p_orgs is null or o.id = any (p_orgs))
       -- from 08:00 in the business's zone, once a day
       and (p_now at time zone z.zone)::time >= time '08:00'
       and (s.organization_id is null or (s.done_at is null and s.failures < 3))
       and app.org_writable(o.id)
     -- businesses take turns: the one served longest ago first
     order by last.served_at nulls first, o.id
     limit app.anomaly_alert_limit()
  loop
    begin
      v_week := v_row.today - extract(dow from v_row.today)::integer;
      -- a week with fewer working days than the fullest of the 4 before is not compared (holidays, CAL-03)
      v_full_week := app.anomaly_full_week(v_row.organization_id, v_row.today);
      if app.org_leads_enabled(v_row.organization_id) then
        if v_full_week then
          perform app.anomaly_alert_notify(v_row.organization_id, 'lead_drop', v_week, v_row.zone,
            array(select x::text from app.anomaly_lead_drops(v_row.organization_id, v_row.today, v_row.zone) x));
        end if;
        if app.org_has_feature(v_row.organization_id, 'campaign_costs') then
          perform app.anomaly_alert_notify(v_row.organization_id, 'campaign_jump', v_week, v_row.zone,
            array(select x from app.anomaly_campaign_jumps(v_row.organization_id, v_row.today, v_row.zone) x));
        end if;
      end if;
      perform app.anomaly_alert_notify(v_row.organization_id, 'idle_rep', v_week, v_row.zone,
        array(select x::text from app.anomaly_idle_reps(v_row.organization_id, v_row.today, v_row.zone) x));
      if v_full_week then
        perform app.anomaly_alert_notify(v_row.organization_id, 'quiet_form', v_week, v_row.zone,
          array(select x::text from app.anomaly_quiet_forms(v_row.organization_id, v_row.today, v_row.zone) x));
      end if;
      insert into app.anomaly_alert_days (organization_id, day, done_at, last_attempt_at)
      values (v_row.organization_id, v_row.today, now(), now())
      on conflict (organization_id, day)
        do update set done_at = excluded.done_at, last_attempt_at = excluded.last_attempt_at;
      v_served := v_served + 1;
    exception when others then
      insert into app.anomaly_alert_days (organization_id, day, failures, last_attempt_at)
      values (v_row.organization_id, v_row.today, 1, now())
      on conflict (organization_id, day)
        do update set failures = app.anomaly_alert_days.failures + 1, last_attempt_at = excluded.last_attempt_at;
      raise warning 'crm-anomaly-alerts: organization % failed (SQLSTATE %)', v_row.organization_id, sqlstate;
    end;
    exit when clock_timestamp() - v_started > app.anomaly_alert_budget();
  end loop;
  return v_served;
end;
$$;
revoke all on function app.send_anomaly_alerts(uuid[], timestamptz) from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-anomaly-alerts', '47 * * * *', 'select app.send_anomaly_alerts();');
  end if;
end;
$$;
