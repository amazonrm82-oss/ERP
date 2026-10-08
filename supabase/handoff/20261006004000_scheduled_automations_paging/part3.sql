-- 20261006004000_scheduled_automations_paging: part 3 of 3. Run the parts in order.
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
