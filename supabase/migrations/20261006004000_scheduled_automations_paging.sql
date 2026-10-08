-- =============================================================================
-- 0040 Scheduled automations reach every record, oldest first (FXD-02)
-- =============================================================================
-- run_scheduled_automations() looked at the first 200 matching records ("no
-- activity for X days", "stuck in a stage") in no fixed order, so a business with
-- a few hundred dormant leads had only part of them handled, run after run.
-- Now each rule goes through its records page by page, oldest first, with a
-- cursor (the page starts after the last record of the previous page), and
-- skips occasions that already ran (same run_key). A rule scans at most 20,000
-- records per run; the rest wait for the next run (every 15 minutes).
-- One function per kind of rule, so each statement fits the SQL Editor; the
-- main function is otherwise as in 0009. Every statement is safe to run twice.

-- "no activity for X days": leads (not converted), contacts, companies, open deals
create or replace function app.scheduled_no_activity(p_auto public.automations) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_count integer := 0;
  v_page integer;
  v_scanned integer := 0;
  v_after_at timestamptz := '-infinity';
  v_after_id uuid := '00000000-0000-0000-0000-000000000000';
  v_days integer := greatest(coalesce((p_auto.trigger_config ->> 'days')::int, 3), 1);
  v_fk text := p_auto.entity_type || '_id';
  v_extra text := case p_auto.entity_type when 'lead' then ' and t.converted_at is null'
                                          when 'deal' then ' and t.status = ''open''' else '' end;
begin
  loop
    v_page := 0;
    for v_row in execute format(
      'select x.id, x.last_at from (
         select t.id, coalesce((select max(a.occurred_at) from public.activities a where a.%I = t.id), t.created_at) as last_at
           from public.%I t
          where t.organization_id = $1 and t.deleted_at is null %s
       ) x
       where x.last_at < now() - make_interval(days => $2)
         and (x.last_at, x.id) > ($3, $4)
         and not exists (select 1 from public.automation_runs r
                          where r.automation_id = $5 and r.run_key = ''noact:'' || x.id || '':'' || x.last_at)
       order by x.last_at, x.id
       limit 200', v_fk, app.automation_table(p_auto.entity_type), v_extra)
      using p_auto.organization_id, v_days, v_after_at, v_after_id, p_auto.id
    loop
      v_page := v_page + 1;
      v_after_at := v_row.last_at;
      v_after_id := v_row.id;
      if app.execute_automation(p_auto, v_row.id, 'noact:' || v_row.id || ':' || v_row.last_at) is not null then
        v_count := v_count + 1;
      end if;
    end loop;
    v_scanned := v_scanned + v_page;
    exit when v_page < 200 or v_scanned >= 20000;
  end loop;
  return v_count;
end;
$$;

-- "stuck in a stage for X days": open deals
create or replace function app.scheduled_stuck_in_stage(p_auto public.automations) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_count integer := 0;
  v_page integer;
  v_scanned integer := 0;
  v_after_at timestamptz := '-infinity';
  v_after_id uuid := '00000000-0000-0000-0000-000000000000';
  v_days integer := greatest(coalesce((p_auto.trigger_config ->> 'days')::int, 14), 1);
begin
  loop
    v_page := 0;
    for v_row in
      select d.id, d.stage_entered_at from public.deals d
       where d.organization_id = p_auto.organization_id and d.deleted_at is null and d.status = 'open'
         and d.stage_entered_at < now() - make_interval(days => v_days)
         and (d.stage_entered_at, d.id) > (v_after_at, v_after_id)
         and not exists (select 1 from public.automation_runs r
                          where r.automation_id = p_auto.id and r.run_key = 'stuck:' || d.id || ':' || d.stage_entered_at)
       order by d.stage_entered_at, d.id
       limit 200
    loop
      v_page := v_page + 1;
      v_after_at := v_row.stage_entered_at;
      v_after_id := v_row.id;
      if app.execute_automation(p_auto, v_row.id, 'stuck:' || v_row.id || ':' || v_row.stage_entered_at) is not null then
        v_count := v_count + 1;
      end if;
    end loop;
    v_scanned := v_scanned + v_page;
    exit when v_page < 200 or v_scanned >= 20000;
  end loop;
  return v_count;
end;
$$;

-- "birthday today": contacts, in the organization's time zone
create or replace function app.scheduled_birthday(p_auto public.automations) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_count integer := 0;
  v_page integer;
  v_scanned integer := 0;
  v_after_id uuid := '00000000-0000-0000-0000-000000000000';
begin
  loop
    v_page := 0;
    for v_row in
      select c.id, to_char(now() at time zone o.timezone, 'YYYY') as year
        from public.contacts c join public.organizations o on o.id = c.organization_id
       where c.organization_id = p_auto.organization_id and c.deleted_at is null and c.birth_date is not null
         and to_char(c.birth_date, 'MM-DD') = to_char(now() at time zone o.timezone, 'MM-DD')
         and c.id > v_after_id
       order by c.id
       limit 200
    loop
      v_page := v_page + 1;
      v_after_id := v_row.id;
      if app.execute_automation(p_auto, v_row.id, 'bday:' || v_row.id || ':' || v_row.year) is not null then
        v_count := v_count + 1;
      end if;
    end loop;
    v_scanned := v_scanned + v_page;
    exit when v_page < 200 or v_scanned >= 20000;
  end loop;
  return v_count;
end;
$$;

-- "task due soon": open tasks due within the next X minutes
create or replace function app.scheduled_task_due_soon(p_auto public.automations) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_count integer := 0;
  v_page integer;
  v_scanned integer := 0;
  v_after_at timestamptz := '-infinity';
  v_after_id uuid := '00000000-0000-0000-0000-000000000000';
  v_minutes integer := least(greatest(coalesce((p_auto.trigger_config ->> 'minutes')::int, 60), 5), 10080);
begin
  loop
    v_page := 0;
    for v_row in
      select t.id, t.due_at from public.tasks t
       where t.organization_id = p_auto.organization_id and t.deleted_at is null and t.status = 'open'
         and t.due_at between now() and now() + make_interval(mins => v_minutes)
         and (t.due_at, t.id) > (v_after_at, v_after_id)
       order by t.due_at, t.id
       limit 200
    loop
      v_page := v_page + 1;
      v_after_at := v_row.due_at;
      v_after_id := v_row.id;
      if app.execute_automation(p_auto, v_row.id, 'due:' || v_row.id || ':' || v_row.due_at) is not null then
        v_count := v_count + 1;
      end if;
    end loop;
    v_scanned := v_scanned + v_page;
    exit when v_page < 200 or v_scanned >= 20000;
  end loop;
  return v_count;
end;
$$;

create or replace function app.run_scheduled_automations() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_auto public.automations%rowtype;
  v_count integer := 0;
begin
  for v_auto in
    select a.* from public.automations a
     where a.is_active and a.trigger_type in ('no_activity', 'stuck_in_stage', 'birthday', 'task_due_soon')
       and app.org_writable(a.organization_id)
  loop
    begin
      if v_auto.trigger_type = 'no_activity' and v_auto.entity_type in ('lead', 'contact', 'company', 'deal') then
        v_count := v_count + app.scheduled_no_activity(v_auto);
      elsif v_auto.trigger_type = 'stuck_in_stage' and v_auto.entity_type = 'deal' then
        v_count := v_count + app.scheduled_stuck_in_stage(v_auto);
      elsif v_auto.trigger_type = 'birthday' and v_auto.entity_type = 'contact' then
        v_count := v_count + app.scheduled_birthday(v_auto);
      elsif v_auto.trigger_type = 'task_due_soon' and v_auto.entity_type = 'task' then
        v_count := v_count + app.scheduled_task_due_soon(v_auto);
      end if;
    exception when others then
      raise warning 'scheduled automation % failed: %', v_auto.id, sqlerrm;
    end;
  end loop;

  delete from public.outbox_events where processed_at < now() - interval '30 days';
  delete from public.automation_runs where created_at < now() - interval '90 days';
  return v_count;
end;
$$;

revoke all on function app.scheduled_no_activity(public.automations) from public, anon, authenticated;
revoke all on function app.scheduled_stuck_in_stage(public.automations) from public, anon, authenticated;
revoke all on function app.scheduled_birthday(public.automations) from public, anon, authenticated;
revoke all on function app.scheduled_task_due_soon(public.automations) from public, anon, authenticated;
revoke all on function app.run_scheduled_automations() from public, anon, authenticated;
grant execute on function app.run_scheduled_automations() to service_role;
