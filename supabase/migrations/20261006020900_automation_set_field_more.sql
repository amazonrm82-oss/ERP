-- =============================================================================
-- Automations: "set field" part B (AUT-01; owner's answers of 18 October 2026)
-- =============================================================================
-- app.run_automation_actions: the body of 20261006020610 (its latest) with only the set_field step changed:
-- * Built-in fields (owner, answer (ב)): preferred_channel and preferred_locale on leads and contacts (the CON-10 lists,
--   mirrored by CONTACT_CHANNELS / CONTACT_LOCALES; tests/unit/automation-set-field.test.ts reads this file), and
--   expected_close_date on deals. Never a name or a phone: an automation does not rewrite identity. A field on another
--   record type fails the step ('the field does not fit this record'), a value off the list fails it ('the value does not
--   fit the field'); null clears.
--   A channel the rule writes gets preferred_channel_source = 'manual' (the business's choice, as a person's), so a later
--   public form does not replace it; writing the channel it already has keeps its source; clearing clears both.
-- * A relative date (owner, yes): a date field (expected_close_date, a date or datetime custom field) may take
--   {"relative": {"days": N, "unit": "calendar" | "business"}}, N a whole number 0..365: today in the business's zone plus
--   N calendar days, or N working days by app.add_business_days (0 = today, or the next working day). A datetime field
--   keeps the current local time, to the minute. It is worked out when the step runs, so an AUT-06 retry works it out
--   again at the retry's time. An invalid one (N outside 0..365 or not whole, an unknown unit, no working day found)
--   leaves the field as it is and the step is ok with the warning 'the relative date is invalid' (STEP_WARNINGS); a
--   relative date on a field that is not a date fails the step ('the value does not fit the field').
-- * The step's warning is now kept on set_field steps too.
-- app.automation_relative_date(org, spec) is new (no grants; only the engine calls it).
-- Only creates or replaces functions; safe to run twice.

create or replace function app.automation_relative_date(p_org uuid, p_spec jsonb) returns date
language plpgsql stable
set search_path = ''
as $$
declare
  v_zone text;
  v_today date;
  v_days integer;
begin
  if jsonb_typeof(p_spec) is distinct from 'object'
     or jsonb_typeof(p_spec -> 'days') is distinct from 'number'
     or jsonb_typeof(p_spec -> 'unit') is distinct from 'string'
     or (p_spec ->> 'unit') not in ('calendar', 'business') then
    return null;
  end if;
  if (p_spec ->> 'days')::numeric < 0 or (p_spec ->> 'days')::numeric > 365
     or (p_spec ->> 'days')::numeric <> trunc((p_spec ->> 'days')::numeric) then
    return null;
  end if;
  v_days := (p_spec ->> 'days')::numeric::integer;
  select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = p_org;
  v_today := (now() at time zone coalesce(v_zone, 'Asia/Jerusalem'))::date;
  if p_spec ->> 'unit' = 'business' then
    begin
      return app.add_business_days(p_org, v_today, v_days);
    exception when raise_exception then
      -- no working day within 366 days
      return null;
    end;
  end if;
  return v_today + v_days;
end;
$$;
revoke all on function app.automation_relative_date(uuid, jsonb) from public, anon, authenticated, service_role;

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
  -- AUT-01 part B: a relative date
  v_relative boolean;
  v_date date;
  -- AUT-02: a create_deal step
  v_pipeline uuid;
  v_stage uuid;
  v_amount bigint;
  v_contact uuid;
  v_company uuid;
  v_hint text;
  v_note_lead uuid;
  v_note_deal uuid;
  -- DEAL-08 follow-up: a create_deal step that follows its source deal
  v_source public.deals;
  v_line public.deal_lines;
  v_skipped integer;
  v_claims text;
  v_claim_sub text;
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
        -- write is) or a built-in field (source_id on leads, contacts and deals; task_type on tasks; part B, owner
        -- 18 October 2026: preferred_channel and preferred_locale on leads and contacts, expected_close_date on deals;
        -- never a name or a phone: an automation does not rewrite identity).
        -- An absent or null value clears the field (task_type cannot be empty).
        -- Part B: a date field (expected_close_date, a date or datetime custom field) may take a relative date
        -- {"relative": {"days": 0..365, "unit": "calendar" | "business"}}, worked out when the step runs (an AUT-06 retry
        -- works it out again at its own time) from today in the business's zone (business days by app.add_business_days;
        -- 0 = today, or the next working day). An invalid one leaves the field as it is: the step is ok with a warning.
        v_warning := null;
        v_field := v_action ->> 'field';
        v_value := case when jsonb_typeof(v_action -> 'value') is distinct from 'null' then v_action -> 'value' end;
        v_relative := jsonb_typeof(v_value) = 'object' and v_value ? 'relative';
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
          -- part B: a relative date becomes the field's own value (a datetime keeps the current local time, to the minute)
          if v_relative then
            if v_field_type not in ('date', 'datetime') then
              raise exception 'the value does not fit the field';
            end if;
            v_date := app.automation_relative_date(v_org, v_value -> 'relative');
            if v_date is null then
              v_warning := 'the relative date is invalid';
            elsif v_field_type = 'date' then
              v_value := to_jsonb(to_char(v_date, 'YYYY-MM-DD'));
            else
              select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = v_org;
              v_zone := coalesce(v_zone, 'Asia/Jerusalem');
              v_local := date_trunc('minute', now() at time zone v_zone);
              v_value := to_jsonb(to_char(((v_date + v_local::time) at time zone v_zone) at time zone 'UTC',
                                          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
            end if;
          end if;
          if v_warning is null then
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
          end if;
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
          if p_entity not in ('task') then
            raise exception 'the field does not fit this record';
          end if;
          if v_value is null or (v_value #>> '{}') not in ('todo', 'call', 'meeting', 'follow_up') then
            raise exception 'the value does not fit the field';
          end if;
          update public.tasks set task_type = (v_value #>> '{}') where organization_id = v_org and id = p_id;
        elsif v_field = 'preferred_channel' then
          if p_entity not in ('lead', 'contact') then
            raise exception 'the field does not fit this record';
          end if;
          -- the CON-10 list (contacts_preferred_channel_check, leads_preferred_channel_check; CONTACT_CHANNELS)
          if v_value is not null and (jsonb_typeof(v_value) <> 'string'
             or (v_value #>> '{}') <> all (array['phone', 'whatsapp', 'email', 'sms'])) then
            raise exception 'the value does not fit the field';
          end if;
          -- a channel the rule writes is the business's choice, as a person's ('manual'), so a later public form keeps
          -- it (intake_submit replaces only an empty or form-set channel); the same channel again keeps its source, and
          -- clearing clears it (app.preferred_channel_source leaves a server write's source as given, empties it with
          -- the channel)
          execute format(
            'update public.%I
                set preferred_channel = $1,
                    preferred_channel_source = case when preferred_channel is distinct from $1 then ''manual''
                                                    else preferred_channel_source end
              where organization_id = $2 and id = $3', v_table)
            using v_value #>> '{}', v_org, p_id;
        elsif v_field = 'preferred_locale' then
          if p_entity not in ('lead', 'contact') then
            raise exception 'the field does not fit this record';
          end if;
          -- the CON-10 list (contacts_preferred_locale_check, leads_preferred_locale_check; CONTACT_LOCALES)
          if v_value is not null and (jsonb_typeof(v_value) <> 'string'
             or (v_value #>> '{}') <> all (array['he', 'ar', 'en', 'ru', 'am', 'fr', 'es'])) then
            raise exception 'the value does not fit the field';
          end if;
          execute format('update public.%I set preferred_locale = $1 where organization_id = $2 and id = $3', v_table)
            using v_value #>> '{}', v_org, p_id;
        elsif v_field = 'expected_close_date' then
          if p_entity not in ('deal') then
            raise exception 'the field does not fit this record';
          end if;
          v_date := null;
          if v_relative then
            v_date := app.automation_relative_date(v_org, v_value -> 'relative');
            if v_date is null then
              v_warning := 'the relative date is invalid';
            end if;
          elsif v_value is not null then
            if jsonb_typeof(v_value) <> 'string' or not app.custom_value_ok('date', '[]'::jsonb, v_value) then
              raise exception 'the value does not fit the field';
            end if;
            v_date := (v_value #>> '{}')::date;
          end if;
          if v_warning is null then
            update public.deals set expected_close_date = v_date where organization_id = v_org and id = p_id;
          end if;
        else
          raise exception 'the field does not fit this record';
        end if;

      elsif v_type = 'create_deal' then
        -- AUT-02: a new deal for the record's customer. A contact gives itself and its company, a company itself, a
        -- deal or a task its contact and company (a link to a record in the recycle bin is left out). A lead becomes
        -- a deal by conversion, not here. A deal made from a deal names it as the previous deal (DEAL-11).
        v_warning := null;
        if p_entity not in ('contact', 'company', 'deal', 'task') then
          raise exception 'a lead becomes a deal by conversion';
        end if;
        v_pipeline := null;
        v_stage := null;
        v_source := null;
        if p_entity = 'deal' then
          select d.* into v_source from public.deals d where d.organization_id = v_org and d.id = p_id;
        end if;
        -- DEAL-08 follow-up: "pipeline": "source" = the triggering deal's sales process, in its first open stage; when the
        -- trigger is not a deal, or that process is gone or has no open stage, the step's own pipeline_id rule below
        if v_action ->> 'pipeline' = 'source' and v_source.id is not null then
          select s.pipeline_id, s.id into v_pipeline, v_stage
            from public.stages s
            join public.pipelines p on p.organization_id = s.organization_id and p.id = s.pipeline_id
           where s.organization_id = v_org and s.pipeline_id = v_source.pipeline_id and s.kind = 'open' and p.deleted_at is null
           order by s.position, s.created_at, s.id
           limit 1;
        end if;
        if v_pipeline is null then
        select p.id into v_pipeline from public.pipelines p
         where p.organization_id = v_org and p.id::text = (v_action ->> 'pipeline_id') and p.deleted_at is null;
        if v_pipeline is null then
          raise exception 'the pipeline no longer exists';
        end if;
        v_stage := null;
        if nullif(btrim(v_action ->> 'stage_id'), '') is not null then
          select s.id into v_stage from public.stages s
           where s.organization_id = v_org and s.pipeline_id = v_pipeline and s.id::text = (v_action ->> 'stage_id')
             and s.kind = 'open';
          if v_stage is null then
            raise exception 'the stage is not an open stage of the pipeline';
          end if;
        else
          -- no stage chosen: the pipeline's first open stage
          select s.id into v_stage from public.stages s
           where s.organization_id = v_org and s.pipeline_id = v_pipeline and s.kind = 'open'
           order by s.position, s.created_at, s.id
           limit 1;
          if v_stage is null then
            raise exception 'the pipeline has no open stage';
          end if;
        end if;
        end if;
        -- the value in agorot: a whole number from 0 to 100,000,000,000 (a billion shekels); absent or null = empty
        v_amount := 0;
        if jsonb_typeof(v_action -> 'amount_agorot') is not null and jsonb_typeof(v_action -> 'amount_agorot') <> 'null' then
          if jsonb_typeof(v_action -> 'amount_agorot') <> 'number'
             or (v_action ->> 'amount_agorot')::numeric < 0
             or (v_action ->> 'amount_agorot')::numeric > 100000000000
             or (v_action ->> 'amount_agorot')::numeric <> trunc((v_action ->> 'amount_agorot')::numeric) then
            raise exception 'the amount is invalid';
          end if;
          v_amount := (v_action ->> 'amount_agorot')::numeric::bigint;
        end if;
        v_title := left(btrim(replace(coalesce(nullif(btrim(v_action ->> 'name'), ''), 'עסקה: {{name}}'), '{{name}}', v_name)), 200);
        if v_title = '' then
          v_title := 'עסקה';
        end if;
        if v_action ->> 'assign' = 'user' then
          v_user := app.automation_member(v_org, (v_action ->> 'user_id')::uuid);
          if v_user is null then
            raise exception 'the user is not an active member';
          end if;
        else
          v_user := app.automation_member(v_org, (v_record ->> 'owner_id')::uuid);
        end if;
        v_contact := case when p_entity = 'contact' then p_id
                          when p_entity in ('deal', 'task') then (v_record ->> 'contact_id')::uuid end;
        v_company := case when p_entity = 'company' then p_id else (v_record ->> 'company_id')::uuid end;
        if v_contact is not null and not exists (
          select 1 from public.contacts c where c.organization_id = v_org and c.id = v_contact and c.deleted_at is null) then
          v_contact := null;
        end if;
        if v_company is not null and not exists (
          select 1 from public.companies c where c.organization_id = v_org and c.id = v_company and c.deleted_at is null) then
          v_company := null;
        end if;
        -- DEAL-08 follow-up: "copy_from_source": true (deal triggers only) copies the source deal's recurring revenue. A
        -- recurring amount that followed the source's lines is left empty, so the copied lines fill it again (DLI-03);
        -- a typed one is copied as typed. The value follows the lines unless the step names an amount.
        if not (coalesce(v_action -> 'copy_from_source', 'false'::jsonb) = 'true'::jsonb and v_source.id is not null) then
          v_source := null;
        end if;
        begin
          insert into public.deals (organization_id, name, pipeline_id, stage_id, amount_agorot, owner_id, contact_id, company_id,
                                    previous_deal_id, billing_kind, recurring_amount_agorot, recurring_start_date, renewal_date)
          values (v_org, v_title, v_pipeline, v_stage, v_amount, v_user, v_contact, v_company,
                  case when p_entity = 'deal' then p_id end,
                  v_source.billing_kind,
                  case when v_source.billing_kind is not null and v_source.recurring_amount_auto is not true then v_source.recurring_amount_agorot end,
                  -- the next period: it starts on the source's renewal date and renews after the same term; never
                  -- the source's own renewal date, or a date rule on it would renew the copy again
                  case when v_source.billing_kind is not null then coalesce(v_source.renewal_date, v_source.recurring_start_date) end,
                  -- the term in whole months: the source's term rounded to the nearest month (15 days or more count as a
                  -- month), at least one, so a month end stays a month end (Postgres clamps the day)
                  case when v_source.billing_kind is not null and v_source.renewal_date > v_source.recurring_start_date
                       then (v_source.renewal_date + make_interval(months => greatest(1, (
                              extract(year from age(v_source.renewal_date::timestamp, v_source.recurring_start_date::timestamp)) * 12
                              + extract(month from age(v_source.renewal_date::timestamp, v_source.recurring_start_date::timestamp))
                              + case when extract(day from age(v_source.renewal_date::timestamp, v_source.recurring_start_date::timestamp)) >= 15
                                     then 1 else 0 end)::integer)))::date end)
          returning id into v_id;
        exception when sqlstate 'P0001' then
          get stacked diagnostics v_hint = pg_exception_hint;
          if v_hint = 'limit:max_records' then
            raise exception 'the plan record limit is reached';
          end if;
          raise;
        end;
        -- the source deal's lines, as they are (the deal_lines triggers judge each one; the run already marks its writes
        -- as an automation's, so nothing re-fires). A line the rules no longer let in (a product a person may not offer
        -- any more, a plan without products or discounts) is left out and the step says so; a line whose price list was
        -- removed keeps its price as a manual one.
        if v_source.id is not null then
          v_skipped := 0;
          -- the lines are copied as the server, the same whether the rule runs on its own or a person runs it now:
          -- with the person's session, deal_lines_check would skip every rule for a deal that person may not edit.
          -- The session is put back after the loop and on any error that leaves it.
          v_claims := current_setting('request.jwt.claims', true);
          v_claim_sub := current_setting('request.jwt.claim.sub', true);
          perform set_config('request.jwt.claims', '', true);
          perform set_config('request.jwt.claim.sub', '', true);
          begin
          for v_line in
            select l.* from public.deal_lines l
             where l.organization_id = v_org and l.deal_id = v_source.id
             order by l.position, l.created_at, l.id
          loop
            begin
              insert into public.deal_lines (organization_id, deal_id, position, product_id, description, quantity, unit_price_agorot,
                                             discount_bp, discount_agorot, price_includes_vat, vat_exempt, price_source, price_list_id,
                                             billing, currency)
              values (v_org, v_id, v_line.position, v_line.product_id, v_line.description, v_line.quantity, v_line.unit_price_agorot,
                      v_line.discount_bp, v_line.discount_agorot, v_line.price_includes_vat, v_line.vat_exempt,
                      case when v_line.price_source = 'price_list' and v_line.price_list_id is null then 'manual' else v_line.price_source end,
                      v_line.price_list_id, v_line.billing, v_line.currency);
            exception when raise_exception or integrity_constraint_violation or insufficient_privilege then
              v_skipped := v_skipped + 1;
            end;
          end loop;
          exception when others then
            perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
            perform set_config('request.jwt.claim.sub', coalesce(v_claim_sub, ''), true);
            raise;
          end;
          perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
          perform set_config('request.jwt.claim.sub', coalesce(v_claim_sub, ''), true);
          if v_skipped > 0 then
            v_warning := 'some lines were not copied';
          end if;
        end if;

      elsif v_type = 'create_note' then
        -- AUT-02: a note on the record's timeline (a task's note goes on the records the task is linked to). It is
        -- an 'automation_note', not a person's 'note': it is not contact with the customer (last contact, response
        -- time, activation, lead score) and does not count as activity for a "no activity" rule.
        v_title := left(btrim(replace(coalesce(v_action ->> 'body', ''), '{{name}}', v_name)), 2000);
        if v_title = '' then
          raise exception 'the note is empty';
        end if;
        -- the records the note goes on: the record itself, or a task's links that are not in the recycle bin
        v_note_lead := case when p_entity = 'lead' then p_id when p_entity = 'task' then (v_record ->> 'lead_id')::uuid end;
        v_contact := case when p_entity = 'contact' then p_id when p_entity = 'task' then (v_record ->> 'contact_id')::uuid end;
        v_company := case when p_entity = 'company' then p_id when p_entity = 'task' then (v_record ->> 'company_id')::uuid end;
        v_note_deal := case when p_entity = 'deal' then p_id when p_entity = 'task' then (v_record ->> 'deal_id')::uuid end;
        if p_entity = 'task' then
          if v_note_lead is not null and not exists (
            select 1 from public.leads l where l.organization_id = v_org and l.id = v_note_lead and l.deleted_at is null) then
            v_note_lead := null;
          end if;
          if v_contact is not null and not exists (
            select 1 from public.contacts c where c.organization_id = v_org and c.id = v_contact and c.deleted_at is null) then
            v_contact := null;
          end if;
          if v_company is not null and not exists (
            select 1 from public.companies c where c.organization_id = v_org and c.id = v_company and c.deleted_at is null) then
            v_company := null;
          end if;
          if v_note_deal is not null and not exists (
            select 1 from public.deals d where d.organization_id = v_org and d.id = v_note_deal and d.deleted_at is null) then
            v_note_deal := null;
          end if;
          if num_nonnulls(v_note_lead, v_contact, v_company, v_note_deal) = 0 then
            raise exception 'the task is not linked to a record';
          end if;
        end if;
        -- written by the automation, not by a person: no author (the trigger activities_zz_automation_note clears it
        -- after touch_row, which would set the person who ran the rule by hand)
        insert into public.activities (organization_id, type, body, metadata, lead_id, contact_id, company_id, deal_id, created_by)
        values (
          v_org, 'automation_note', v_title,
          jsonb_build_object('automation_id', p_auto.id, 'automation_name', left(p_auto.name, 80)),
          v_note_lead, v_contact, v_company, v_note_deal, null);

      else
        raise exception 'unknown action %', coalesce(v_type, '(none)');
      end if;

      v_steps := v_steps || jsonb_build_array(
        jsonb_build_object('action', v_type, 'status', 'ok')
        || case when v_type in ('set_lead_status', 'create_task', 'assign_owner', 'create_deal', 'set_field') and v_warning is not null
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
