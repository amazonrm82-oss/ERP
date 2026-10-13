-- =============================================================================
-- Recurring tasks on working days only (HEB-02)
-- =============================================================================
-- HEB-02: task due dates skip the days the business does not work. A recurring
-- task's rule (tasks.recurrence, TASK-04) may carry "workdays": true. When it
-- does, the next task that completing one creates moves from a day the business
-- does not work (its CAL-03 rest days, holidays, eves and occasions, read by
-- app.add_business_days(org, day, 0), HEB-03) to the next working day, at the
-- same local time. The next task after that is computed from the moved date.
-- "until" is checked on the moved date (no task after the end date). The form
-- ticks the box for a new rule; a rule without the key (every existing rule)
-- behaves exactly as before. Only true is accepted (constraint).
-- Mirrored by nextTask() in src/features/tasks/recurrence.ts (a database test
-- compares the two day by day).
-- Changes: constraint tasks_recurrence_shape allows the key; the body of
-- app.spawn_recurring_task() is that of 0063 plus the move. No grant changes
-- (recurrence already has its column grants). Safe to run twice.

alter table public.tasks
  drop constraint if exists tasks_recurrence_shape,
  -- coalesce: a missing key makes a test null, and a null check passes
  add constraint tasks_recurrence_shape check (
    recurrence is null or coalesce((
      jsonb_typeof(recurrence) = 'object'
      and (recurrence - array['kind', 'weekdays', 'day', 'days', 'until', 'left', 'workdays']) = '{}'::jsonb
      and case recurrence ->> 'kind'
        when 'daily' then
          not (recurrence ?| array['weekdays', 'day', 'days'])
        when 'weekly' then
          not (recurrence ?| array['day', 'days'])
          and jsonb_typeof(recurrence -> 'weekdays') = 'array'
          and jsonb_array_length(recurrence -> 'weekdays') between 1 and 7
          and (recurrence -> 'weekdays') <@ '[0, 1, 2, 3, 4, 5, 6]'::jsonb
        when 'monthly' then
          not (recurrence ?| array['weekdays', 'days'])
          and jsonb_typeof(recurrence -> 'day') = 'number'
          and case when (recurrence ->> 'day') ~ '^[0-9]{1,2}$'
                   then (recurrence ->> 'day')::int between 1 and 31 else false end
        when 'after_done' then
          not (recurrence ?| array['weekdays', 'day'])
          and jsonb_typeof(recurrence -> 'days') = 'number'
          and case when (recurrence ->> 'days') ~ '^[0-9]{1,3}$'
                   then (recurrence ->> 'days')::int between 1 and 365 else false end
        else false
      end
      and case when recurrence ? 'until'
               then jsonb_typeof(recurrence -> 'until') = 'string'
                    and case when (recurrence ->> 'until') ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
                             then (recurrence ->> 'until')::date is not null else false end
               else true end
      and case when recurrence ? 'left'
               then jsonb_typeof(recurrence -> 'left') = 'number'
                    and case when (recurrence ->> 'left') ~ '^[0-9]{1,3}$'
                             then (recurrence ->> 'left')::int between 1 and 999 else false end
               else true end
      -- HEB-02: only true; a rule without it keeps every date as computed
      and case when recurrence ? 'workdays'
               then recurrence -> 'workdays' = 'true'::jsonb
               else true end
    ), false)
  );

create or replace function app.spawn_recurring_task() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_rule jsonb := new.recurrence;
  v_zone text;
  v_today date;
  v_from date;
  v_time time;
  v_next date;
  v_due timestamptz;
  v_remind timestamptz;
  v_left int;
  v_steps int := 0;
  v_moved date;
begin
  if v_rule is null or new.deleted_at is not null or not app.org_writable(new.organization_id) then
    return null;
  end if;

  select o.timezone into v_zone from public.organizations o where o.id = new.organization_id;
  if v_zone is null or not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = v_zone) then
    v_zone := 'Asia/Jerusalem';
  end if;

  v_today := (now() at time zone v_zone)::date;
  if new.due_at is not null then
    v_from := (new.due_at at time zone v_zone)::date;
    v_time := (new.due_at at time zone v_zone)::time;
  else
    v_from := v_today;
    v_time := time '09:00';
  end if;

  if v_rule ->> 'kind' = 'after_done' then
    v_next := app.recurrence_next_date(v_rule, v_today);
  else
    v_next := app.recurrence_next_date(v_rule, v_from);
    -- a late completion continues from today, not from the past
    while v_next is not null and v_next < v_today and v_steps < 5000 loop
      v_next := app.recurrence_next_date(v_rule, v_next);
      v_steps := v_steps + 1;
    end loop;
  end if;
  if v_next is null then
    return null;
  end if;

  -- HEB-02: "workdays" moves a date the business does not work on to its next
  -- working day (app.add_business_days with 0 = the day itself when it works).
  -- A business with no working day in reach (cannot happen with today's
  -- settings) keeps the date: completing a task never fails over this.
  if v_rule ? 'workdays' then
    begin
      v_moved := app.add_business_days(new.organization_id, v_next, 0);
    exception when sqlstate '22023' then
      v_moved := null;
    end;
    v_next := coalesce(v_moved, v_next);
  end if;

  -- no task after the end date, also when the move passed it
  if v_rule ? 'until' and v_next > (v_rule ->> 'until')::date then
    return null;
  end if;
  if v_rule ? 'left' then
    v_left := (v_rule ->> 'left')::int;
    if v_left <= 1 then
      v_rule := null;
    else
      v_rule := jsonb_set(v_rule, '{left}', to_jsonb(v_left - 1));
    end if;
  end if;

  -- the same wall-clock time on the new date, in the organization's zone
  v_due := (v_next + v_time) at time zone v_zone;
  if new.remind_at is not null and new.due_at is not null then
    v_remind := v_due - (new.due_at - new.remind_at);
  end if;

  insert into public.tasks (
    organization_id, title, description, task_type, due_at, remind_at, priority,
    owner_id, team_id, lead_id, contact_id, company_id, deal_id, recurrence, recurrence_source_id
  ) values (
    new.organization_id, new.title, new.description, new.task_type, v_due, v_remind, new.priority,
    new.owner_id, new.team_id, new.lead_id, new.contact_id, new.company_id, new.deal_id, v_rule, new.id
  )
  on conflict (organization_id, recurrence_source_id) where recurrence_source_id is not null do nothing;
  return null;
end;
$$;
revoke all on function app.spawn_recurring_task() from public, anon, authenticated;
