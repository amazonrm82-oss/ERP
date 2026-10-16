-- =============================================================================
-- Automations: a step that updates one field of the record (AUT-01)
-- =============================================================================
-- app.run_automation_actions (body of lead_distribution_review_fixes, 019640) gains the action
--   {"type": "set_field", "field": "cf:<key>" | "source_id" | "task_type", "value": <json> | null}
-- * "cf:<key>": an active custom field of the record's type (leads, contacts, companies, deals). The value is
--   checked as a person's write is (app.custom_value_ok; a "user" field holds a member of the organization); a
--   filled read-only field (FLD-07) is not changed; a unique field (FLD-07) is judged inside the step, so a value
--   another record holds fails the step ("the value is already on another record") and not the whole run. Null or
--   no value clears the field.
-- * "source_id" (leads, contacts, deals): an active source of the organization, or null to clear.
-- * "task_type" (tasks): todo | call | meeting | follow_up.
-- Status, stage, owner and tags keep their own actions (their rules live there). The change is made like every
-- automation change (marked as made by the automation; the audit entry names the rule, PRM-01).
-- Every statement is safe to run twice. No drops, no row removal.

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
  -- CAP-08 review: the team the route chose (a rule's team or the step's) and the owner before the step
  v_route_team uuid;
  v_prev_owner uuid;
  v_set_owner uuid;
  -- AUT-01: the field a set_field step writes
  v_field text;
  v_key text;
  v_value jsonb;
  v_def uuid;
  v_field_type text;
  v_options jsonb;
  v_read_only boolean;
  v_unique boolean;
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
            select p.owner_id, p.rule_user, p.team_id into v_user, v_rule_user, v_route_team
              from app.lead_distribution_route(v_org, (v_action ->> 'team_id')::uuid, now(),
                                               app.lead_routing_context(v_org, p_id), '{}'::uuid[]) p;
          else
            v_user := app.next_lead_owner(v_org, (v_action ->> 'team_id')::uuid);
          end if;
          if v_rule_user is not null then
            -- a rule's person: the HEB-08 rule of a fixed person, as the "assign to a person" step
            -- the lead's team: the rule's person's by app.default_team()'s rule, else as it is
            v_id := app.member_default_team(v_org, v_rule_user);
            v_prev_owner := (v_record ->> 'owner_id')::uuid;
            v_set_owner := app.assign_lead_owner_auto(v_org, p_id, v_rule_user, coalesce(v_id, (v_record ->> 'team_id')::uuid));
            if v_set_owner is null then
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
            -- so the team is the person's whoever took the lead; only when the owner changed to the
            -- person or their deputy, or the lead had no owner before (review: a lead that stays with
            -- the owner it has keeps its team too)
            if v_id is not null
               and (v_prev_owner is null or (v_set_owner is not null and v_set_owner is distinct from v_prev_owner)) then
              update public.leads set team_id = v_id
               where organization_id = v_org and id = p_id and team_id is distinct from v_id;
            end if;
            v_user := null;
          elsif v_user is null then
            raise exception 'nobody is available';
          elsif p_entity = 'lead' then
            -- CAP-08 review: as intake does, the lead takes the team the route chose (a rule's team,
            -- else the step's), in the same statement as the owner, so default_team leaves it; no team
            -- chosen (the step names the whole business): the owner's default team, as before
            update public.leads
               set owner_id = v_user, team_id = coalesce(v_route_team, team_id)
             where organization_id = v_org and id = p_id;
            v_user := null;
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

      elsif v_type = 'set_field' then
        -- AUT-01: one field of the record: a custom field ("cf:<key>", any type, checked as a person's
        -- write is) or a built-in list field (source_id on leads, contacts and deals; task_type on tasks).
        -- An absent or null value clears the field (task_type cannot be empty).
        v_field := v_action ->> 'field';
        v_value := case when jsonb_typeof(v_action -> 'value') is distinct from 'null' then v_action -> 'value' end;
        if v_field like 'cf:%' then
          if p_entity not in ('lead', 'contact', 'company', 'deal') then
            raise exception 'the field does not fit this record';
          end if;
          v_key := substr(v_field, 4);
          v_def := null;
          select f.id, f.field_type, f.options, f.is_read_only, f.is_unique
            into v_def, v_field_type, v_options, v_read_only, v_unique
            from public.field_definitions f
           where f.organization_id = v_org and f.object_type = p_entity and f.key = v_key and f.is_active;
          if v_def is null then
            raise exception 'the field no longer exists';
          end if;
          if not app.custom_value_ok(v_field_type, v_options, v_value) then
            raise exception 'the value does not fit the field';
          end if;
          -- a "user" field holds a member of the record's organization (as app.check_custom_fields)
          if v_field_type = 'user' and v_value is not null and not exists (
            select 1 from public.memberships m
             where m.organization_id = v_org and m.user_id = (v_value #>> '{}')::uuid) then
            raise exception 'the value does not fit the field';
          end if;
          -- FLD-07: a filled read-only value stays (an empty one may be filled once)
          if v_read_only and not app.custom_value_empty(v_record -> 'custom_fields' -> v_key)
             and (v_record -> 'custom_fields' -> v_key) is distinct from v_value then
            raise exception 'the field is read-only';
          end if;
          -- FLD-07: a unique field is judged now, inside this step, as intake_submit does, so a taken
          -- value fails the step instead of the whole run at commit
          begin
            if v_unique then
              set constraints app.custom_unique_values_value immediate;
            end if;
            execute format(
              'update public.%I
                  set custom_fields = case when $1 is null then coalesce(custom_fields, ''{}''::jsonb) - $2
                                           else coalesce(custom_fields, ''{}''::jsonb) || jsonb_build_object($2, $1) end
                where organization_id = $3 and id = $4', v_table)
              using v_value, v_key, v_org, p_id;
            if v_unique then
              set constraints app.custom_unique_values_value deferred;
            end if;
          exception when unique_violation then
            -- (the rollback of this block restores the mode too; said again for clarity)
            set constraints app.custom_unique_values_value deferred;
            raise exception 'the value is already on another record';
          end;
        elsif v_field = 'source_id' then
          if p_entity not in ('lead', 'contact', 'deal') then
            raise exception 'the field does not fit this record';
          end if;
          v_id := null;
          if v_value is not null then
            select s.id into v_id from public.lead_sources s
             where s.organization_id = v_org and s.id::text = (v_value #>> '{}') and s.is_active;
            if v_id is null then
              raise exception 'the source no longer exists';
            end if;
          end if;
          execute format('update public.%I set source_id = $1 where organization_id = $2 and id = $3', v_table)
            using v_id, v_org, p_id;
        elsif v_field = 'task_type' then
          if p_entity <> 'task' then
            raise exception 'the field does not fit this record';
          end if;
          if v_value is null or (v_value #>> '{}') not in ('todo', 'call', 'meeting', 'follow_up') then
            raise exception 'the value does not fit the field';
          end if;
          update public.tasks set task_type = (v_value #>> '{}') where organization_id = v_org and id = p_id;
        else
          raise exception 'the field does not fit this record';
        end if;

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
