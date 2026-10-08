-- 20261006004000_scheduled_automations_paging: part 1 of 3. Run the parts in order.
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
