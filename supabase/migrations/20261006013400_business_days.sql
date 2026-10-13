-- =============================================================================
-- Business days (HEB-03)
-- =============================================================================
-- "In 3 business days" for tasks, automations, and later quote validity and
-- payment due dates (QUO / PAY call the same function when they are built).
--
-- app.add_business_days(org, from_date, n): the day n working days after
-- from_date, skipping the organization's rest days (app.org_rest_day(): weekly
-- rest days, holidays, eves and occasions of its CAL-03 settings).
--   n = 0   from_date when it is a working day, else the next working day
--   n < 0 or n > 1000   refused (22023, hint business_days:range)
--   more than 366 rest days in a row   refused (22023, hint business_days:no_working_day);
--           cannot happen with today's settings (a business works at least one weekday)
--           but keeps a loop from running forever
--   a null argument   null
-- Mirrored by addBusinessDays() in src/features/calendar-days/business-days.ts
-- (tests/db compares the two day by day; keep them in step). It reads the
-- calendar settings once and decides each day with app.rest_day_with().
--
-- Automations: the create_task action may carry "due_in_business_days" (a whole
-- number 0..60). app.run_automation_actions() then sets the task's due time to
-- that business day at the current local time of day in the organization's
-- zone. Any other value is ignored (the task falls back to due_in_days /
-- due_in_minutes, which the builder never writes alongside it, else no due time)
-- and the step is logged 'ok' with "warning": 'the business-day offset is
-- invalid'. Rules without the key are unchanged (calendar days stay the default).
-- Only the create_task branch and the warning on the step log change; the rest of
-- the function is the body of 0095. Safe to run twice.

-- app.rest_day_with(day, weekdays, holidays, eves, occasions): the rule of
-- app.org_rest_day() with the settings passed in, so a caller that walks many
-- days reads the settings once. Keep the two in step.
create or replace function app.rest_day_with(p_day date, p_weekdays smallint[], p_holidays boolean,
                                             p_eves boolean, p_occasions text[]) returns boolean
language plpgsql stable
set search_path = ''
as $$
begin
  if exists (select 1 from app.israel_occasions(p_day) o
              where (o.kind = 'rest' and p_holidays) or (o.kind = 'erev' and p_eves) or o.key = any (p_occasions)) then
    return true;
  end if;
  -- the app keeps a business working at least one day (restDays())
  if cardinality(p_weekdays) >= 7 then
    p_weekdays := '{5,6}';
  end if;
  return extract(dow from p_day)::smallint = any (p_weekdays);
end;
$$;

revoke all on function app.rest_day_with(date, smallint[], boolean, boolean, text[]) from public, anon, authenticated;

create or replace function app.add_business_days(p_org uuid, p_from date, p_n integer) returns date
language plpgsql stable
set search_path = ''
as $$
declare
  v_day date := p_from;
  v_left integer := p_n;
  v_off integer := 0;
  -- the defaults of app.org_rest_day() when the business has no settings row
  v_weekdays smallint[] := '{5,6}';
  v_holidays boolean := true;
  v_eves boolean := false;
  v_occasions text[] := '{}';
  v_row record;
begin
  if p_org is null or p_from is null or p_n is null then
    return null;
  end if;
  if p_n < 0 or p_n > 1000 then
    raise exception 'business days must be between 0 and 1000'
      using errcode = '22023', hint = 'business_days:range';
  end if;
  select c.rest_weekdays, c.holidays_rest, c.holiday_eves_rest, c.rest_occasions into v_row
    from public.org_calendar_settings c
   where c.organization_id = p_org;
  if found then
    v_weekdays := v_row.rest_weekdays;
    v_holidays := v_row.holidays_rest;
    v_eves := v_row.holiday_eves_rest;
    v_occasions := v_row.rest_occasions;
  end if;
  if v_left > 0 then
    v_day := v_day + 1;
  end if;
  loop
    if app.rest_day_with(v_day, v_weekdays, v_holidays, v_eves, v_occasions) then
      v_off := v_off + 1;
      if v_off > 366 then
        raise exception 'no working day within 366 days'
          using errcode = '22023', hint = 'business_days:no_working_day';
      end if;
    else
      v_off := 0;
      if v_left <= 1 then
        return v_day;
      end if;
      v_left := v_left - 1;
    end if;
    v_day := v_day + 1;
  end loop;
end;
$$;

revoke all on function app.add_business_days(uuid, date, integer) from public, anon, authenticated;

-- app.run_automation_actions: the body of 0095 with the create_task due time above
create or replace function app.run_automation_actions(p_auto public.automations, p_entity text, p_id uuid) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_org uuid := p_auto.organization_id;
  v_table text := app.automation_table(p_entity);
  v_record jsonb;
  v_action jsonb;
  v_type text;
  v_steps jsonb := '[]'::jsonb;
  v_name text;
  v_title text;
  v_user uuid;
  v_id uuid;
  v_due timestamptz;
  v_task_type text;
  v_count integer;
  v_kind public.lead_status_kind;
  v_reason text;
  v_warning text;
  v_zone text;
  v_local timestamp;
begin
  for v_action in select * from jsonb_array_elements(p_auto.actions) loop
    v_type := v_action ->> 'type';
    v_record := app.automation_record(p_entity, v_org, p_id);
    v_name := app.automation_display_name(v_record);
    begin
      if v_record is null then
        raise exception 'the record no longer exists';
      end if;

      if v_type = 'create_task' then
        v_title := left(replace(coalesce(nullif(btrim(v_action ->> 'title'), ''), 'משימה'), '{{name}}', v_name), 300);
        v_due := null;
        v_warning := null;
        -- HEB-03: due in N business days (0..60), at the current local time of day
        if v_action ? 'due_in_business_days' then
          if jsonb_typeof(v_action -> 'due_in_business_days') = 'number'
             and (v_action ->> 'due_in_business_days')::numeric between 0 and 60
             and (v_action ->> 'due_in_business_days')::numeric = trunc((v_action ->> 'due_in_business_days')::numeric) then
            select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = v_org;
            v_zone := coalesce(v_zone, 'Asia/Jerusalem');
            v_local := now() at time zone v_zone;
            v_due := (app.add_business_days(v_org, v_local::date, (v_action ->> 'due_in_business_days')::numeric::int) + v_local::time)
                     at time zone v_zone;
          else
            v_warning := 'the business-day offset is invalid';
          end if;
        end if;
        if v_due is null and (v_action ? 'due_in_minutes' or v_action ? 'due_in_days') then
          v_due := now()
            + make_interval(mins => coalesce((v_action ->> 'due_in_minutes')::int, 0))
            + make_interval(days => coalesce((v_action ->> 'due_in_days')::int, 0));
        end if;
        v_user := case when v_action ->> 'assign' = 'user'
                       then app.automation_member(v_org, (v_action ->> 'user_id')::uuid)
                       else app.automation_member(v_org, (v_record ->> 'owner_id')::uuid) end;
        v_task_type := case when v_action ->> 'task_type' in ('todo', 'call', 'meeting', 'follow_up')
                            then v_action ->> 'task_type' else 'todo' end;
        insert into public.tasks (organization_id, title, task_type, due_at, owner_id, lead_id, contact_id, company_id, deal_id)
        values (
          v_org, v_title, v_task_type, v_due, v_user,
          case when p_entity = 'lead' then p_id when p_entity = 'task' then (v_record ->> 'lead_id')::uuid end,
          case when p_entity = 'contact' then p_id when p_entity in ('task', 'deal') then (v_record ->> 'contact_id')::uuid end,
          case when p_entity = 'company' then p_id when p_entity = 'task' then (v_record ->> 'company_id')::uuid end,
          case when p_entity = 'deal' then p_id when p_entity = 'task' then (v_record ->> 'deal_id')::uuid end);

      elsif v_type = 'notify' then
        v_title := left(replace(coalesce(nullif(btrim(v_action ->> 'title'), ''), 'עדכון מאוטומציה'), '{{name}}', v_name), 200);
        if v_action ->> 'to' = 'admins' then
          insert into public.notifications (organization_id, user_id, type, title, entity_type, entity_id)
          select v_org, m.user_id, 'automation', v_title, p_entity, p_id
            from public.memberships m
           where m.organization_id = v_org and m.status = 'active' and m.role in ('owner', 'admin');
          get diagnostics v_count = row_count;
        else
          v_user := case when v_action ->> 'to' = 'user'
                         then app.automation_member(v_org, (v_action ->> 'user_id')::uuid)
                         else app.automation_member(v_org, (v_record ->> 'owner_id')::uuid) end;
          v_count := 0;
          if v_user is not null then
            insert into public.notifications (organization_id, user_id, type, title, entity_type, entity_id)
            values (v_org, v_user, 'automation', v_title, p_entity, p_id);
            v_count := 1;
          end if;
        end if;
        if v_count = 0 then
          raise exception 'nobody to notify';
        end if;

      elsif v_type = 'assign_owner' then
        if v_action ->> 'mode' = 'round_robin' then
          if (v_action ->> 'team_id') is not null and not exists (
            select 1 from public.teams t where t.organization_id = v_org and t.id = (v_action ->> 'team_id')::uuid) then
            raise exception 'the team no longer exists';
          end if;
          v_user := app.next_lead_owner(v_org, (v_action ->> 'team_id')::uuid);
          if v_user is null then
            raise exception 'nobody is available';
          end if;
        else
          v_user := app.automation_member(v_org, (v_action ->> 'user_id')::uuid);
          if v_user is null then
            raise exception 'the user is not an active member';
          end if;
        end if;
        execute format('update public.%I set owner_id = $1 where organization_id = $2 and id = $3', v_table)
          using v_user, v_org, p_id;

      elsif v_type = 'add_tag' then
        if p_entity = 'task' then
          raise exception 'tasks have no tags';
        end if;
        select t.id into v_id from public.tags t where t.organization_id = v_org and t.id = (v_action ->> 'tag_id')::uuid;
        if v_id is null then
          raise exception 'the tag no longer exists';
        end if;
        execute format(
          'update public.%I set tag_ids = case when $1 = any (tag_ids) then tag_ids else array_append(tag_ids, $1) end
            where organization_id = $2 and id = $3', v_table)
          using v_id, v_org, p_id;

      elsif v_type = 'set_lead_status' then
        if p_entity <> 'lead' then
          raise exception 'only for leads';
        end if;
        select s.id, s.kind into v_id, v_kind from public.lead_statuses s
         where s.organization_id = v_org and s.id = (v_action ->> 'status_id')::uuid and s.kind <> 'converted';
        if v_id is null then
          raise exception 'the status no longer exists';
        end if;
        v_warning := null;
        if v_kind = 'disqualified' then
          -- the reason is kept by id and read by name now, so a renamed reason still works;
          -- only an active reason of this organization counts (a hidden, deleted or foreign id does not)
          v_reason := null;
          -- absent, null, empty or blank: no reason was set (an old rule); anything else is looked up
          if nullif(btrim(v_action ->> 'reason_id'), '') is null then
            v_warning := 'no reason is set';
          else
            select r.name into v_reason from public.disqualify_reasons r
             where r.organization_id = v_org and r.is_active
               and r.id::text = (v_action ->> 'reason_id');
            if v_reason is null then
              v_warning := 'the reason no longer exists';
            end if;
          end if;
          -- status and reason in one update: leads_disqualify_reason keeps a reason a server write sets
          -- together with the move, and clears the old one when none is given
          if v_reason is not null then
            update public.leads set status_id = v_id, disqualify_reason = v_reason where organization_id = v_org and id = p_id;
          else
            update public.leads set status_id = v_id where organization_id = v_org and id = p_id;
          end if;
        else
          update public.leads set status_id = v_id where organization_id = v_org and id = p_id;
        end if;

      elsif v_type = 'move_deal_stage' then
        if p_entity <> 'deal' then
          raise exception 'only for deals';
        end if;
        select s.id into v_id from public.stages s
         where s.organization_id = v_org and s.id = (v_action ->> 'stage_id')::uuid
           and s.pipeline_id = (v_record ->> 'pipeline_id')::uuid;
        if v_id is null then
          raise exception 'the stage is not in this deal''s pipeline';
        end if;
        update public.deals set stage_id = v_id where organization_id = v_org and id = p_id;

      else
        raise exception 'unknown action %', coalesce(v_type, '(none)');
      end if;

      v_steps := v_steps || jsonb_build_array(
        jsonb_build_object('action', v_type, 'status', 'ok')
        || case when v_type in ('set_lead_status', 'create_task') and v_warning is not null
                then jsonb_build_object('warning', v_warning) else '{}'::jsonb end);
    exception when others then
      v_steps := v_steps || jsonb_build_array(jsonb_build_object('action', v_type, 'status', 'error', 'error', left(sqlerrm, 300)));
    end;
  end loop;
  return v_steps;
end;
$$;

revoke all on function app.run_automation_actions(public.automations, text, uuid) from public, anon, authenticated;
