-- =============================================================================
-- Scheduled automations continue where the last run stopped (RVW-6)
-- =============================================================================
-- Since 0040 a scheduled rule pages through its records oldest first, at most
-- 20,000 per run, but every run started again from the oldest record. A record
-- whose conditions do not match leaves no row in automation_runs, so it was
-- scanned again in every run: with more than 20,000 dormant records that do not
-- match, a rule never reached the newer ones.
--
-- Fix: a cursor per rule. "No activity for X days" and "stuck in a stage" keep
-- the place where a run stopped in app.automation_scan_cursors and the next run
-- continues from there; a run that reaches the end of the list sets the cursor
-- back to the start, so the next run begins again from the oldest record. With
-- N records and a scan limit L, every record is looked at within ceil(N / L) + 1
-- runs. (Checking the rule's conditions inside the query instead would build the
-- full record of every candidate row in every run, with no bound on the work.)
-- * The cursor lives in schema app (no API access, no client grant). It is not a
--   column of public.automations: that table is audited and changing it every
--   15 minutes would fill the audit log. A cursor older than the rule's last
--   change is ignored, so an edited rule starts from the beginning.
-- * "Birthday today" and "task due soon" look only at a short time window (today,
--   the next X minutes), so they keep starting from the beginning; a carried
--   cursor would only delay records that are due now.
-- * The scan limit per run is app.scheduled_scan_limit(): the setting
--   app.scheduled_scan_limit when it is set (tests), at most and by default 20,000.
-- run_scheduled_automations() is unchanged. Every statement is safe to run twice.

create table if not exists app.automation_scan_cursors (
  automation_id   uuid primary key,
  organization_id uuid not null,
  after_at        timestamptz not null default '-infinity',
  after_id        uuid not null default '00000000-0000-0000-0000-000000000000',
  updated_at      timestamptz not null default now(),
  foreign key (organization_id, automation_id) references public.automations (organization_id, id) on delete cascade
);
revoke all on app.automation_scan_cursors from public, anon, authenticated;

create or replace function app.scheduled_scan_limit() returns integer
language sql stable
set search_path = ''
as $$
  select case when s ~ '^[0-9]{1,6}$' then least(greatest(s::int, 1), 20000) else 20000 end
    from coalesce(current_setting('app.scheduled_scan_limit', true), '') as s;
$$;
revoke all on function app.scheduled_scan_limit() from public, anon, authenticated;

-- where the rule's previous run stopped; the start when there is none, or when the rule changed since
create or replace function app.scan_cursor_get(p_auto public.automations, out after_at timestamptz, out after_id uuid)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  select c.after_at, c.after_id into after_at, after_id
    from app.automation_scan_cursors c
   where c.automation_id = p_auto.id and c.updated_at >= p_auto.updated_at;
  after_at := coalesce(after_at, '-infinity');
  after_id := coalesce(after_id, '00000000-0000-0000-0000-000000000000');
end;
$$;
revoke all on function app.scan_cursor_get(public.automations) from public, anon, authenticated;

create or replace function app.scan_cursor_set(p_auto public.automations, p_after_at timestamptz, p_after_id uuid) returns void
language sql security definer
set search_path = ''
as $$
  insert into app.automation_scan_cursors (automation_id, organization_id, after_at, after_id, updated_at)
  values (p_auto.id, p_auto.organization_id, p_after_at, p_after_id, now())
  on conflict (automation_id) do update
    set after_at = excluded.after_at, after_id = excluded.after_id, updated_at = excluded.updated_at;
$$;
revoke all on function app.scan_cursor_set(public.automations, timestamptz, uuid) from public, anon, authenticated;

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
  v_limit integer := app.scheduled_scan_limit();
  v_page_size integer := least(200, v_limit);
  v_after_at timestamptz;
  v_after_id uuid;
  v_days integer := greatest(coalesce((p_auto.trigger_config ->> 'days')::int, 3), 1);
  v_fk text := p_auto.entity_type || '_id';
  v_extra text := case p_auto.entity_type when 'lead' then ' and t.converted_at is null'
                                          when 'deal' then ' and t.status = ''open''' else '' end;
begin
  select c.after_at, c.after_id into v_after_at, v_after_id from app.scan_cursor_get(p_auto) c;
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
       limit $6', v_fk, app.automation_table(p_auto.entity_type), v_extra)
      using p_auto.organization_id, v_days, v_after_at, v_after_id, p_auto.id, v_page_size
    loop
      v_page := v_page + 1;
      v_after_at := v_row.last_at;
      v_after_id := v_row.id;
      if app.execute_automation(p_auto, v_row.id, 'noact:' || v_row.id || ':' || v_row.last_at) is not null then
        v_count := v_count + 1;
      end if;
    end loop;
    v_scanned := v_scanned + v_page;
    if v_page < v_page_size then
      -- the end of the list: the next run starts again from the oldest record
      perform app.scan_cursor_set(p_auto, '-infinity', '00000000-0000-0000-0000-000000000000');
      exit;
    end if;
    if v_scanned >= v_limit then
      perform app.scan_cursor_set(p_auto, v_after_at, v_after_id);
      exit;
    end if;
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
  v_limit integer := app.scheduled_scan_limit();
  v_page_size integer := least(200, v_limit);
  v_after_at timestamptz;
  v_after_id uuid;
  v_days integer := greatest(coalesce((p_auto.trigger_config ->> 'days')::int, 14), 1);
begin
  select c.after_at, c.after_id into v_after_at, v_after_id from app.scan_cursor_get(p_auto) c;
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
       limit v_page_size
    loop
      v_page := v_page + 1;
      v_after_at := v_row.stage_entered_at;
      v_after_id := v_row.id;
      if app.execute_automation(p_auto, v_row.id, 'stuck:' || v_row.id || ':' || v_row.stage_entered_at) is not null then
        v_count := v_count + 1;
      end if;
    end loop;
    v_scanned := v_scanned + v_page;
    if v_page < v_page_size then
      perform app.scan_cursor_set(p_auto, '-infinity', '00000000-0000-0000-0000-000000000000');
      exit;
    end if;
    if v_scanned >= v_limit then
      perform app.scan_cursor_set(p_auto, v_after_at, v_after_id);
      exit;
    end if;
  end loop;
  return v_count;
end;
$$;

-- "birthday today": contacts, in the organization's time zone (as in 0040, with the shared scan limit)
create or replace function app.scheduled_birthday(p_auto public.automations) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_count integer := 0;
  v_page integer;
  v_scanned integer := 0;
  v_limit integer := app.scheduled_scan_limit();
  v_page_size integer := least(200, v_limit);
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
       limit v_page_size
    loop
      v_page := v_page + 1;
      v_after_id := v_row.id;
      if app.execute_automation(p_auto, v_row.id, 'bday:' || v_row.id || ':' || v_row.year) is not null then
        v_count := v_count + 1;
      end if;
    end loop;
    v_scanned := v_scanned + v_page;
    exit when v_page < v_page_size or v_scanned >= v_limit;
  end loop;
  return v_count;
end;
$$;

-- "task due soon": open tasks due within the next X minutes (as in 0040, with the shared scan limit)
create or replace function app.scheduled_task_due_soon(p_auto public.automations) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_count integer := 0;
  v_page integer;
  v_scanned integer := 0;
  v_limit integer := app.scheduled_scan_limit();
  v_page_size integer := least(200, v_limit);
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
       limit v_page_size
    loop
      v_page := v_page + 1;
      v_after_at := v_row.due_at;
      v_after_id := v_row.id;
      if app.execute_automation(p_auto, v_row.id, 'due:' || v_row.id || ':' || v_row.due_at) is not null then
        v_count := v_count + 1;
      end if;
    end loop;
    v_scanned := v_scanned + v_page;
    exit when v_page < v_page_size or v_scanned >= v_limit;
  end loop;
  return v_count;
end;
$$;

revoke all on function app.scheduled_no_activity(public.automations) from public, anon, authenticated;
revoke all on function app.scheduled_stuck_in_stage(public.automations) from public, anon, authenticated;
revoke all on function app.scheduled_birthday(public.automations) from public, anon, authenticated;
revoke all on function app.scheduled_task_due_soon(public.automations) from public, anon, authenticated;
