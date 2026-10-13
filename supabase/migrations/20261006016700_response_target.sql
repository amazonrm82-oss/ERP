-- =============================================================================
-- Response target for a new lead, and what happens when it is missed (CAP-10)
-- =============================================================================
-- * public.lead_response_settings: at most one row per organization. Members
--   read it; owners and admins of a writable organization write it (audited).
--   No row = the defaults: target 60 minutes (owner's decision for SPD-06, the
--   initial value of every business), action 'notify'.
--   target_minutes: 5..1440 (five minutes to one day of working time).
--   breach_action: 'notify' (default: the managers are told) | 'none' (nothing
--   happens; the report still measures). SPD-03 adds 'pass_on'.
-- * app.response_target_minutes(org) now reads the setting (SPD-06's report
--   and breakdown use it, so "within target" and the alert use one number).
--   Still security invoker: the report caller reads the row through RLS, and a
--   caller who may not read it gets 60.
-- * app.response_deadline(org, from, minutes): the moment `minutes` of working
--   time have passed since `from`. Working time is the business's weekly hours
--   (org_calendar_settings.working_hours, CAP-09) in its time zone, minus its
--   rest days and holidays (app.org_rest_day, CAL-03). With no hours set, every
--   hour of a working day counts, and rest days still do not (SPEC-ADDITIONS
--   18.3: a lead that comes in on a rest day is not late before the next working
--   day starts). With no rest days either, this is wall-clock time.
-- * Which leads: only those that came in through intake (form or webhook,
--   public.intake_submit sets app.intake around the insert; SPEC-ADDITIONS 18.3:
--   not imported, manual or bulk). Trigger leads_response_watch notes them in
--   app.lead_response_checks. The clock runs from the lead's arrival for its
--   first owner; when the owner changes (trigger leads_response_owner) it starts
--   again for the new owner. A lead with no owner waits (SPD-01's "לקחתי" and
--   CAP-09's rotation give it one).
-- * "Answered" is the rule of the response report and the waiting screen
--   (src/features/leads/waiting.ts): an activity a person logged, of a contact
--   type (app.contact_types()), not private.
-- * pg_cron crm-response-target (every minute) runs app.check_lead_responses():
--   a lead that is still open, unconverted, not in the bin and not answered when
--   its deadline passes gets the business's action: 'notify' tells the managers
--   of the lead's team or a parent team who may read it (else the owners and
--   admins), kind 'response_overdue', once per lead. Bounded and fair like
--   app.assign_waiting_rotation_leads (0161): per-organization and per-run caps,
--   rows taken by next_check_at, one exception block per row, a lead locked by
--   someone else (a handover, a "לקחתי") is looked at a minute later. A
--   read-only or suspended organization is left alone. Rows are closed after 14
--   days.
-- Accepted (review L4): each lead row the job handles stays locked until the
--   run's transaction ends (at most 500 rows, one short run a minute); a "לקחתי"
--   or an edit of such a lead waits for the run.
-- Accepted (review L6): business hours with no working time at all in the next
--   400 days (e.g. every range on rest days) give no deadline, so no alert; the
--   row is looked at again daily.
-- Every statement is safe to run twice, also after SPD-03's migration (the
-- action check is added only when missing; the job is redefined there).

-- ----------------------------------------------------------------------------
-- The setting
-- ----------------------------------------------------------------------------
create table if not exists public.lead_response_settings (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  target_minutes  integer not null default 60,
  breach_action   text not null default 'notify',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id),
  constraint lead_response_settings_target_range check (target_minutes between 5 and 1440)
);

-- added only when missing: a later migration (SPD-03) widens it, and running
-- this file again must not narrow it back
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.lead_response_settings'::regclass and conname = 'lead_response_settings_action_check') then
    alter table public.lead_response_settings add constraint lead_response_settings_action_check check (breach_action in ('notify', 'none'));
  end if;
end;
$$;

comment on table public.lead_response_settings is
  'CAP-10: the response target for a new lead (working minutes) and what happens when it is missed; at most one row per organization, no row = 60 / notify.';

create or replace trigger lead_response_settings_touch before insert or update on public.lead_response_settings
  for each row execute function app.touch_row();
create or replace trigger lead_response_settings_audit after insert or update or delete on public.lead_response_settings
  for each row execute function app.audit_row();

alter table public.lead_response_settings enable row level security;
revoke all on public.lead_response_settings from anon, authenticated;
grant select, delete on public.lead_response_settings to authenticated;
grant insert (organization_id, target_minutes, breach_action) on public.lead_response_settings to authenticated;
grant update (target_minutes, breach_action) on public.lead_response_settings to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'lead_response_settings' and policyname = 'lead_response_settings_select') then
    create policy lead_response_settings_select on public.lead_response_settings for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'lead_response_settings' and policyname = 'lead_response_settings_insert') then
    create policy lead_response_settings_insert on public.lead_response_settings for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'lead_response_settings' and policyname = 'lead_response_settings_update') then
    create policy lead_response_settings_update on public.lead_response_settings for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'lead_response_settings' and policyname = 'lead_response_settings_delete') then
    create policy lead_response_settings_delete on public.lead_response_settings for delete to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

-- The one place the target comes from (SPD-06 reports, the alert). Language,
-- security, grants and revokes as in 0117; only the body reads the setting.
create or replace function app.response_target_minutes(p_org uuid) returns integer
language sql stable
set search_path = ''
as $$
  select coalesce((select s.target_minutes from public.lead_response_settings s where s.organization_id = p_org), 60);
$$;

revoke all on function app.response_target_minutes(uuid) from public, anon;
grant execute on function app.response_target_minutes(uuid) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Working time
-- ----------------------------------------------------------------------------
-- The moment p_minutes of the business's working time have passed since
-- p_from (see the header). Null when there is no working time in the next
-- 400 days (cannot happen with valid settings; the caller looks again later).
create or replace function app.response_deadline(p_org uuid, p_from timestamptz, p_minutes integer) returns timestamptz
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_zone text;
  v_hours jsonb;
  v_local timestamp;
  v_day date;
  v_left numeric := greatest(coalesce(p_minutes, 0), 0);
  v_ranges jsonb;
  v_range record;
  v_start timestamp;
  v_end timestamp;
  v_avail numeric;
  i integer;
begin
  if p_org is null or p_from is null then
    return null;
  end if;
  select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = p_org;
  if v_zone is null then
    return null;
  end if;
  select c.working_hours into v_hours from public.org_calendar_settings c where c.organization_id = p_org;
  v_local := p_from at time zone v_zone;
  v_day := v_local::date;
  for i in 0 .. 400 loop
    if not app.org_rest_day(p_org, v_day) then
      if v_hours is null then
        v_ranges := '[{"start": "00:00", "end": "23:59"}]'::jsonb;
      else
        v_ranges := v_hours -> (array['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'])[extract(dow from v_day)::int + 1];
        if v_ranges is not null and jsonb_typeof(v_ranges) <> 'array' then
          v_ranges := jsonb_build_array(v_ranges);
        end if;
      end if;
      if v_ranges is not null then
        for v_range in
          select (r.value ->> 'start') as s, (r.value ->> 'end') as e
            from jsonb_array_elements(v_ranges) r
           order by (r.value ->> 'start') collate "C"
        loop
          v_start := greatest(v_day + v_range.s::time, v_local);
          -- a range ending 23:59 runs to midnight (app.hours_cover)
          v_end := case when v_range.e = '23:59' then v_day + 1 else v_day + v_range.e::time end;
          if v_end > v_start then
            v_avail := extract(epoch from v_end - v_start) / 60;
            if v_avail >= v_left then
              return (v_start + make_interval(secs => (v_left * 60)::double precision)) at time zone v_zone;
            end if;
            v_left := v_left - v_avail;
          end if;
        end loop;
      end if;
    end if;
    v_day := v_day + 1;
  end loop;
  return null;
end;
$$;
revoke all on function app.response_deadline(uuid, timestamptz, integer) from public, anon, authenticated;
grant execute on function app.response_deadline(uuid, timestamptz, integer) to service_role;

-- ----------------------------------------------------------------------------
-- The leads being watched
-- ----------------------------------------------------------------------------
-- One row per intake lead. window_start: when the current owner's clock
-- started. outcome: why the row was closed. Schema app: no API access.
create table if not exists app.lead_response_checks (
  lead_id         uuid primary key references public.leads (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  owner_id        uuid,
  window_start    timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  next_check_at   timestamptz not null default now(),
  notified_at     timestamptz,
  resolved_at     timestamptz,
  outcome         text
);
create index if not exists lead_response_checks_due_idx on app.lead_response_checks (next_check_at) where resolved_at is null;
alter table app.lead_response_checks enable row level security;
revoke all on app.lead_response_checks from public, anon, authenticated;

-- A lead that came in through intake_submit (app.intake = 'on') is watched.
create or replace function app.lead_response_watch() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if current_setting('app.intake', true) is distinct from 'on' then
    return null;
  end if;
  insert into app.lead_response_checks (lead_id, organization_id, owner_id, window_start, next_check_at)
  values (new.id, new.organization_id, new.owner_id, new.created_at,
          -- no owner yet: the owner trigger wakes the row when one is set
          case when new.owner_id is null then now() + interval '1 day' else now() end)
  on conflict (lead_id) do nothing;
  return null;
end;
$$;
revoke all on function app.lead_response_watch() from public, anon, authenticated;

create or replace trigger leads_response_watch after insert on public.leads
  for each row execute function app.lead_response_watch();

-- A new owner gets their own clock, from now.
create or replace function app.lead_response_owner() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.owner_id is distinct from old.owner_id then
    update app.lead_response_checks
       set owner_id = new.owner_id,
           window_start = now(),
           next_check_at = case when new.owner_id is null then now() + interval '1 day' else now() end
     where lead_id = new.id and resolved_at is null;
  end if;
  return null;
end;
$$;
revoke all on function app.lead_response_owner() from public, anon, authenticated;

create or replace trigger leads_response_owner after update of owner_id on public.leads
  for each row execute function app.lead_response_owner();

-- ----------------------------------------------------------------------------
-- Who is told
-- ----------------------------------------------------------------------------
-- The managers of the lead's team or a parent team (team_members.is_manager,
-- the chain of app.manages_team) who are active and may read the lead, not its
-- owner; else the active owners and admins but the lead's owner; else, in a
-- business of one, its owner or admin who owns the lead.
create or replace function app.response_managers(p_org uuid, p_team uuid, p_owner uuid)
returns table (user_id uuid)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if p_team is not null then
    return query
      with recursive chain as (
        select t.id, t.parent_team_id, 1 as depth
          from public.teams t where t.organization_id = p_org and t.id = p_team
        union all
        select t.id, t.parent_team_id, c.depth + 1
          from public.teams t
          join chain c on t.id = c.parent_team_id
         where c.depth < 10
      )
      select distinct tm.user_id
        from chain c
        join public.team_members tm on tm.team_id = c.id and tm.is_manager
        join public.memberships m on m.organization_id = p_org and m.user_id = tm.user_id and m.status = 'active'
       where tm.user_id is distinct from p_owner
         and app.user_can_read_record(p_org, tm.user_id, p_owner, p_team);
    if found then
      return;
    end if;
  end if;
  return query
    select m.user_id from public.memberships m
     where m.organization_id = p_org and m.status = 'active' and m.role in ('owner', 'admin')
       and m.user_id is distinct from p_owner;
  if found then
    return;
  end if;
  return query
    select m.user_id from public.memberships m
     where m.organization_id = p_org and m.status = 'active' and m.role in ('owner', 'admin')
       and m.user_id = p_owner;
end;
$$;
revoke all on function app.response_managers(uuid, uuid, uuid) from public, anon, authenticated;

-- How many rows the job looks at per organization, and in all, per run
-- (settings app.response_check_per_org / app.response_check_limit; tests lower
-- them). Defaults and maxima: 50 and 500.
create or replace function app.response_check_per_org() returns integer
language sql stable
set search_path = ''
as $$
  select case when s ~ '^[0-9]{1,4}$' then least(greatest(s::int, 1), 50) else 50 end
    from coalesce(current_setting('app.response_check_per_org', true), '') as s
$$;
revoke all on function app.response_check_per_org() from public, anon, authenticated;

create or replace function app.response_check_limit() returns integer
language sql stable
set search_path = ''
as $$
  select case when s ~ '^[0-9]{1,4}$' then least(greatest(s::int, 1), 500) else 500 end
    from coalesce(current_setting('app.response_check_limit', true), '') as s
$$;
revoke all on function app.response_check_limit() from public, anon, authenticated;

-- Looks at a row again later without waiting: the row is skipped when another
-- transaction holds it (review L3: a blocking update in the job's error paths
-- could deadlock and abort the whole run). True when it was rescheduled.
create or replace function app.response_check_later(p_lead uuid, p_after interval) returns boolean
language plpgsql security definer
set search_path = ''
as $$
begin
  perform 1 from app.lead_response_checks c where c.lead_id = p_lead for update skip locked;
  if not found then
    return false;
  end if;
  update app.lead_response_checks set next_check_at = now() + p_after where lead_id = p_lead;
  return true;
end;
$$;
revoke all on function app.response_check_later(uuid, interval) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The job
-- ----------------------------------------------------------------------------
-- Returns how many leads got the business's action in this run.
create or replace function app.check_lead_responses() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_lead record;
  v_target integer;
  v_action text;
  v_due timestamptz;
  v_owner_name text;
  v_done integer := 0;
begin
  for v_row in
    select d.lead_id, d.organization_id, d.window_start, d.created_at
      from (
        select c.lead_id, c.organization_id, c.window_start, c.created_at, c.next_check_at,
               row_number() over (partition by c.organization_id order by c.next_check_at, c.created_at) as n
          from app.lead_response_checks c
         where c.resolved_at is null and c.next_check_at <= now()
      ) d
     where d.n <= app.response_check_per_org()
     order by d.next_check_at, d.created_at
     limit app.response_check_limit()
  loop
    begin
      begin
        select l.owner_id, l.team_id, l.deleted_at, l.converted_at,
               coalesce(nullif(btrim(l.full_name), ''), nullif(btrim(l.company_name), ''), l.phone, l.email, 'ליד ללא שם') as name,
               s.kind as status_kind
          into v_lead
          from public.leads l
          join public.lead_statuses s on s.organization_id = l.organization_id and s.id = l.status_id
         where l.organization_id = v_row.organization_id and l.id = v_row.lead_id
           for update of l nowait;
      exception when lock_not_available then
        -- a handover or a "לקחתי" holds the lead: look again in a minute (never waits)
        perform app.response_check_later(v_row.lead_id, interval '1 minute');
        continue;
      end;

      if not found or v_lead.deleted_at is not null or v_lead.converted_at is not null or v_lead.status_kind <> 'open' then
        update app.lead_response_checks set resolved_at = now(), outcome = 'closed' where lead_id = v_row.lead_id;
      elsif exists (
        select 1 from public.activities a
         where a.organization_id = v_row.organization_id and a.lead_id = v_row.lead_id
           and a.created_by is not null and a.type = any (app.contact_types()) and not a.is_private) then
        update app.lead_response_checks set resolved_at = now(), outcome = 'contacted' where lead_id = v_row.lead_id;
      elsif v_row.created_at < now() - interval '14 days' then
        update app.lead_response_checks set resolved_at = now(), outcome = 'expired' where lead_id = v_row.lead_id;
      elsif not app.org_writable(v_row.organization_id) then
        update app.lead_response_checks set next_check_at = now() + interval '15 minutes' where lead_id = v_row.lead_id;
      elsif v_lead.owner_id is null then
        -- nobody owns it yet (SPD-01, CAP-09): the owner trigger wakes the row
        update app.lead_response_checks set next_check_at = now() + interval '1 day' where lead_id = v_row.lead_id;
      else
        v_target := app.response_target_minutes(v_row.organization_id);
        v_due := app.response_deadline(v_row.organization_id, v_row.window_start, v_target);
        if v_due is null then
          update app.lead_response_checks set next_check_at = now() + interval '1 day' where lead_id = v_row.lead_id;
        elsif v_due > now() then
          -- at most 15 minutes ahead, so a changed target or calendar is seen soon
          update app.lead_response_checks set next_check_at = least(v_due, now() + interval '15 minutes') where lead_id = v_row.lead_id;
        else
          select coalesce(s.breach_action, 'notify') into v_action
            from (select 1) one
            left join public.lead_response_settings s on s.organization_id = v_row.organization_id;
          if v_action = 'none' then
            update app.lead_response_checks set resolved_at = now(), outcome = 'no_action' where lead_id = v_row.lead_id;
          else
            select nullif(btrim(p.full_name), '') into v_owner_name from public.profiles p where p.id = v_lead.owner_id;
            insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
            select v_row.organization_id, r.user_id, 'response_overdue',
                   left('ליד מחכה למענה יותר מ-' || v_target || ' דקות', 200),
                   left(v_lead.name || coalesce(' · באחריות ' || v_owner_name, ''), 500),
                   'lead', v_row.lead_id
              from app.response_managers(v_row.organization_id, v_lead.team_id, v_lead.owner_id) r;
            update app.lead_response_checks set resolved_at = now(), notified_at = now(), outcome = 'notified'
             where lead_id = v_row.lead_id;
            v_done := v_done + 1;
          end if;
        end if;
      end if;
    exception when others then
      -- this row's changes are rolled back; look at it again later (never waits), go on with the others
      begin
        perform app.response_check_later(v_row.lead_id, interval '10 minutes');
      exception when others then
        null;
      end;
    end;
  end loop;
  return v_done;
end;
$$;
revoke all on function app.check_lead_responses() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-response-target', '* * * * *', 'select app.check_lead_responses();');
  end if;
end;
$$;
