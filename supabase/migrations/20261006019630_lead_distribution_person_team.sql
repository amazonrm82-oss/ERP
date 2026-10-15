-- =============================================================================
-- CAP-08: the team of a lead a rule sends to one person (owner, 14 October 2026)
-- =============================================================================
-- DECISIONS.md "כלל חלוקה לאדם: הצוות של הליד": the team follows the existing rule of
-- app.default_team(): the person's only team, else their primary team; with neither, the
-- form's (or the automation step's) team stays. Same function, not a new rule:
-- * app.member_default_team(org, user): that choice, taken out of app.default_team()
--   (body of primary_team 0055), which now calls it; behaviour unchanged.
--   (app.manages_meeting_organizer-related code in 0093 keeps its own inline copy.)
-- * app.lead_distribution_route (body of lead_distribution_rules_more 019120): a person rule's
--   team_id = app.member_default_team(person), else the caller's team. When the person is away
--   and their deputy takes the lead, the team is still the person's (the lead was meant for
--   them; HEB-08 says nothing about the team).
-- * app.run_automation_actions (body of 019120): after a rule's person (or their deputy) is
--   assigned, the lead's team is set to the person's default team when they have one (else it
--   stays as it is); the SPD-01 notices of an unowned lead go to that team too.
-- Every statement is safe to run twice.

-- The team a record owned by p_user joins: their only team in the organization, else their
-- primary team, else null.
create or replace function app.member_default_team(p_org uuid, p_user uuid) returns uuid
language sql stable security definer
set search_path = ''
as $$
  select case
           when count(*) = 1 then min(tm.team_id::text)::uuid
           else (min(tm.team_id::text) filter (where tm.is_primary))::uuid
         end
    from public.team_members tm
   where tm.organization_id = p_org and tm.user_id = p_user
$$;
revoke all on function app.member_default_team(uuid, uuid) from public, anon, authenticated;

-- app.default_team(): the body of primary_team (0055), the choice now in app.member_default_team.
create or replace function app.default_team() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_team uuid;
begin
  if new.owner_id is null then
    return new;
  end if;
  if tg_op = 'INSERT' and new.team_id is not null then
    return new;
  end if;
  if tg_op = 'UPDATE' and (new.owner_id is not distinct from old.owner_id or new.team_id is distinct from old.team_id) then
    return new;
  end if;
  v_team := app.member_default_team(new.organization_id, new.owner_id);
  if v_team is not null then
    new.team_id := v_team;
  end if;
  return new;
end;
$$;
revoke all on function app.default_team() from public, anon, authenticated;

-- app.lead_distribution_route: the body of lead_distribution_rules_more (019120).
create or replace function app.lead_distribution_route(
  p_org uuid, p_team uuid, p_at timestamptz, p_lead jsonb default null, p_excluded uuid[] default '{}',
  out turn_user uuid, out owner_id uuid, out turn_was timestamptz, out team_id uuid, out method text,
  out rule_user uuid, out absent_user uuid
)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_team uuid := p_team;
  v_rule_team uuid;
  v_rule_user uuid;
  v_owner uuid;
  v_absent uuid;
begin
  if p_org is not null and p_lead is not null and app.org_has_feature(p_org, 'lead_distribution') then
    select m.team_id, m.user_id into v_rule_team, v_rule_user from app.lead_rule_match(p_org, p_lead) m;
    if v_rule_user is not null then
      select a.owner_id, a.absent_user into v_owner, v_absent from app.auto_lead_owner(p_org, v_rule_user, coalesce(p_at, now())) a;
      owner_id := v_owner;
      absent_user := v_absent;
      rule_user := v_rule_user;
      -- the rule's person's team by app.default_team()'s rule (also when their deputy takes the
      -- lead: the lead was meant for them), else the caller's
      team_id := coalesce(app.member_default_team(p_org, v_rule_user), p_team);
      method := 'person';
      return;
    end if;
    v_team := coalesce(v_rule_team, p_team);
  end if;
  select p.turn_user, p.owner_id, p.turn_was, p.team_id, p.method
    into turn_user, owner_id, turn_was, team_id, method
    from app.lead_distribution_pick(p_org, v_team, p_at, null, coalesce(p_excluded, '{}'::uuid[])) p;
end;
$$;
revoke all on function app.lead_distribution_route(uuid, uuid, timestamptz, jsonb, uuid[]) from public, anon, authenticated;
grant execute on function app.lead_distribution_route(uuid, uuid, timestamptz, jsonb, uuid[]) to service_role;

-- app.run_automation_actions: the body of lead_distribution_rules_more (019120).
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
  v_warning_name text;
  v_kept uuid;
  v_zone text;
  v_local timestamp;
  -- CAP-08: a distribution rule that names one person
  v_rule_user uuid;
begin
  for v_action in select * from jsonb_array_elements(p_auto.actions) loop
    v_type := v_action ->> 'type';
    v_record := app.automation_record(p_entity, v_org, p_id);
    v_name := app.automation_display_name(v_record);
    v_warning_name := null;
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
        v_warning := null;
        if v_action ->> 'mode' = 'round_robin' then
          if (v_action ->> 'team_id') is not null and not exists (
            select 1 from public.teams t where t.organization_id = v_org and t.id = (v_action ->> 'team_id')::uuid) then
            raise exception 'the team no longer exists';
          end if;
          v_rule_user := null;
          if p_entity = 'lead' then
            -- CAP-08: the rules (source, requested product, language, list field; a team or one
            -- person), then the pick
            select p.owner_id, p.rule_user into v_user, v_rule_user
              from app.lead_distribution_route(v_org, (v_action ->> 'team_id')::uuid, now(),
                                               app.lead_routing_context(v_org, p_id), '{}'::uuid[]) p;
          else
            v_user := app.next_lead_owner(v_org, (v_action ->> 'team_id')::uuid);
          end if;
          if v_rule_user is not null then
            -- a rule's person: the HEB-08 rule of a fixed person, as the "assign to a person" step
            -- the lead's team: the rule's person's by app.default_team()'s rule, else as it is
            v_id := app.member_default_team(v_org, v_rule_user);
            if app.assign_lead_owner_auto(v_org, p_id, v_rule_user, coalesce(v_id, (v_record ->> 'team_id')::uuid)) is null then
              v_kept := null;
              select l.owner_id into v_kept from public.leads l where l.organization_id = v_org and l.id = p_id;
              if v_kept is not null then
                v_warning := 'the requested owner is away, the lead stays with its owner';
                v_warning_name := left(app.follow_person_name(v_kept), 200);
              else
                v_warning := 'the owner is away, the lead has no owner';
              end if;
            end if;
            -- set after the owner change (which applies default_team to the new owner, a deputy too),
            -- so the team is the person's whoever took the lead
            if v_id is not null then
              update public.leads set team_id = v_id
               where organization_id = v_org and id = p_id and team_id is distinct from v_id;
            end if;
            v_user := null;
          elsif v_user is null then
            raise exception 'nobody is available';
          end if;
        else
          v_user := app.automation_member(v_org, (v_action ->> 'user_id')::uuid);
          if v_user is null then
            raise exception 'the user is not an active member';
          end if;
          -- HEB-08: a lead goes through the one rule for automatic assignment of a fixed
          -- person (present: them; away: their deputy; away with none: no owner, and back to
          -- them on their return)
          if p_entity = 'lead' then
            v_warning := null;
            if app.assign_lead_owner_auto(v_org, p_id, v_user, (v_record ->> 'team_id')::uuid) is null then
              -- the lead keeps the owner it has (owner, 14 October 2026): say who it stays with
              v_kept := null;
              select l.owner_id into v_kept from public.leads l where l.organization_id = v_org and l.id = p_id;
              if v_kept is not null then
                v_warning := 'the requested owner is away, the lead stays with its owner';
                v_warning_name := left(app.follow_person_name(v_kept), 200);
              else
                v_warning := 'the owner is away, the lead has no owner';
              end if;
            end if;
            -- assigned (or left unowned) above
            v_user := null;
          end if;
        end if;
        if v_user is not null then
          execute format('update public.%I set owner_id = $1 where organization_id = $2 and id = $3', v_table)
            using v_user, v_org, p_id;
        end if;

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
        || case when v_type in ('set_lead_status', 'create_task', 'assign_owner') and v_warning is not null
                then jsonb_build_object('warning', v_warning) else '{}'::jsonb end
        || case when v_type = 'assign_owner' and v_warning is not null and v_warning_name is not null
                then jsonb_build_object('warning_name', v_warning_name) else '{}'::jsonb end);
    exception when others then
      v_steps := v_steps || jsonb_build_array(jsonb_build_object('action', v_type, 'status', 'error', 'error', left(sqlerrm, 300)));
    end;
  end loop;
  return v_steps;
end;
$$;
revoke all on function app.run_automation_actions(public.automations, text, uuid) from public, anon, authenticated;
