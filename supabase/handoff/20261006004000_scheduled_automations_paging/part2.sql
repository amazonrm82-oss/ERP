-- 20261006004000_scheduled_automations_paging: part 2 of 3. Run the parts in order.
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
