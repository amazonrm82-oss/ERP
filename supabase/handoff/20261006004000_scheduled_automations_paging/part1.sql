-- 20261006004000_scheduled_automations_paging: part 1 of 2. Run the parts in order.
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
-- The body is otherwise as in 0009. Every statement is safe to run twice.

create or replace function app.run_scheduled_automations() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_auto public.automations%rowtype;
  v_row record;
  v_days integer;
  v_minutes integer;
  v_table text;
  v_fk text;
  v_extra text;
  v_count integer := 0;
  v_page integer;
  v_scanned integer;
  -- the cursor: the last record of the previous page
  v_after_at timestamptz;
  v_after_id uuid;
  v_after_day text;
  c_page constant integer := 200;
  c_max_scan constant integer := 20000;
begin
  for v_auto in
    select a.* from public.automations a
     where a.is_active and a.trigger_type in ('no_activity', 'stuck_in_stage', 'birthday', 'task_due_soon')
       and app.org_writable(a.organization_id)
  loop
    begin
      v_scanned := 0;
      v_after_at := '-infinity';
      v_after_id := '00000000-0000-0000-0000-000000000000';

      if v_auto.trigger_type = 'no_activity' and v_auto.entity_type in ('lead', 'contact', 'company', 'deal') then
        v_days := greatest(coalesce((v_auto.trigger_config ->> 'days')::int, 3), 1);
        v_table := app.automation_table(v_auto.entity_type);
        v_fk := v_auto.entity_type || '_id';
        v_extra := case v_auto.entity_type when 'lead' then ' and t.converted_at is null'
                                           when 'deal' then ' and t.status = ''open''' else '' end;
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
             limit $6', v_fk, v_table, v_extra)
            using v_auto.organization_id, v_days, v_after_at, v_after_id, v_auto.id, c_page
          loop
            v_page := v_page + 1;
            v_after_at := v_row.last_at;
            v_after_id := v_row.id;
            if app.execute_automation(v_auto, v_row.id, 'noact:' || v_row.id || ':' || v_row.last_at) is not null then
              v_count := v_count + 1;
            end if;
          end loop;
          v_scanned := v_scanned + v_page;
          exit when v_page < c_page or v_scanned >= c_max_scan;
        end loop;

      elsif v_auto.trigger_type = 'stuck_in_stage' and v_auto.entity_type = 'deal' then
        v_days := greatest(coalesce((v_auto.trigger_config ->> 'days')::int, 14), 1);
        loop
          v_page := 0;
          for v_row in
            select d.id, d.stage_entered_at from public.deals d
             where d.organization_id = v_auto.organization_id and d.deleted_at is null and d.status = 'open'
               and d.stage_entered_at < now() - make_interval(days => v_days)
               and (d.stage_entered_at, d.id) > (v_after_at, v_after_id)
               and not exists (select 1 from public.automation_runs r
                                where r.automation_id = v_auto.id and r.run_key = 'stuck:' || d.id || ':' || d.stage_entered_at)
             order by d.stage_entered_at, d.id
             limit c_page
          loop
            v_page := v_page + 1;
            v_after_at := v_row.stage_entered_at;
            v_after_id := v_row.id;
            if app.execute_automation(v_auto, v_row.id, 'stuck:' || v_row.id || ':' || v_row.stage_entered_at) is not null then
              v_count := v_count + 1;
            end if;
          end loop;
          v_scanned := v_scanned + v_page;
          exit when v_page < c_page or v_scanned >= c_max_scan;
        end loop;

      elsif v_auto.trigger_type = 'birthday' and v_auto.entity_type = 'contact' then
        loop
          v_page := 0;
          for v_row in
            select c.id, to_char(now() at time zone o.timezone, 'YYYY') as year
              from public.contacts c join public.organizations o on o.id = c.organization_id
             where c.organization_id = v_auto.organization_id and c.deleted_at is null and c.birth_date is not null
               and to_char(c.birth_date, 'MM-DD') = to_char(now() at time zone o.timezone, 'MM-DD')
               and c.id > v_after_id
             order by c.id
             limit c_page
          loop
            v_page := v_page + 1;
            v_after_id := v_row.id;
            if app.execute_automation(v_auto, v_row.id, 'bday:' || v_row.id || ':' || v_row.year) is not null then
              v_count := v_count + 1;
            end if;
          end loop;
          v_scanned := v_scanned + v_page;
          exit when v_page < c_page or v_scanned >= c_max_scan;
        end loop;

      elsif v_auto.trigger_type = 'task_due_soon' and v_auto.entity_type = 'task' then
        v_minutes := least(greatest(coalesce((v_auto.trigger_config ->> 'minutes')::int, 60), 5), 10080);
        loop
          v_page := 0;
          for v_row in
            select t.id, t.due_at from public.tasks t
             where t.organization_id = v_auto.organization_id and t.deleted_at is null and t.status = 'open'
               and t.due_at between now() and now() + make_interval(mins => v_minutes)
               and (t.due_at, t.id) > (v_after_at, v_after_id)
             order by t.due_at, t.id
             limit c_page
          loop
            v_page := v_page + 1;
            v_after_at := v_row.due_at;
            v_after_id := v_row.id;
            if app.execute_automation(v_auto, v_row.id, 'due:' || v_row.id || ':' || v_row.due_at) is not null then
              v_count := v_count + 1;
            end if;
          end loop;
          v_scanned := v_scanned + v_page;
          exit when v_page < c_page or v_scanned >= c_max_scan;
        end loop;
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
