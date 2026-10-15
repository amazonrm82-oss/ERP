-- =============================================================================
-- PRM-01 follow-up: the owner's answer on the automations permission (option א)
-- =============================================================================
-- Owner, 15 October 2026: "manage automations" stays an organization-wide grant (not
-- filtered by what its holder reads). Conditions built with it:
-- * the permissions screen warns, and asks again when the box is ticked (app only);
-- * granting and revoking are in the audit log: member_permissions is audited by trigger
--   member_permissions_audit (migration member_permissions), which writes the user and the
--   keys before and after on every change; tests/db/110 checks it for this key;
-- * every rule keeps its creator and its last editor: automations.created_by (0009) and the
--   new updated_by, both set from the session by app.touch_row and not client-writable (they
--   are outside the column grants of 0009);
-- * an insert or update an automation makes names the rule in the audit log (a delete's entry
--   does not): app.execute_automation (body of 0009; the slot is taken before and released
--   after the actions call, nothing else) records the running rule in app.automation_rule_runs
--   for this transaction (65,536 fixed slots, taken with SKIP LOCKED, never waited for),
--   and app.audit_row (body of lead_score, 0195: 'score' stays ignored) adds
--   {"automation": {"id", "name"}} to the entry when that row matches and the rule is of the
--   entry's business. A client session cannot write that table, so it cannot forge the label.
--   app.run_automation_actions is NOT redefined.
-- And the earlier request: a key whose module is not built yet cannot be granted
-- (app.member_permission_built_keys(), mirrored by `built` in MEMBER_PERMISSIONS, unit test;
-- hint permissions:not_built). set_member_permissions is the body of member_permissions with
-- that one check added.
--
-- Every statement is safe to run twice. No drops, no row removal.

create or replace function app.member_permission_built_keys() returns text[]
language sql immutable
set search_path = ''
as $$
  select array['export', 'import', 'edit_catalog', 'manage_automations']::text[]
$$;
revoke all on function app.member_permission_built_keys() from public, anon;
grant execute on function app.member_permission_built_keys() to authenticated, service_role;

create or replace function public.set_member_permissions(p_org uuid, p_user uuid, p_permissions text[])
returns text[]
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_role public.membership_role := app.membership_role(p_org);
  v_target public.memberships;
  v_keys text[];
  v_old text[];
begin
  if v_role is null or v_role not in ('owner', 'admin') then
    raise exception 'only owners and admins grant permissions' using errcode = '42501';
  end if;
  if not app.org_writable(p_org) then
    raise exception 'the organization is read-only' using errcode = '42501';
  end if;
  if p_permissions is null or array_position(p_permissions, null) is not null
     or not (p_permissions <@ app.member_permission_keys()) then
    raise exception 'unknown permission' using errcode = '22023', hint = 'permissions:invalid';
  end if;
  v_keys := array(select distinct k from unnest(p_permissions) as k order by k);

  -- the membership stays as it is until this transaction ends (a role change waits)
  select * into v_target from public.memberships m
   where m.organization_id = p_org and m.user_id = p_user
     for share;
  if not found then
    raise exception 'member not found' using errcode = 'P0002';
  end if;
  if v_target.status <> 'active' or v_target.role not in ('manager', 'member') then
    raise exception 'extra permissions are for active managers and members' using errcode = 'P0001', hint = 'permissions:role';
  end if;

  select mp.permissions into v_old from public.member_permissions mp
   where mp.organization_id = p_org and mp.user_id = p_user
     for update;
  -- a key whose module is not built yet cannot be added (one already held may stay)
  if exists (select 1 from unnest(v_keys) as k
              where k <> all (coalesce(v_old, '{}')) and k <> all (app.member_permission_built_keys())) then
    raise exception 'this permission has no module yet' using errcode = '22023', hint = 'permissions:not_built';
  end if;
  if not (v_keys <@ coalesce(v_old, '{}')) and not app.org_has_feature(p_org, 'granular_permissions') then
    raise exception 'individual permissions are not in this plan' using errcode = 'P0001', hint = 'feature:granular_permissions';
  end if;

  if v_old is null then
    if cardinality(v_keys) > 0 then
      insert into public.member_permissions (organization_id, user_id, permissions)
      values (p_org, p_user, v_keys);
    end if;
  elsif v_old is distinct from v_keys then
    update public.member_permissions mp
       set permissions = v_keys
     where mp.organization_id = p_org and mp.user_id = p_user;
  end if;
  return v_keys;
end;
$$;
revoke all on function public.set_member_permissions(uuid, uuid, text[]) from public, anon;
grant execute on function public.set_member_permissions(uuid, uuid, text[]) to authenticated;

-- ----------------------------------------------------------------------------
-- Rule authorship
-- ----------------------------------------------------------------------------
alter table public.automations add column if not exists updated_by uuid references auth.users (id) on delete set null;

-- ----------------------------------------------------------------------------
-- A change an automation makes names the rule
-- ----------------------------------------------------------------------------
-- The rule running in a transaction (review, 15 October 2026: a setting could be set by a client
-- session and forge the label). 65,536 fixed slots, created once here, so the table never grows; a
-- run uses slot txid_current() % 65536 and stamps it with its full txid, so only the transaction
-- that wrote it matches, and a row of an ended transaction matches nothing. A run never waits for
-- its slot: it takes the row with FOR UPDATE SKIP LOCKED, and when another open transaction holds
-- the same slot (txids that differ by a multiple of 65,536), this run's changes are simply logged
-- without the rule's name. Schema app: RLS on, no policies, no client grants.
create table if not exists app.automation_rule_runs (
  slot            integer primary key check (slot between 0 and 65535),
  txid            bigint,
  organization_id uuid,
  rule_id         uuid
);
insert into app.automation_rule_runs (slot)
select g from generate_series(0, 65535) g
on conflict (slot) do nothing;
alter table app.automation_rule_runs enable row level security;
revoke all on app.automation_rule_runs from public, anon, authenticated;

create or replace function app.execute_automation(
  p_auto public.automations, p_entity_id uuid, p_run_key text, p_check_conditions boolean default true
) returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_record jsonb := app.automation_record(p_auto.entity_type, p_auto.organization_id, p_entity_id);
  v_run uuid;
  v_steps jsonb;
  v_status text;
  v_ok integer;
  v_total integer;
  v_slot integer;
  v_labelled boolean;
begin
  if v_record is null or (v_record ->> 'deleted_at') is not null then
    return null;
  end if;
  if p_check_conditions and not app.automation_conditions_match(v_record, p_auto.conditions) then
    return null;
  end if;

  -- loop guard: at most 20 runs of one rule on one record a day
  if (select count(*) from public.automation_runs r
       where r.automation_id = p_auto.id and r.entity_id = p_entity_id and r.created_at > now() - interval '1 day') >= 20 then
    insert into public.automation_runs (organization_id, automation_id, entity_type, entity_id, run_key, status, steps)
    values (p_auto.organization_id, p_auto.id, p_auto.entity_type, p_entity_id, p_run_key, 'skipped',
            jsonb_build_array(jsonb_build_object('action', null, 'status', 'error', 'error', 'daily limit for this record reached')))
    on conflict (automation_id, run_key) do nothing;
    return 'skipped';
  end if;

  insert into public.automation_runs (organization_id, automation_id, entity_type, entity_id, run_key, status)
  values (p_auto.organization_id, p_auto.id, p_auto.entity_type, p_entity_id, p_run_key, 'success')
  on conflict (automation_id, run_key) do nothing
  returning id into v_run;
  if v_run is null then
    return null; -- this occasion already ran
  end if;

  perform set_config('app.automation_running', 'on', true);
  -- PRM-01: the audit log names the rule behind the inserts and updates its actions make (a delete
  -- gets no audit name). The running rule is kept in app.automation_rule_runs (no client grants), in
  -- this transaction's slot, stamped with this transaction, never in a setting a client session could
  -- set itself. The slot is never waited for: when another open transaction holds it, no label.
  v_slot := (txid_current() % 65536)::integer;
  perform 1 from app.automation_rule_runs where slot = v_slot for update skip locked;
  v_labelled := found;
  if v_labelled then
    update app.automation_rule_runs
       set txid = txid_current(), organization_id = p_auto.organization_id, rule_id = p_auto.id
     where slot = v_slot;
  end if;
  v_steps := app.run_automation_actions(p_auto, p_auto.entity_type, p_entity_id);
  if v_labelled then
    update app.automation_rule_runs set rule_id = null where slot = v_slot and txid = txid_current();
  end if;
  perform set_config('app.automation_running', 'off', true);

  select count(*) filter (where s ->> 'status' = 'ok'), count(*) into v_ok, v_total from jsonb_array_elements(v_steps) s;
  v_status := case when v_ok = v_total then 'success' when v_ok = 0 then 'failed' else 'partial' end;
  update public.automation_runs set status = v_status, steps = v_steps where id = v_run;
  return v_status;
end;
$$;

revoke all on function app.execute_automation(public.automations, uuid, text, boolean) from public, anon, authenticated;

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
  v_rule uuid;
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

  -- PRM-01: an insert or update an automation made names the rule, as it is named now (kept in the
  -- entry, never looked up again); a delete's entry carries no name. The rule comes from
  -- app.automation_rule_runs, written only by app.execute_automation for this transaction (no row
  -- when its slot was held by another transaction), and only a rule of this entry's business
  -- counts. A plain value, not an {old, new} pair, so lists show it as context.
  if tg_op <> 'DELETE' then
    select r.rule_id into v_rule from app.automation_rule_runs r
     where r.slot = (txid_current() % 65536)::integer and r.txid = txid_current()
       and r.organization_id = v_org and r.rule_id is not null;
    if v_rule is not null then
      v_changes := v_changes || jsonb_build_object('automation', jsonb_build_object(
        'id', v_rule,
        'name', (select a.name from public.automations a where a.id = v_rule and a.organization_id = v_org)));
    end if;
  end if;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (v_org, auth.uid(), v_action, tg_table_name, v_entity, v_changes);
  return null;
end;
$$;

notify pgrst, 'reload schema';
