-- =============================================================================
-- MNY-04, owner's answers (285) ג and (286) ב: a switch and a threshold per anomaly alert; owners and admins are counted
-- =============================================================================
-- Owner, 11 November 2026: (285) ג "מתג וסף לכל התראה, ברירות המחדל דולקות"; (286) ב "התראת 'נציג שלא עדכן' גם על
-- בעלים ומנהלי מערכת; ההתראה עליהם הולכת לשאר הבעלים והמנהלים".
--
-- * public.anomaly_alert_settings: one row per business (no row = the defaults, every alert on with 021228's numbers).
--   Members read it; owners and admins of a writable business insert and update it through column grants; no delete; touch
--   and audit triggers. Columns and bounds:
--   - lead_drop_on (default true), lead_drop_percent 10..90 (default 50): a regular source is told when the last 7 days
--     brought fewer than (100 - percent)% of its weekly average of the 4 weeks before (50 = 021228's "fewer than half").
--   - idle_rep_on (default true), idle_rep_days 1..10 (default 3): a person is told after that many of their own working
--     days without a change (still at most 60 calendar days back).
--   - quiet_form_on (default true), quiet_form_min_inquiries 1..500 (default 4): a form is regular when it took at least that
--     many inquiries in days -35..-8, in at least least(3, that number) of those 4 weeks (4 = 021228's rule).
--   - campaign_jump_on (default true), campaign_jump_percent 20..1000 (default 100): last month's cost per lead at least
--     (100 + percent)% of the 3 months' (100 = 021228's "double"); a last month with no lead is told as before.
--   app.anomaly_settings_of(org) (definer, no grants) answers the business's row, or one built from the column defaults.
-- * The job: app.send_anomaly_alerts (021228's body) runs a detector only while its switch is on.
-- * (286) ב: app.anomaly_idle_reps (021228's body) also looks at active owners and admins (role in owner, admin, manager,
--   member). app.anomaly_alert_notify (021228's body, its texts unchanged at the default numbers) now builds the notice per
--   recipient: for idle_rep a recipient is never counted among the people told about, so a notice about an owner or admin
--   goes to the OTHER active owners and admins only, and nobody is told when nobody else is there (the person is still marked
--   told for the week). "נוסף" is judged per recipient the same way. The other kinds tell every owner and admin the same
--   count, as before. The numbers in the texts follow the business's thresholds.
-- Redefined, each = its latest earlier body (021228) plus the lines marked "MNY-04 (285)" / "MNY-04 (286)":
-- app.anomaly_lead_drops, app.anomaly_idle_reps, app.anomaly_quiet_forms, app.anomaly_campaign_jumps,
-- app.send_anomaly_alerts; app.anomaly_alert_notify keeps its insert, its "more" rule and its texts but moves the text and
-- the insert into a loop over the recipients (one notice per recipient, as before). New: the table and
-- app.anomaly_settings_of.
-- Every statement is safe to run twice. No drop statement, no delete.

create table if not exists public.anomaly_alert_settings (
  id                        uuid primary key default gen_random_uuid(),
  organization_id           uuid not null references public.organizations (id) on delete cascade,
  lead_drop_on              boolean not null default true,
  lead_drop_percent         smallint not null default 50,
  idle_rep_on               boolean not null default true,
  idle_rep_days             smallint not null default 3,
  quiet_form_on             boolean not null default true,
  quiet_form_min_inquiries  smallint not null default 4,
  campaign_jump_on          boolean not null default true,
  campaign_jump_percent     smallint not null default 100,
  updated_by                uuid references auth.users (id) on delete set null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id),
  constraint anomaly_alert_settings_lead_drop_range check (lead_drop_percent between 10 and 90),
  constraint anomaly_alert_settings_idle_rep_range check (idle_rep_days between 1 and 10),
  constraint anomaly_alert_settings_quiet_form_range check (quiet_form_min_inquiries between 1 and 500),
  constraint anomaly_alert_settings_campaign_range check (campaign_jump_percent between 20 and 1000)
);
comment on table public.anomaly_alert_settings is
  'MNY-04 (285) ג: a switch and a threshold per anomaly alert; no row = every alert on with the default numbers.';

create or replace trigger anomaly_alert_settings_touch before insert or update on public.anomaly_alert_settings
  for each row execute function app.touch_row();
create or replace trigger anomaly_alert_settings_audit after insert or update or delete on public.anomaly_alert_settings
  for each row execute function app.audit_row();

alter table public.anomaly_alert_settings enable row level security;
revoke all on public.anomaly_alert_settings from anon, authenticated;
grant select on public.anomaly_alert_settings to authenticated;
grant insert (organization_id, lead_drop_on, lead_drop_percent, idle_rep_on, idle_rep_days, quiet_form_on,
              quiet_form_min_inquiries, campaign_jump_on, campaign_jump_percent) on public.anomaly_alert_settings to authenticated;
grant update (lead_drop_on, lead_drop_percent, idle_rep_on, idle_rep_days, quiet_form_on, quiet_form_min_inquiries,
              campaign_jump_on, campaign_jump_percent) on public.anomaly_alert_settings to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'anomaly_alert_settings'
                   and policyname = 'anomaly_alert_settings_select') then
    create policy anomaly_alert_settings_select on public.anomaly_alert_settings for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'anomaly_alert_settings'
                   and policyname = 'anomaly_alert_settings_insert') then
    create policy anomaly_alert_settings_insert on public.anomaly_alert_settings for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'anomaly_alert_settings'
                   and policyname = 'anomaly_alert_settings_update') then
    create policy anomaly_alert_settings_update on public.anomaly_alert_settings for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

-- The business's settings, or the defaults when it saved none (the column defaults above; keep the two in step)
create or replace function app.anomaly_settings_of(p_org uuid) returns public.anomaly_alert_settings
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v public.anomaly_alert_settings;
begin
  select * into v from public.anomaly_alert_settings s where s.organization_id = p_org;
  if not found then
    v.organization_id := p_org;
    v.lead_drop_on := true;
    v.lead_drop_percent := 50;
    v.idle_rep_on := true;
    v.idle_rep_days := 3;
    v.quiet_form_on := true;
    v.quiet_form_min_inquiries := 4;
    v.campaign_jump_on := true;
    v.campaign_jump_percent := 100;
  end if;
  return v;
end;
$$;
revoke all on function app.anomaly_settings_of(uuid) from public, anon, authenticated, service_role;

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
    -- MNY-04 (285): the business's percent (50 = fewer than half of the weekly average, 021228's rule)
    cross join app.anomaly_settings_of(p_org) cfg
   where c.weeks = 4 and c.base >= 20 and c.recent * 400 < c.base * (100 - cfg.lead_drop_percent)
$$;
revoke all on function app.anomaly_lead_drops(uuid, date, text) from public, anon, authenticated, service_role;

-- idle_rep: members, managers, admins and owners who stopped changing records (see the header)
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
  -- MNY-04 (285): the business's number of working days (3 = 021228's rule)
  v_days integer := (app.anomaly_settings_of(p_org)).idle_rep_days;
begin
  for v_m in
    select m.user_id, m.created_at
      from public.memberships m
     where m.organization_id = p_org
       and m.status = 'active'
       and m.seat_type = 'full'
       -- MNY-04 (286): owners and admins are counted too
       and m.role in ('owner', 'admin', 'manager', 'member')
  loop
    -- the person's own last working days before today (at most 60 days back)
    v_day := p_today;
    v_found := 0;
    while v_found < v_days and v_day > p_today - 60 loop
      v_day := v_day - 1;
      if app.anomaly_member_works(p_org, v_m.user_id, v_day, p_zone) then
        v_found := v_found + 1;
      end if;
    end loop;
    continue when v_found < v_days;
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
    -- MNY-04 (285): the business's number of inquiries (4 = 021228's rule)
    cross join app.anomaly_settings_of(p_org) cfg
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
     and c.base >= cfg.quiet_form_min_inquiries and c.weeks >= least(3, cfg.quiet_form_min_inquiries) and c.recent = 0
$$;
revoke all on function app.anomaly_quiet_forms(uuid, date, text) from public, anon, authenticated, service_role;

-- campaign_jump: SEG-03 cost keys whose cost per lead last month jumped (see the header). Answers each key as
-- '<source id or empty>|<campaign in lower case or empty>|<the month>'.
create or replace function app.anomaly_campaign_jumps(p_org uuid, p_today date, p_zone text) returns setof text
language sql stable security definer
set search_path = ''
as $$
  with m as (
    select (date_trunc('month', p_today::timestamp) - interval '1 month')::date as last_month,
           -- MNY-04 (285): the business's percent (100 = double, 021228's rule)
           (select 100 + cfg.campaign_jump_percent from app.anomaly_settings_of(p_org) cfg) as factor
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
   group by p.source_id, p.ckey, m.last_month, m.factor
  having count(*) filter (where p.month < m.last_month and p.cost > 0 and p.leads > 0) = 3
     and sum(p.leads) filter (where p.month < m.last_month) >= 10
     and (max(p.leads) filter (where p.month = m.last_month) = 0
          or max(p.cost) filter (where p.month = m.last_month)::numeric * sum(p.leads) filter (where p.month < m.last_month) * 100
             >= m.factor * sum(p.cost) filter (where p.month < m.last_month)::numeric * max(p.leads) filter (where p.month = m.last_month))
$$;
revoke all on function app.anomaly_campaign_jumps(uuid, date, text) from public, anon, authenticated, service_role;

-- One notice for a kind: marks the targets not told yet and, when there is any, tells every active owner and admin with
-- their count ("נוסף" / "נוספים" when targets of the kind were already told since the week began). MNY-04 (286): for
-- idle_rep a recipient is never among the people counted for them, and gets nothing when nobody else is left. Answers how
-- many targets were new.
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
  -- MNY-04 (285) / (286)
  v_cfg public.anomaly_alert_settings := app.anomaly_settings_of(p_org);
  v_rcpt record;
  v_mine text[];
  v_days text;
begin
  with ins as (
    insert into app.anomaly_alerts_sent (organization_id, kind, target_key, week_start)
    select p_org, p_kind, k, case when p_kind = 'campaign_jump' then date '1970-01-04' else p_week end
      from unnest(p_keys) k where k is not null
    on conflict do nothing
    returning target_key
  )
  select coalesce(array_agg(target_key), '{}') into v_new from ins;
  if cardinality(v_new) = 0 then
    return 0;
  end if;
  -- MNY-04 (286): one notice per recipient, without the recipient among the people counted
  for v_rcpt in
    select m.user_id
      from public.memberships m
     where m.organization_id = p_org and m.status = 'active' and m.role in ('owner', 'admin')
  loop
    v_mine := case when p_kind = 'idle_rep' then array_remove(v_new, v_rcpt.user_id::text) else v_new end;
    v_n := cardinality(v_mine);
    continue when v_n = 0;
    v_more := exists (
      select 1 from app.anomaly_alerts_sent s
       where s.organization_id = p_org and s.kind = p_kind
         and s.sent_at >= app.anomaly_day_start(p_week, p_zone)
         and s.target_key <> all (v_new)
         and (p_kind <> 'idle_rep' or s.target_key <> v_rcpt.user_id::text));
    case p_kind
      when 'lead_drop' then
        v_title := 'ירידה חדה בפניות ממקור קבוע';
        -- MNY-04 (285): the business's percent; at 50 the wording of 021228
        v_body := case when v_n = 1 then case when v_more then 'מקור נוסף' else 'מקור אחד' end
                           || ': ב-7 הימים האחרונים הגיעו ממנו '
                       else v_n || case when v_more then ' מקורות נוספים' else ' מקורות' end
                           || ': ב-7 הימים האחרונים הגיעו מהם ' end
                  || case when v_cfg.lead_drop_percent = 50 then 'פחות ממחצית '
                          else 'פחות מ-' || (100 - v_cfg.lead_drop_percent) || '% מ' end
                  || 'הממוצע השבועי של 4 השבועות שלפניהם';
        v_entity := 'anomaly_lead_drop';
      when 'idle_rep' then
        v_title := 'חברי צוות שלא עדכנו רשומות';
        -- MNY-04 (285): the business's number of working days; at 3 the wording of 021228
        v_days := case when v_cfg.idle_rep_days = 1 then 'ביום העבודה האחרון'
                       else 'ב-' || v_cfg.idle_rep_days || ' ימי העבודה האחרונים' end;
        v_body := case when v_n = 1 then case when v_more then 'חבר צוות נוסף' else 'חבר צוות אחד' end
                           || ' לא עדכן אף רשומה ' || v_days || ' שלו'
                       else v_n || case when v_more then ' חברי צוות נוספים' else ' חברי צוות' end
                           || ' לא עדכנו אף רשומה ' || v_days || ' שלהם' end;
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
        -- MNY-04 (285): the business's percent; at 100 the wording of 021228
        v_body := case when v_n = 1 then case when v_more then 'קמפיין או מקור נוסף' else 'קמפיין או מקור אחד' end
                       else v_n || case when v_more then ' קמפיינים או מקורות נוספים' else ' קמפיינים או מקורות' end end
                  || ': בחודש שעבר העלות לפנייה הייתה '
                  || case when v_cfg.campaign_jump_percent = 100 then 'לפחות כפולה'
                          else 'גבוהה לפחות ב-' || v_cfg.campaign_jump_percent || '%' end
                  || ' מהממוצע של 3 החודשים שלפניו';
        v_entity := 'anomaly_campaign_jump';
    end case;
    insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
    values (p_org, v_rcpt.user_id, 'system', v_title, v_body, v_entity, p_org);
  end loop;
  return cardinality(v_new);
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
  -- MNY-04 (285): the business's switches
  v_cfg public.anomaly_alert_settings;
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
      v_cfg := app.anomaly_settings_of(v_row.organization_id);
      v_week := v_row.today - extract(dow from v_row.today)::integer;
      -- a week with fewer working days than the fullest of the 4 before is not compared (holidays, CAL-03)
      v_full_week := app.anomaly_full_week(v_row.organization_id, v_row.today);
      if app.org_leads_enabled(v_row.organization_id) then
        if v_full_week and v_cfg.lead_drop_on then
          perform app.anomaly_alert_notify(v_row.organization_id, 'lead_drop', v_week, v_row.zone,
            array(select x::text from app.anomaly_lead_drops(v_row.organization_id, v_row.today, v_row.zone) x));
        end if;
        if v_cfg.campaign_jump_on and app.org_has_feature(v_row.organization_id, 'campaign_costs') then
          perform app.anomaly_alert_notify(v_row.organization_id, 'campaign_jump', v_week, v_row.zone,
            array(select x from app.anomaly_campaign_jumps(v_row.organization_id, v_row.today, v_row.zone) x));
        end if;
      end if;
      if v_cfg.idle_rep_on then
        perform app.anomaly_alert_notify(v_row.organization_id, 'idle_rep', v_week, v_row.zone,
          array(select x::text from app.anomaly_idle_reps(v_row.organization_id, v_row.today, v_row.zone) x));
      end if;
      if v_full_week and v_cfg.quiet_form_on then
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

notify pgrst, 'reload schema';
