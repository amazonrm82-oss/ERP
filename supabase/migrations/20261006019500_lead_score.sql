-- =============================================================================
-- Lead score from rules the business manages (LEAD-05)
-- =============================================================================
-- * public.lead_score_rules: each rule adds or takes off points (-100..100, not
--   0) when a lead matches one condition. Configuration like deal_loss_reasons:
--   members read, owners and admins of a writable organization write, at most 50
--   per organization (hint 'lead_score_rules:max'), audited.
-- * Suggested rules (owner, 14 October 2026): a new organization starts with five
--   rules it may edit or delete (app.seed_lead_score_rules(), run by the after
--   insert trigger organizations_seed_lead_score_rules; mirrored by SUGGESTED_RULES
--   in src/features/lead-score/rules.ts, unit test): email filled +10, phone filled
--   +10, at least one call +10, at least one meeting +20, asked for a call-back in a
--   form +15. Existing organizations get nothing here; their rules screen offers
--   the same five through public.lead_score_rules_suggest(org) (owners/admins of a
--   writable organization; adds nothing when the organization has any rule), the
--   one documented exception to the "no add-suggested button" rule. Its leads are
--   then rescored through the queue below.
-- * A rule is (field, op, value). field is one of
--     source | status          op eq | neq, value = the id of an option of the org
--     tag                      op eq | neq (has / has not), value = a tag id of the org
--     owner | email | phone | company | job_title | campaign | message | product
--                              op filled | empty, no value
--     callback                 op filled | empty, no value: the lead asked for a
--                              call-back in a public form (SPD-05), as a new lead or
--                              a repeat inquiry. Recorded in app.lead_callback_requests
--                              (organization, lead, first time; cascades with the lead)
--                              by trigger intake_callback_tasks_lead_score on every
--                              row intake_submit adds to app.intake_callback_tasks,
--                              so intake_submit itself is unchanged. Filled from the
--                              existing rows of that table once (no score is written).
--     budget                   op filled | empty, or gte | lte with a whole agorot value
--     cf:<key>                 an active lead custom field: filled | empty (not a
--                              checkbox); eq | neq an option (select, multi_select),
--                              eq 'true' | 'false' (checkbox); gte | lte a number
--                              (number, currency in agorot, percent, rating)
--     activity:<type>          op gte, value 1..100: at least that many entries of
--                              that type on the lead's timeline (private notes never
--                              count); type note | call | meeting | email | whatsapp
--                              | sms | inquiry
--   checked by trigger lead_score_rules_check (hint 'lead_score_rule:invalid') and
--   mirrored by src/features/lead-score/rules.ts (unit test reads this file).
--   A rule whose custom field was hidden, removed or changed type simply stops
--   matching (app.lead_score_matches never raises), and so does a rule whose
--   source, status, tag or list option is gone (app.lead_score_rule_live): "is not
--   X" for an X that no longer exists matches nothing, never every lead.
-- * leads.score is the sum of the points of the active rules the lead matches.
--   It is server-only: the browser's insert/update grant on the column is taken
--   back, and the before trigger leads_zz_score (named to run after every other
--   before trigger) sets it on every insert and update, whoever writes.
-- * The score follows the timeline: trigger activities_lead_score (after insert,
--   delete, or an update of type, lead_id or is_private) recomputes the lead(s)
--   when the organization has an active activity rule. Such a recompute is not an
--   edit: app.automation_running is on (the lead.updated event is written already
--   handled, as the last-contact stamp does) and app.lead_score_stamp is on, so the
--   lead keeps its updated_at / updated_by. 'score' joins the columns the audit log
--   and the event queue ignore (app.audit_row() and app.emit_event() redefined from
--   their latest bodies, 0041, with only 'score' added), so a recompute writes no
--   audit entry and no outbox event, and a person's edit lists only what they changed.
-- * A rule change (or a change of a lead custom field a rule uses) queues the
--   organization in app.lead_score_queue; pg_cron crm-lead-scores (every minute,
--   app.recompute_lead_scores()) goes through its leads in id order, 1,000 per
--   organization and 5,000 per run, writing only scores that changed, one
--   organization at a time under an advisory lock, each lead in its own exception
--   block; the organization served longest ago goes first (served_at), so a few
--   very large ones cannot hold every slot of a run. Every recompute locks the lead
--   row before computing (app.lead_score_write waits, the batch skips a row someone
--   is writing and repeats the pass, app.lead_score_queue.retry), so the score kept
--   by leads_zz_score is always computed from the row it is written to. A failure
--   swallowed after a timeline change or a call-back queues the business instead. public.lead_scores_refresh(org) (owners/admins) runs one batch of 2,000
--   at once, so a small business sees new scores right after saving;
--   public.lead_scores_pending(org) says whether a recompute is still waiting.
--   Leads in the recycle bin are skipped; restoring one recomputes it.
-- * public.lead_score_breakdown(org, lead) (security invoker) lists the active
--   rules the lead matches now and the stored score, for the lead's card.
-- * Rules: clients update only field, op, value, points, position and is_active
--   (column grant; app.touch_row also refuses moving a row to another organization).
-- * Merge: app.merge_move_links() (redefined from 015510) moves the duplicate's
--   call-back mark to the kept lead and rescores it.
-- * Sample data (USR-04): app.sample_row() treats a sample lead's score as its
--   snapshot's, so a score that moved with the rules does not keep a sample lead.
-- * No score backfill: organizations that exist have no rules, so every score is
--   0, which is the column's default.
-- Every statement is safe to run twice. No deletes, no drops.

-- ----------------------------------------------------------------------------
-- The rules
-- ----------------------------------------------------------------------------
create table if not exists public.lead_score_rules (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  field           text not null check (field ~ '^(source|status|tag|owner|email|phone|company|job_title|campaign|message|product|budget|callback|cf:[a-z0-9_]{1,60}|activity:[a-z_]{2,40})$'),
  op              text not null check (op in ('filled', 'empty', 'eq', 'neq', 'gte', 'lte')),
  value           text check (value is null or (char_length(value) between 1 and 200 and value = btrim(value))),
  points          integer not null check (points between -100 and 100 and points <> 0),
  position        integer not null default 0,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id)
);

create index if not exists lead_score_rules_org_idx on public.lead_score_rules (organization_id, position);

alter table public.lead_score_rules enable row level security;

revoke all on public.lead_score_rules from anon, authenticated;
grant select, insert, delete on public.lead_score_rules to authenticated;
-- a rule never moves to another organization: only its own parts are editable
grant update (field, op, value, points, position, is_active) on public.lead_score_rules to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'lead_score_rules' and policyname = 'lead_score_rules_select') then
    create policy lead_score_rules_select on public.lead_score_rules for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'lead_score_rules' and policyname = 'lead_score_rules_insert') then
    create policy lead_score_rules_insert on public.lead_score_rules for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'lead_score_rules' and policyname = 'lead_score_rules_update') then
    create policy lead_score_rules_update on public.lead_score_rules for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'lead_score_rules' and policyname = 'lead_score_rules_delete') then
    create policy lead_score_rules_delete on public.lead_score_rules for delete to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

create or replace trigger lead_score_rules_touch before update on public.lead_score_rules
  for each row execute function app.touch_row();
create or replace trigger lead_score_rules_audit after insert or update or delete on public.lead_score_rules
  for each row execute function app.audit_row();

create or replace function app.lead_score_rules_cap() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- an outsider gets RLS's plain refusal and learns nothing about the organization
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('lead_score_rules:' || new.organization_id::text, 0));
  if (select count(*) from public.lead_score_rules r where r.organization_id = new.organization_id) >= 50 then
    raise exception 'too many lead score rules' using errcode = 'P0001', hint = 'lead_score_rules:max';
  end if;
  return new;
end;
$$;
revoke all on function app.lead_score_rules_cap() from public, anon, authenticated;

create or replace trigger lead_score_rules_cap before insert on public.lead_score_rules
  for each row execute function app.lead_score_rules_cap();

-- the activity types a rule may count (mirrored by SCORE_ACTIVITY_TYPES)
create or replace function app.lead_score_activity_types() returns text[]
language sql immutable
set search_path = ''
as $$
  select array['note', 'call', 'meeting', 'email', 'whatsapp', 'sms', 'inquiry'];
$$;
revoke all on function app.lead_score_activity_types() from public, anon;
grant execute on function app.lead_score_activity_types() to authenticated, service_role;

-- A rule is checked when it is written. Security invoker: an id is looked up with
-- the writer's rights, so an id of another organization is simply "invalid".
create or replace function app.lead_score_rule_check() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_ok boolean := false;
  v_type text;
  v_options jsonb;
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if tg_op = 'UPDATE' and new.field is not distinct from old.field and new.op is not distinct from old.op
     and new.value is not distinct from old.value then
    return new;
  end if;

  if new.field in ('source', 'status', 'tag') then
    if new.op in ('eq', 'neq') and new.value ~ v_uuid then
      v_ok := case new.field
        when 'source' then exists (select 1 from public.lead_sources s where s.organization_id = new.organization_id and s.id = new.value::uuid)
        when 'status' then exists (select 1 from public.lead_statuses s where s.organization_id = new.organization_id and s.id = new.value::uuid)
        else exists (select 1 from public.tags t where t.organization_id = new.organization_id and t.id = new.value::uuid)
      end;
    end if;
  elsif new.field in ('owner', 'email', 'phone', 'company', 'job_title', 'campaign', 'message', 'product', 'callback') then
    v_ok := new.op in ('filled', 'empty') and new.value is null;
  elsif new.field = 'budget' then
    v_ok := (new.op in ('filled', 'empty') and new.value is null)
         or (new.op in ('gte', 'lte') and new.value ~ '^[0-9]{1,15}$');
  elsif new.field like 'activity:%' then
    v_ok := substr(new.field, 10) = any (app.lead_score_activity_types())
        and new.op = 'gte' and new.value ~ '^[0-9]{1,3}$' and new.value::integer between 1 and 100;
  elsif new.field like 'cf:%' then
    select f.field_type, f.options into v_type, v_options
      from public.field_definitions f
     where f.organization_id = new.organization_id and f.object_type = 'lead'
       and f.key = substr(new.field, 4) and f.is_active;
    if v_type is not null then
      if new.op in ('filled', 'empty') then
        v_ok := new.value is null and v_type <> 'checkbox';
      elsif new.op in ('eq', 'neq') then
        if v_type in ('select', 'multi_select') then
          v_ok := new.value is not null and coalesce(v_options, '[]'::jsonb) @> jsonb_build_array(new.value);
        elsif v_type = 'checkbox' then
          v_ok := new.op = 'eq' and new.value in ('true', 'false');
        end if;
      elsif new.op in ('gte', 'lte') then
        v_ok := v_type in ('number', 'currency', 'percent', 'rating') and new.value ~ '^-?[0-9]{1,15}(\.[0-9]{1,4})?$';
      end if;
    end if;
  end if;

  if not v_ok then
    raise exception 'invalid lead score rule' using errcode = 'P0001', hint = 'lead_score_rule:invalid';
  end if;
  return new;
end;
$$;
revoke all on function app.lead_score_rule_check() from public, anon, authenticated;

create or replace trigger lead_score_rules_check before insert or update on public.lead_score_rules
  for each row execute function app.lead_score_rule_check();

-- ----------------------------------------------------------------------------
-- Matching (pure, never raises) and the score
-- ----------------------------------------------------------------------------
-- p_row: the lead as jsonb; p_counts: {type: count} of its timeline entries;
-- p_cf_type: the type of the active custom field a cf: rule names, else null.
create or replace function app.lead_score_matches(p_field text, p_op text, p_value text, p_row jsonb, p_counts jsonb, p_cf_type text)
returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  v_val jsonb;
  v_col text;
  v_filled boolean;
  v_hit boolean;
  v_num constant text := '^-?[0-9]{1,15}(\.[0-9]{1,4})?$';
begin
  if p_field like 'activity:%' then
    if p_op <> 'gte' or coalesce(p_value, '') !~ '^[0-9]{1,3}$' then
      return false;
    end if;
    return coalesce((p_counts ->> substr(p_field, 10))::integer, 0) >= p_value::integer;
  end if;

  -- p_counts.callback: 1 when the lead asked for a call-back in a form
  if p_field = 'callback' then
    v_filled := coalesce((p_counts ->> 'callback')::integer, 0) > 0;
    return case p_op when 'filled' then v_filled when 'empty' then not v_filled else false end;
  end if;

  if p_field like 'cf:%' then
    if p_cf_type is null then
      return false;
    end if;
    v_val := p_row -> 'custom_fields' -> substr(p_field, 4);
  else
    v_col := case p_field
      when 'source' then 'source_id' when 'status' then 'status_id' when 'tag' then 'tag_ids'
      when 'owner' then 'owner_id' when 'email' then 'email' when 'phone' then 'phone'
      when 'company' then 'company_name' when 'job_title' then 'job_title' when 'campaign' then 'campaign'
      when 'message' then 'message' when 'product' then 'requested_product_id' when 'budget' then 'budget_agorot'
    end;
    if v_col is null then
      return false;
    end if;
    v_val := p_row -> v_col;
  end if;

  v_filled := v_val is not null and jsonb_typeof(v_val) <> 'null'
          and not (jsonb_typeof(v_val) = 'string' and btrim(v_val #>> '{}') = '')
          and not (jsonb_typeof(v_val) = 'array' and jsonb_array_length(v_val) = 0);

  case p_op
    when 'filled' then
      return v_filled;
    when 'empty' then
      return not v_filled;
    when 'eq', 'neq' then
      if p_value is null then
        return false;
      end if;
      if jsonb_typeof(v_val) = 'array' then
        v_hit := v_val @> jsonb_build_array(p_value);
      elsif p_cf_type = 'checkbox' then
        -- an unchecked box may be stored as false or not at all
        v_hit := coalesce(case when jsonb_typeof(v_val) = 'boolean' then v_val #>> '{}' end, 'false') = p_value;
      else
        v_hit := coalesce(jsonb_typeof(v_val) = 'string' and v_val #>> '{}' = p_value, false);
      end if;
      return case when p_op = 'eq' then v_hit else not v_hit end;
    when 'gte', 'lte' then
      if jsonb_typeof(v_val) is distinct from 'number' or coalesce(p_value, '') !~ v_num then
        return false;
      end if;
      return case when p_op = 'gte' then (v_val #>> '{}')::numeric >= p_value::numeric
                  else (v_val #>> '{}')::numeric <= p_value::numeric end;
    else
      return false;
  end case;
end;
$$;
revoke all on function app.lead_score_matches(text, text, text, jsonb, jsonb, text) from public, anon;
grant execute on function app.lead_score_matches(text, text, text, jsonb, jsonb, text) to authenticated, service_role;

-- Whether a rule's id or list option still exists. A rule pointing at a removed
-- source, status, tag or option matches nothing (not even with 'neq'). Security
-- invoker: it reads only public tables, with the rights of whoever scores.
create or replace function app.lead_score_rule_live(p_org uuid, p_field text, p_op text, p_value text, p_cf_type text, p_cf_options jsonb)
returns boolean
language sql stable
set search_path = ''
as $$
  select case
    when p_field = 'source' then exists (select 1 from public.lead_sources s where s.organization_id = p_org and s.id = p_value::uuid)
    when p_field = 'status' then exists (select 1 from public.lead_statuses s where s.organization_id = p_org and s.id = p_value::uuid)
    when p_field = 'tag' then exists (select 1 from public.tags t where t.organization_id = p_org and t.id = p_value::uuid)
    when p_field like 'cf:%' and p_op in ('eq', 'neq') and p_cf_type in ('select', 'multi_select')
      then coalesce(p_cf_options, '[]'::jsonb) @> jsonb_build_array(p_value)
    else true
  end;
$$;
revoke all on function app.lead_score_rule_live(uuid, text, text, text, text, jsonb) from public, anon;
grant execute on function app.lead_score_rule_live(uuid, text, text, text, text, jsonb) to authenticated, service_role;

-- The score of a lead as it is in p_lead (also a row that is being written).
-- Volatile on purpose: each query sees what committed before it ran.
create or replace function app.lead_score_value(p_lead public.leads) returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_any boolean;
  v_activity boolean;
  v_callback boolean;
  v_counts jsonb := '{}'::jsonb;
  v_score bigint;
begin
  select bool_or(true), coalesce(bool_or(r.field like 'activity:%'), false), coalesce(bool_or(r.field = 'callback'), false)
    into v_any, v_activity, v_callback
    from public.lead_score_rules r
   where r.organization_id = p_lead.organization_id and r.is_active;
  if v_any is null then
    return 0;
  end if;
  if v_activity then
    select coalesce(jsonb_object_agg(c.type, c.n), '{}'::jsonb) into v_counts
      from (select a.type, count(*) as n
              from public.activities a
             where a.organization_id = p_lead.organization_id and a.lead_id = p_lead.id
               and not a.is_private and a.type = any (app.lead_score_activity_types())
             group by a.type) c;
  end if;
  if v_callback then
    v_counts := v_counts || jsonb_build_object('callback',
      case when exists (select 1 from app.lead_callback_requests c
                         where c.organization_id = p_lead.organization_id and c.lead_id = p_lead.id) then 1 else 0 end);
  end if;
  select coalesce(sum(r.points), 0) into v_score
    from public.lead_score_rules r
    left join public.field_definitions f
      on r.field like 'cf:%' and f.organization_id = r.organization_id and f.object_type = 'lead'
     and f.key = substr(r.field, 4) and f.is_active
   where r.organization_id = p_lead.organization_id and r.is_active
     and app.lead_score_matches(r.field, r.op, r.value, to_jsonb(p_lead), v_counts, f.field_type)
     and app.lead_score_rule_live(r.organization_id, r.field, r.op, r.value, f.field_type, f.options);
  return v_score::integer;
end;
$$;
revoke all on function app.lead_score_value(public.leads) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The score on the lead: server-only, set on every write
-- ----------------------------------------------------------------------------
revoke insert (score), update (score) on public.leads from authenticated;

-- 'score' is computed: the audit log and the event queue ignore it, like
-- reminded_at (0041). Bodies as in 0041 (the latest definition of each), with
-- only 'score' added to v_ignored.
create or replace function app.audit_row() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_org uuid;
  v_entity uuid;
  v_action text;
  v_changes jsonb := '{}'::jsonb;
  v_key text;
  v_ignored constant text[] := array['updated_at', 'updated_by', 'stage_entered_at', 'phone_e164', 'last_lead_assigned_at', 'reminded_at', 'score'];
begin
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;

  if tg_table_name = 'organizations' then
    v_org := coalesce(v_new ->> 'id', v_old ->> 'id')::uuid;
  else
    v_org := coalesce(v_new ->> 'organization_id', v_old ->> 'organization_id')::uuid;
  end if;
  v_entity := nullif(coalesce(v_new ->> 'id', v_old ->> 'id'), '')::uuid;

  if tg_op = 'INSERT' then
    v_action := 'insert';
  elsif tg_op = 'DELETE' then
    -- nothing to attach the entry to when the organization itself is going away
    if not app.org_exists(v_org) then
      return null;
    end if;
    v_action := 'delete';
    v_changes := v_old;
  else
    for v_key in select jsonb_object_keys(v_new) loop
      if v_key <> all (v_ignored) and (v_new -> v_key) is distinct from (v_old -> v_key) then
        v_changes := v_changes || jsonb_build_object(
          v_key, jsonb_build_object('old', v_old -> v_key, 'new', v_new -> v_key));
      end if;
    end loop;
    if v_changes = '{}'::jsonb then
      return null;
    end if;
    v_action := case
      when v_changes ? 'deleted_at' and (v_new ->> 'deleted_at') is not null then 'trash'
      when v_changes ? 'deleted_at' then 'restore'
      else 'update'
    end;
  end if;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (v_org, auth.uid(), v_action, tg_table_name, v_entity, v_changes);
  return null;
end;
$$;

create or replace function app.emit_event() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_entity text := tg_argv[0];
  v_old jsonb;
  v_new jsonb;
  v_changed text[] := '{}';
  v_key text;
  v_event text;
  v_ignored constant text[] := array['updated_at', 'updated_by', 'stage_entered_at', 'phone_e164', 'reminded_at', 'score'];
  -- set by app.process_outbox() while it runs automation actions
  v_origin jsonb := case when current_setting('app.automation_running', true) = 'on'
                         then jsonb_build_object('origin', 'automation') else '{}'::jsonb end;
begin
  if tg_op = 'DELETE' then
    if not app.org_exists(old.organization_id) then
      return null;
    end if;
    insert into public.outbox_events (organization_id, event_type, entity_type, entity_id, actor_id, payload)
    values (old.organization_id, v_entity || '.purged', v_entity, old.id, auth.uid(), v_origin);
    return null;
  end if;

  if tg_op = 'INSERT' then
    -- to_jsonb: tasks and deals have no import_job_id column
    if v_origin = '{}'::jsonb and to_jsonb(new) ->> 'import_job_id' is not null then
      v_origin := jsonb_build_object('origin', 'import');
    end if;
    insert into public.outbox_events (organization_id, event_type, entity_type, entity_id, actor_id, payload)
    values (new.organization_id, v_entity || '.created', v_entity, new.id, auth.uid(), v_origin);
    return null;
  end if;

  v_old := to_jsonb(old);
  v_new := to_jsonb(new);
  for v_key in select jsonb_object_keys(v_new) loop
    if v_key <> all (v_ignored) and (v_new -> v_key) is distinct from (v_old -> v_key) then
      v_changed := v_changed || v_key;
    end if;
  end loop;
  if cardinality(v_changed) = 0 then
    return null;
  end if;

  v_event := case
    when 'deleted_at' = any (v_changed) and new.deleted_at is not null then v_entity || '.deleted'
    when 'deleted_at' = any (v_changed) then v_entity || '.restored'
    else v_entity || '.updated'
  end;

  insert into public.outbox_events (organization_id, event_type, entity_type, entity_id, actor_id, payload)
  values (new.organization_id, v_event, v_entity, new.id, auth.uid(),
          jsonb_build_object('changed', to_jsonb(v_changed)) || v_origin);
  return null;
end;
$$;

create or replace function app.lead_score_set() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- a recompute (app.lead_score_write, app.lead_scores_batch) is not an edit: when
  -- nothing but the score changed, the lead keeps who and when it was last edited,
  -- and the score is the one the recompute just computed (clients cannot write the
  -- column at all, so only a server function sets it here)
  if tg_op = 'UPDATE' and current_setting('app.lead_score_stamp', true) = 'on'
     and (to_jsonb(new) - array['score', 'updated_at', 'updated_by']) is not distinct from (to_jsonb(old) - array['score', 'updated_at', 'updated_by']) then
    new.updated_at := old.updated_at;
    new.updated_by := old.updated_by;
    return new;
  end if;
  new.score := app.lead_score_value(new);
  return new;
end;
$$;
revoke all on function app.lead_score_set() from public, anon, authenticated;

-- "zz": before triggers fire in name order, and the score must see the row as
-- every other before trigger left it
create or replace trigger leads_zz_score before insert or update on public.leads
  for each row execute function app.lead_score_set();

create index if not exists leads_score_idx on public.leads (organization_id, score) where deleted_at is null;

-- Writes one lead's score when it changed, without making it an edit.
create or replace function app.lead_score_write(p_org uuid, p_lead uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_lead public.leads;
  v_score integer;
  v_automation text;
begin
  -- locked before computing: a concurrent edit is waited for and then seen, so the
  -- score the trigger keeps (lead_score_set) is always the one of the row it lands on
  select l.* into v_lead from public.leads l
   where l.organization_id = p_org and l.id = p_lead and l.deleted_at is null
   for update;
  if not found then
    return;
  end if;
  v_score := app.lead_score_value(v_lead);
  if v_score = v_lead.score then
    return;
  end if;
  v_automation := current_setting('app.automation_running', true);
  perform set_config('app.automation_running', 'on', true);
  perform set_config('app.lead_score_stamp', 'on', true);
  update public.leads l set score = v_score where l.organization_id = p_org and l.id = p_lead;
  perform set_config('app.lead_score_stamp', 'off', true);
  perform set_config('app.automation_running', coalesce(v_automation, ''), true);
end;
$$;
revoke all on function app.lead_score_write(uuid, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The timeline moves the score
-- ----------------------------------------------------------------------------
create or replace function app.lead_score_on_activity() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_org uuid := coalesce(new.organization_id, old.organization_id);
begin
  if not exists (select 1 from public.lead_score_rules r
                  where r.organization_id = v_org and r.is_active and r.field like 'activity:%') then
    return null;
  end if;
  -- the organization itself is going away
  if not app.org_exists(v_org) then
    return null;
  end if;
  -- the timeline entry matters more than the score: a failure here only warns, and
  -- the next recompute of the business fixes the score. query_canceled is not
  -- caught by 'others', so a cancel or statement timeout still stops the statement.
  begin
    if tg_op <> 'INSERT' and old.lead_id is not null then
      perform app.lead_score_write(old.organization_id, old.lead_id);
    end if;
    if tg_op <> 'DELETE' and new.lead_id is not null
       and (tg_op = 'INSERT' or new.lead_id is distinct from old.lead_id) then
      perform app.lead_score_write(new.organization_id, new.lead_id);
    end if;
  exception when others then
    raise warning 'lead score not recomputed after a timeline change: %', sqlerrm;
    -- the background job recomputes the business instead
    begin
      perform app.lead_score_enqueue(v_org);
    exception when others then
      raise warning 'lead score recompute not queued: %', sqlerrm;
    end;
  end;
  return null;
end;
$$;
revoke all on function app.lead_score_on_activity() from public, anon, authenticated;

create or replace trigger activities_lead_score
  after insert or delete or update of type, lead_id, is_private on public.activities
  for each row execute function app.lead_score_on_activity();

-- ----------------------------------------------------------------------------
-- A call-back asked for in a form (rule field 'callback')
-- ----------------------------------------------------------------------------
create table if not exists app.lead_callback_requests (
  organization_id uuid not null,
  lead_id         uuid not null,
  -- the first request; later ones change nothing
  requested_at    timestamptz not null default now(),
  primary key (organization_id, lead_id),
  foreign key (organization_id, lead_id) references public.leads (organization_id, id) on delete cascade
);
alter table app.lead_callback_requests enable row level security;
revoke all on app.lead_callback_requests from public, anon, authenticated;

-- intake_submit marks every call task it makes for a lead; the lead is marked too,
-- and rescored when the organization scores call-backs. Never raises into intake.
create or replace function app.lead_callback_recorded() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  begin
    insert into app.lead_callback_requests (organization_id, lead_id)
    select l.organization_id, l.id from public.leads l
     where l.organization_id = new.organization_id and l.id = new.lead_id
    on conflict do nothing;
    if found and exists (select 1 from public.lead_score_rules r
                          where r.organization_id = new.organization_id and r.is_active and r.field = 'callback') then
      perform app.lead_score_write(new.organization_id, new.lead_id);
    end if;
  exception when others then
    -- the inquiry matters more than its score; the background job recomputes the business
    raise warning 'call-back of lead % not recorded for the score: %', new.lead_id, sqlerrm;
    begin
      perform app.lead_score_enqueue(new.organization_id);
    exception when others then
      raise warning 'lead score recompute not queued: %', sqlerrm;
    end;
  end;
  return null;
end;
$$;
revoke all on function app.lead_callback_recorded() from public, anon, authenticated;

create or replace trigger intake_callback_tasks_lead_score after insert on app.intake_callback_tasks
  for each row execute function app.lead_callback_recorded();

-- the call-backs asked for before this migration (times from the call task's mark)
insert into app.lead_callback_requests (organization_id, lead_id, requested_at)
select t.organization_id, t.lead_id, min(t.created_at)
  from app.intake_callback_tasks t
  join public.leads l on l.organization_id = t.organization_id and l.id = t.lead_id
 group by t.organization_id, t.lead_id
on conflict do nothing;

-- ----------------------------------------------------------------------------
-- Merge: the duplicate's call-back mark moves to the kept lead
-- ----------------------------------------------------------------------------
-- app.merge_move_links() redefined from its latest body (015510), with only the
-- call-back mark (and the kept lead's rescore) added to the lead branch.
create or replace function app.merge_move_links(p_org uuid, p_type text, p_keep uuid, p_merge uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $$
declare
  v_col text := p_type || '_id';
  v_owner uuid;
  v_team uuid;
begin
  execute format('update public.activities set %1$I = $1 where organization_id = $2 and %1$I = $3', v_col) using p_keep, p_org, p_merge;
  execute format('update public.tasks set %1$I = $1 where organization_id = $2 and %1$I = $3', v_col) using p_keep, p_org, p_merge;
  execute format('update public.files set %1$I = $1 where organization_id = $2 and %1$I = $3', v_col) using p_keep, p_org, p_merge;
  execute format('update public.meetings set %1$I = $1 where organization_id = $2 and %1$I = $3', v_col) using p_keep, p_org, p_merge;
  update public.notifications set entity_id = p_keep where organization_id = p_org and entity_id = p_merge;
  -- CNS-01: the duplicate's consent history goes to the kept record (time and seq kept;
  -- the guard lets the link move and subject_id follows)
  if p_type in ('lead', 'contact') then
    execute format('update public.consents set %1$I = $1 where organization_id = $2 and %1$I = $3', v_col) using p_keep, p_org, p_merge;
  end if;
  -- followers who may read the kept record, one row per user; a row that would
  -- clash, or whose user may not read the kept record, stays and goes with the duplicate
  execute format('select owner_id, team_id from public.%I where organization_id = $1 and id = $2',
                 case p_type when 'lead' then 'leads' when 'contact' then 'contacts' else 'companies' end)
    into v_owner, v_team using p_org, p_keep;
  execute format(
    'update public.record_followers f set %1$I = $1
      where f.organization_id = $2 and f.%1$I = $3
        and app.user_can_read_record($2, f.user_id, $4, $5)
        and not exists (select 1 from public.record_followers k
                         where k.organization_id = $2 and k.user_id = f.user_id and k.%1$I = $1)', v_col)
    using p_keep, p_org, p_merge, v_owner, v_team;

  if p_type = 'lead' then
    update public.form_submissions set lead_id = p_keep where organization_id = p_org and lead_id = p_merge;
    -- LEAD-05: a call-back the duplicate asked for counts for the kept lead (one mark,
    -- the earliest time); the duplicate's own mark goes with it by cascade
    insert into app.lead_callback_requests as k (organization_id, lead_id, requested_at)
    select c.organization_id, p_keep, c.requested_at
      from app.lead_callback_requests c
     where c.organization_id = p_org and c.lead_id = p_merge
    on conflict (organization_id, lead_id) do update
      set requested_at = least(k.requested_at, excluded.requested_at);
    perform app.lead_score_write(p_org, p_keep);
  elsif p_type = 'contact' then
    update public.deals set contact_id = p_keep where organization_id = p_org and contact_id = p_merge;
    -- one row per deal: a row that would clash stays and goes with the duplicate
    update public.deal_contacts dc set contact_id = p_keep
     where dc.organization_id = p_org and dc.contact_id = p_merge
       and not exists (select 1 from public.deal_contacts k where k.deal_id = dc.deal_id and k.contact_id = p_keep);
    update public.leads set converted_contact_id = p_keep where organization_id = p_org and converted_contact_id = p_merge;
    perform app.merge_contact_channels_move(p_org, p_keep, p_merge);
  elsif p_type = 'company' then
    update public.contacts set company_id = p_keep where organization_id = p_org and company_id = p_merge;
    update public.deals set company_id = p_keep where organization_id = p_org and company_id = p_merge;
    update public.leads set converted_company_id = p_keep where organization_id = p_org and converted_company_id = p_merge;
    update public.companies set parent_company_id = case when id = p_keep then null else p_keep end
     where organization_id = p_org and parent_company_id = p_merge;
  end if;
end;
$$;
revoke all on function app.merge_move_links(uuid, text, uuid, uuid) from public, anon, authenticated;

-- For the card (public.lead_score_breakdown is security invoker and may not read
-- an app table): whether the lead asked for a call-back, only for a caller who
-- reads the lead (the rule of the leads_select policy; keep the two in step).
create or replace function app.lead_callback_requested(p_org uuid, p_lead uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.leads l
      join app.lead_callback_requests c on c.organization_id = l.organization_id and c.lead_id = l.id
     where l.organization_id = p_org and l.id = p_lead
       and (app.can_read_record(l.organization_id, l.owner_id, l.team_id)
            or (l.organization_id, l.id) in (select r.organization_id, r.id from app.deputy_readable('lead') r)));
$$;
revoke all on function app.lead_callback_requested(uuid, uuid) from public, anon;
grant execute on function app.lead_callback_requested(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- A rule change recomputes every lead, in the background
-- ----------------------------------------------------------------------------
create table if not exists app.lead_score_queue (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  -- null = nothing waiting
  requested_at    timestamptz,
  -- the last lead id done in the current pass
  cursor_id       uuid,
  -- a lead was being written by someone else and was skipped: pass again
  retry           boolean not null default false,
  -- when the job last worked on it (null = never): least recently served goes first
  served_at       timestamptz
);
alter table app.lead_score_queue add column if not exists served_at timestamptz;
alter table app.lead_score_queue add column if not exists retry boolean not null default false;
alter table app.lead_score_queue enable row level security;
revoke all on app.lead_score_queue from public, anon, authenticated;

create or replace function app.lead_score_enqueue(p_org uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  -- a business going away, or one with no lead yet (a new business's suggested rules)
  if not app.org_exists(p_org)
     or not exists (select 1 from public.leads l where l.organization_id = p_org) then
    return;
  end if;
  insert into app.lead_score_queue (organization_id, requested_at, cursor_id, retry)
  values (p_org, clock_timestamp(), null, false)
  on conflict (organization_id) do update set requested_at = excluded.requested_at, cursor_id = null, retry = false;
end;
$$;
revoke all on function app.lead_score_enqueue(uuid) from public, anon, authenticated;

create or replace function app.lead_score_rules_changed() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform app.lead_score_enqueue(coalesce(new.organization_id, old.organization_id));
  return null;
end;
$$;
revoke all on function app.lead_score_rules_changed() from public, anon, authenticated;

create or replace trigger lead_score_rules_queue after insert or update or delete on public.lead_score_rules
  for each row execute function app.lead_score_rules_changed();

-- a lead custom field a rule names was hidden, shown, retyped or removed
create or replace function app.lead_score_field_changed() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_org uuid := coalesce(new.organization_id, old.organization_id);
begin
  if coalesce(new.object_type, old.object_type) <> 'lead' then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.is_active is not distinct from old.is_active and new.field_type is not distinct from old.field_type
     and new.key is not distinct from old.key and new.options is not distinct from old.options then
    return null;
  end if;
  if exists (select 1 from public.lead_score_rules r
              where r.organization_id = v_org
                and r.field in ('cf:' || coalesce(old.key, ''), 'cf:' || coalesce(new.key, ''))) then
    perform app.lead_score_enqueue(v_org);
  end if;
  return null;
end;
$$;
revoke all on function app.lead_score_field_changed() from public, anon, authenticated;

create or replace trigger field_definitions_lead_score after update or delete on public.field_definitions
  for each row execute function app.lead_score_field_changed();

-- One pass over up to p_limit leads of one organization. Returns true when the
-- organization has nothing left to recompute.
create or replace function app.lead_scores_batch(p_org uuid, p_limit integer) returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_requested timestamptz;
  v_cursor uuid;
  v_id uuid;
  v_lead public.leads;
  v_score integer;
  v_last uuid;
  v_seen integer := 0;
  v_skipped boolean := false;
  v_automation text;
begin
  -- one runner per organization at a time
  if not pg_try_advisory_xact_lock(hashtextextended('lead_scores:' || p_org::text, 0)) then
    return false;
  end if;
  select q.requested_at, q.cursor_id into v_requested, v_cursor
    from app.lead_score_queue q where q.organization_id = p_org;
  if v_requested is null then
    return true;
  end if;
  update app.lead_score_queue q set served_at = clock_timestamp() where q.organization_id = p_org;

  v_automation := current_setting('app.automation_running', true);
  perform set_config('app.automation_running', 'on', true);
  perform set_config('app.lead_score_stamp', 'on', true);
  for v_id in
    select l.id from public.leads l
     where l.organization_id = p_org and l.deleted_at is null
       and (v_cursor is null or l.id > v_cursor)
     order by l.id
     limit p_limit
  loop
    v_seen := v_seen + 1;
    v_last := v_id;
    begin
      -- the row is locked before its score is computed; one that someone is writing
      -- right now is skipped (their own write scores it) and the pass is repeated
      select l.* into v_lead from public.leads l
       where l.organization_id = p_org and l.id = v_id and l.deleted_at is null
       for update skip locked;
      if not found then
        if exists (select 1 from public.leads l where l.organization_id = p_org and l.id = v_id and l.deleted_at is null) then
          v_skipped := true;
        end if;
        continue;
      end if;
      v_score := app.lead_score_value(v_lead);
      if v_score <> v_lead.score then
        update public.leads l set score = v_score where l.organization_id = p_org and l.id = v_id;
      end if;
    exception when others then
      -- one lead that cannot be written does not hold back the rest
      raise warning 'lead score of % not recomputed: %', v_id, sqlerrm;
    end;
  end loop;
  perform set_config('app.lead_score_stamp', 'off', true);
  perform set_config('app.automation_running', coalesce(v_automation, ''), true);

  if v_skipped then
    update app.lead_score_queue q set retry = true
     where q.organization_id = p_org and q.requested_at = v_requested;
  end if;
  -- a change queued meanwhile restarted the pass (cursor null, a later time): leave it
  if v_seen < p_limit then
    -- the end of a pass that skipped a lead: once more from the start
    update app.lead_score_queue q set cursor_id = null, retry = false
     where q.organization_id = p_org and q.requested_at = v_requested and q.retry;
    if found then
      return false;
    end if;
    update app.lead_score_queue q set requested_at = null, cursor_id = null
     where q.organization_id = p_org and q.requested_at = v_requested;
    return found;
  end if;
  update app.lead_score_queue q set cursor_id = v_last
   where q.organization_id = p_org and q.requested_at = v_requested;
  return false;
end;
$$;
revoke all on function app.lead_scores_batch(uuid, integer) from public, anon, authenticated;

-- pg_cron, every minute: fair across organizations, the one served longest ago
-- (or never) first, then the oldest request.
create or replace function app.recompute_lead_scores() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_done integer := 0;
begin
  for v_org in
    select q.organization_id from app.lead_score_queue q
     where q.requested_at is not null
     order by q.served_at nulls first, q.requested_at
     limit 5
  loop
    begin
      perform app.lead_scores_batch(v_org, 1000);
      v_done := v_done + 1;
    exception when others then
      raise warning 'lead scores of organization % not recomputed: %', v_org, sqlerrm;
    end;
  end loop;
  return v_done;
end;
$$;
revoke all on function app.recompute_lead_scores() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-lead-scores', '* * * * *', 'select app.recompute_lead_scores();');
  end if;
end;
$$;

-- Owners and admins: recompute now (one batch); true when nothing is left.
create or replace function public.lead_scores_refresh(p_org uuid) returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if not app.is_admin(p_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not app.org_writable(p_org) then
    raise exception 'organization is read-only' using errcode = 'P0001', hint = 'org:read_only';
  end if;
  return app.lead_scores_batch(p_org, 2000);
end;
$$;
revoke all on function public.lead_scores_refresh(uuid) from public, anon;
grant execute on function public.lead_scores_refresh(uuid) to authenticated;

-- Members: whether a recompute is still waiting (null for anyone else).
create or replace function public.lead_scores_pending(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select case when app.is_member(p_org) then
    exists (select 1 from app.lead_score_queue q where q.organization_id = p_org and q.requested_at is not null)
  end;
$$;
revoke all on function public.lead_scores_pending(uuid) from public, anon;
grant execute on function public.lead_scores_pending(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Why a lead has its score (the lead's card)
-- ----------------------------------------------------------------------------
-- Security invoker: the lead, the rules, the fields and the timeline are read
-- with the caller's rights; private notes never count, so the caller counts the
-- same entries the server does. null when the caller cannot read the lead.
create or replace function public.lead_score_breakdown(p_org uuid, p_lead uuid) returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_lead public.leads;
  v_counts jsonb := '{}'::jsonb;
  v_rules jsonb;
begin
  select l.* into v_lead from public.leads l
   where l.organization_id = p_org and l.id = p_lead and l.deleted_at is null;
  if not found then
    return null;
  end if;
  select coalesce(jsonb_object_agg(c.type, c.n), '{}'::jsonb) into v_counts
    from (select a.type, count(*) as n
            from public.activities a
           where a.organization_id = p_org and a.lead_id = p_lead
             and not a.is_private and a.type = any (app.lead_score_activity_types())
           group by a.type) c;
  v_counts := v_counts || jsonb_build_object('callback', case when app.lead_callback_requested(p_org, p_lead) then 1 else 0 end);
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'points', r.points) order by r.position, r.created_at, r.id), '[]'::jsonb)
    into v_rules
    from public.lead_score_rules r
    left join public.field_definitions f
      on r.field like 'cf:%' and f.organization_id = r.organization_id and f.object_type = 'lead'
     and f.key = substr(r.field, 4) and f.is_active
   where r.organization_id = p_org and r.is_active
     and app.lead_score_matches(r.field, r.op, r.value, to_jsonb(v_lead), v_counts, f.field_type)
     and app.lead_score_rule_live(r.organization_id, r.field, r.op, r.value, f.field_type, f.options);
  return jsonb_build_object('score', v_lead.score, 'matched', v_rules);
end;
$$;
revoke all on function public.lead_score_breakdown(uuid, uuid) from public, anon;
grant execute on function public.lead_score_breakdown(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Suggested rules: a new organization starts with them; an existing one may add them
-- ----------------------------------------------------------------------------
-- Adds the five suggested rules while the organization has no rule at all, and
-- returns how many it added (0 = it had rules). Mirrored by SUGGESTED_RULES.
create or replace function app.seed_lead_score_rules(p_org uuid) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_added integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('lead_score_rules:' || p_org::text, 0));
  if exists (select 1 from public.lead_score_rules r where r.organization_id = p_org) then
    return 0;
  end if;
  insert into public.lead_score_rules (organization_id, field, op, value, points, position)
  values (p_org, 'email', 'filled', null, 10, 0),
         (p_org, 'phone', 'filled', null, 10, 1),
         (p_org, 'activity:call', 'gte', '1', 10, 2),
         (p_org, 'activity:meeting', 'gte', '1', 20, 3),
         (p_org, 'callback', 'filled', null, 15, 4);
  get diagnostics v_added = row_count;
  return v_added;
end;
$$;
revoke all on function app.seed_lead_score_rules(uuid) from public, anon, authenticated;

create or replace function app.organizations_seed_lead_score_rules() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform app.seed_lead_score_rules(new.id);
  return null;
end;
$$;
revoke all on function app.organizations_seed_lead_score_rules() from public, anon, authenticated;

create or replace trigger organizations_seed_lead_score_rules after insert on public.organizations
  for each row execute function app.organizations_seed_lead_score_rules();

-- The rules screen's "add the suggested rules" button (owners/admins of a writable
-- organization). Adds nothing when the organization already has a rule, so a
-- second click is harmless. The rule inserts queue the rescoring of its leads.
create or replace function public.lead_score_rules_suggest(p_org uuid) returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if not app.is_admin(p_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not app.org_writable(p_org) then
    raise exception 'organization is read-only' using errcode = 'P0001', hint = 'org:read_only';
  end if;
  return app.seed_lead_score_rules(p_org);
end;
$$;
revoke all on function public.lead_score_rules_suggest(uuid) from public, anon;
grant execute on function public.lead_score_rules_suggest(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Sample data: the score moves with the rules, so it never keeps a sample lead
-- ----------------------------------------------------------------------------
create or replace function app.sample_row(p_org uuid, p_type text, p_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
-- timestamps in the snapshot must not depend on the caller's time zone
set timezone = 'UTC'
as $$
declare
  v_row jsonb;
  v_snapshot jsonb;
begin
  if p_type not in ('lead', 'contact', 'company', 'deal', 'task') then
    raise exception 'unknown record type' using errcode = '22023';
  end if;
  execute format('select to_jsonb(t) - array[''updated_at'', ''updated_by'', ''deleted_at''] from public.%I t where t.organization_id = $1 and t.id = $2',
                 case p_type when 'lead' then 'leads' when 'contact' then 'contacts' when 'company' then 'companies'
                             when 'deal' then 'deals' else 'tasks' end)
    into v_row using p_org, p_id;
  if v_row is null then
    return null;
  end if;
  -- a column added after the snapshot was taken is left out while it is null,
  -- and leads.currency (TAX-06) while it holds its only value
  select s.snapshot into v_snapshot
    from app.sample_records s
   where s.organization_id = p_org
     and app.sample_note_type(s) = p_type
     and coalesce(s.lead_id, s.contact_id, s.company_id, s.deal_id, s.task_id) = p_id
   limit 1;
  if v_snapshot is not null and jsonb_typeof(v_snapshot) = 'object' then
    select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into v_row
      from jsonb_each(v_row) e
     where v_snapshot ? e.key
        or not (e.value = 'null'::jsonb or (p_type = 'lead' and e.key = 'currency' and e.value = '"ILS"'::jsonb));
    -- LEAD-05: the score is computed from the rules, not typed by a person
    if p_type = 'lead' and v_snapshot ? 'score' and v_row ? 'score' then
      v_row := v_row || jsonb_build_object('score', v_snapshot -> 'score');
    end if;
  end if;
  return v_row;
end;
$$;
revoke all on function app.sample_row(uuid, text, uuid) from public, anon, authenticated;
