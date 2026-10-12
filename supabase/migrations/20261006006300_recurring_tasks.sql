-- =============================================================================
-- Recurring tasks (TASK-04)
-- =============================================================================
-- * tasks.recurrence (jsonb, null = a one-off task) says how the task repeats:
--     {"kind": "daily"}                               every day
--     {"kind": "weekly",  "weekdays": [0, 2]}         on these weekdays (0 = Sunday)
--     {"kind": "monthly", "day": 31}                  on this day of the month,
--                                                     the last day in a shorter month
--     {"kind": "after_done", "days": 3}               N days after it was completed
--   optionally with an end: "until": "YYYY-MM-DD" (no task after that date, in
--   the organization's time zone) and/or "left": N (how many more tasks will be
--   created; the last one is a plain task). The shape is checked by a constraint
--   and mirrored in src/features/tasks/recurrence.ts; keep the two in step.
-- * Whoever may edit the task may set or clear its recurrence (the tasks update
--   policy is unchanged). Clearing it stops the series.
-- * When a recurring task becomes done, trigger tasks_spawn_recurrence creates
--   the next one: same title, description, type, priority, assignee, team and
--   linked records; due date from the rule, at the same local time of day in the
--   organization's time zone (so 09:00 stays 09:00 across a clock change); a
--   reminder keeps its offset before the due time. A fixed schedule continues
--   from the due date but never lands before today (a late completion does not
--   create a task that is already overdue). A task without a due date counts
--   from today, at 09:00.
-- * Exactly one successor per task: tasks.recurrence_source_id points at the
--   completed task and is unique per organization, so reopening and completing
--   again creates nothing new. Only the server writes recurrence_source_id
--   (no client grant on it; every other column keeps its grant).
-- * The successor is an ordinary new task: notify_assignment, the audit log and
--   automations see a normal insert (no change to those functions). Its creator
--   is the creator of the series (trigger tasks_touch_recurrence, which runs
--   after tasks_touch), so whoever handed the task out keeps seeing it.
-- * Nothing is created when the organization is read-only or the task is in the
--   recycle bin.
-- Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- Columns
-- ----------------------------------------------------------------------------
alter table public.tasks add column if not exists recurrence jsonb;
alter table public.tasks add column if not exists recurrence_source_id uuid;

alter table public.tasks
  drop constraint if exists tasks_recurrence_shape,
  -- coalesce: a missing key makes a test null, and a null check passes
  add constraint tasks_recurrence_shape check (
    recurrence is null or coalesce((
      jsonb_typeof(recurrence) = 'object'
      and (recurrence - array['kind', 'weekdays', 'day', 'days', 'until', 'left']) = '{}'::jsonb
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
    ), false)
  );

alter table public.tasks
  drop constraint if exists tasks_organization_id_recurrence_source_id_fkey,
  add constraint tasks_organization_id_recurrence_source_id_fkey foreign key (organization_id, recurrence_source_id)
    references public.tasks (organization_id, id) on delete set null (recurrence_source_id);

create unique index if not exists tasks_recurrence_source_idx
  on public.tasks (organization_id, recurrence_source_id) where recurrence_source_id is not null;

-- ----------------------------------------------------------------------------
-- Grants: every column as before, plus recurrence; recurrence_source_id is the
-- server's. (A table-wide revoke also clears column grants.)
-- ----------------------------------------------------------------------------
revoke insert, update on public.tasks from authenticated;

grant insert (
  id, organization_id, title, description, task_type, due_at, remind_at, reminded_at, priority, status,
  completed_at, outcome, owner_id, team_id, lead_id, contact_id, company_id, deal_id,
  created_by, updated_by, created_at, updated_at, deleted_at, recurrence
) on public.tasks to authenticated;

grant update (
  id, organization_id, title, description, task_type, due_at, remind_at, reminded_at, priority, status,
  completed_at, outcome, owner_id, team_id, lead_id, contact_id, company_id, deal_id,
  created_by, updated_by, created_at, updated_at, deleted_at, recurrence
) on public.tasks to authenticated;

-- ----------------------------------------------------------------------------
-- The next date of a fixed schedule, strictly after p_after (a local date).
-- Mirrors nextDate() in src/features/tasks/recurrence.ts.
-- ----------------------------------------------------------------------------
create or replace function app.recurrence_next_date(p_rule jsonb, p_after date) returns date
language plpgsql immutable strict
set search_path = ''
as $$
declare
  v_day int;
  v_month date;
  v_candidate date;
  i int;
begin
  case p_rule ->> 'kind'
    when 'daily' then
      return p_after + 1;
    when 'weekly' then
      for i in 1..7 loop
        if (p_rule -> 'weekdays') @> to_jsonb(extract(dow from p_after + i)::int) then
          return p_after + i;
        end if;
      end loop;
      return null;
    when 'monthly' then
      v_day := (p_rule ->> 'day')::int;
      v_month := date_trunc('month', p_after)::date;
      for i in 0..1 loop
        v_candidate := (v_month + make_interval(months => i))::date;
        v_candidate := v_candidate
          + (least(v_day, extract(day from (v_candidate + interval '1 month' - interval '1 day'))::int) - 1);
        if v_candidate > p_after then
          return v_candidate;
        end if;
      end loop;
      return null;
    when 'after_done' then
      return p_after + (p_rule ->> 'days')::int;
    else
      return null;
  end case;
end;
$$;
revoke all on function app.recurrence_next_date(jsonb, date) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Completing a recurring task creates the next one
-- ----------------------------------------------------------------------------
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

create or replace trigger tasks_spawn_recurrence
  after update of status on public.tasks
  for each row
  when (new.status = 'done' and old.status is distinct from 'done' and new.recurrence is not null)
  execute function app.spawn_recurring_task();

-- ----------------------------------------------------------------------------
-- The next task keeps the creator of the series (tasks_touch stamps the
-- session's user; this runs after it, by name order). Only the server can set
-- recurrence_source_id, so a client insert never reaches the copy.
-- ----------------------------------------------------------------------------
create or replace function app.recurrence_keep_creator() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.recurrence_source_id is not null then
    select coalesce(t.created_by, new.created_by) into new.created_by
      from public.tasks t
     where t.organization_id = new.organization_id and t.id = new.recurrence_source_id;
  end if;
  return new;
end;
$$;
revoke all on function app.recurrence_keep_creator() from public, anon, authenticated;

create or replace trigger tasks_touch_recurrence
  before insert on public.tasks
  for each row
  when (new.recurrence_source_id is not null)
  execute function app.recurrence_keep_creator();
