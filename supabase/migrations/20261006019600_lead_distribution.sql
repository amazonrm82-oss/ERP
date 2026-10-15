-- =============================================================================
-- Lead distribution by weight, by open load, and by rules (CAP-08)
-- =============================================================================
-- Until now a new lead went to a fixed person or to the round robin (0008), which
-- skips people outside working hours or on leave (CAP-09, 0161) and gives an absent
-- member's turn to their deputy (HEB-08, 0187).
--
-- * The plan key 'lead_distribution' (a flag) opens everything below; the plans get it
--   in lead_distribution_plan (from "בסיס" up, owner 14 October 2026). Without it the
--   round robin runs exactly as before. A business that loses the flag keeps its saved
--   settings; at run time they are ignored.
-- * public.lead_distribution_settings: at most one row per organization (no row =
--   the plain round robin). Members read it; owners and admins of a writable
--   organization write it (audited).
--   - method: 'round_robin' (as before) | 'weighted' (each member gets leads in
--     proportion to their weight) | 'load' (the member with the fewest open leads per
--     unit of weight). Choosing another method than round_robin needs the flag
--     (definer trigger, quota guard first; hint feature:lead_distribution).
--   - weights: {user_id: 1..10}; a member who is not listed weighs 1. Checked by
--     app.distribution_weights_ok() (uuid keys, whole numbers 1..10, at most 1,000).
--     A key of someone who left is ignored.
-- * public.lead_routing_rules: ordered rules. A rule names a lead source and/or a
--   product (at least one) and a team; the first active rule (by position) that
--   matches a new lead makes that team the pool the lead is distributed in, instead of
--   the form's (or the automation step's) team. No match = the pool as before.
--   Members read them; owners and admins of a writable organization write them
--   (audited); 50 per organization (hint lead_routing_rules:max, advisory lock); an
--   active rule needs the flag. A rule goes with its source, product or team (cascade).
--   Language and area are not in the rules yet (open questions to the owner).
-- * app.lead_distribution_pick(org, team, at, lead, excluded): the one function that
--   decides the next owner. The CAP-09 / HEB-08 rule of who may get a lead is unchanged
--   (an active, available member with a full seat of the pool, in working hours and
--   not on leave; an absent member counts when their deputy is usable and in hours,
--   and then the deputy gets the lead); the method only orders them:
--   - round_robin: the member who got a lead the longest time ago (as before);
--   - weighted: stride scheduling. Each member has a pass (app.lead_rotation_passes)
--     and the organization a clock (app.lead_rotation_clock). The member with the
--     lowest max(pass, clock) gets the lead; then their pass = that value + 1/weight
--     and the clock moves up to it. Someone back from leave, or new, starts at the
--     clock: they are not flooded to "catch up". Ties go to the round robin order.
--   - load: the fewest open leads (open status, not converted, not in the bin) of
--     whoever would get the lead (the member, or the deputy of an absent one), divided
--     by that person's weight; ties go to the round robin order.
--   Every method still stamps memberships.last_lead_assigned_at of the member whose
--   turn it was (the round robin's memory, its tie-break, and what CAP-09's take_lead
--   never moves). `lead` ({source_id, product_id}) applies the rules (null = no rules:
--   the pool is the caller's team). `excluded`: people who may not get this lead (the
--   SPD-03 pass-on); a member whose lead would go to one of them is skipped without
--   losing their turn.
--   app.next_lead_turn() / app.next_lead_owner() (used by the CAP-09 rotation-waiting
--   job) now go through it with no rules, so the method applies there too.
-- * Redefined here (bodies copied from the migration named, only the lines about the
--   pick changed):
--   - public.intake_submit (from 018810 preferred_channel_form): a form in round robin
--     picks through app.lead_distribution_pick with the form's source; the pool the
--     rules chose is the new lead's team, the CAP-09 waiting row's team and the team
--     of the SPD-01 notices. app.org_takes_leads and the v_rotation_closed lines kept.
--   - app.check_lead_responses (from 018730 absence_deputy_followups): the SPD-03
--     pass-on asks the pick once with the excluded people instead of looping and
--     putting stamps back (the skipped keep their place, as before).
--   - app.run_automation_actions (from 018800 absence_warning_name): an automation's
--     round robin on a lead applies the rules with the lead's source and requested
--     product; on other records it stays the plain pick.
-- Read-only / suspended organization: the settings are read; nothing is written.
-- Full export: lead_distribution.csv and lead_routing_rules.csv. Handover, merge: not
-- involved (a member who leaves drops out of the pool; their weight key is ignored).
-- Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- Weights
-- ----------------------------------------------------------------------------
create or replace function app.distribution_weights_ok(p_weights jsonb) returns boolean
language sql immutable
set search_path = ''
as $$
  select p_weights is not null
     and jsonb_typeof(p_weights) = 'object'
     and (select count(*) from jsonb_object_keys(p_weights)) <= 1000
     and not exists (
       select 1 from jsonb_each(p_weights) e
        where e.key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           or jsonb_typeof(e.value) <> 'number'
           or (e.value #>> '{}')::numeric not in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10))
$$;
revoke all on function app.distribution_weights_ok(jsonb) from public, anon;
-- the check constraint runs it as the writer
grant execute on function app.distribution_weights_ok(jsonb) to authenticated, service_role;

-- A member's weight: their entry, else 1.
create or replace function app.distribution_weight(p_weights jsonb, p_user uuid) returns integer
language sql immutable
set search_path = ''
as $$
  select case when jsonb_typeof(p_weights -> p_user::text) = 'number'
                   and (p_weights ->> p_user::text)::numeric in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
              then (p_weights ->> p_user::text)::integer
              else 1 end
$$;
revoke all on function app.distribution_weight(jsonb, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The setting
-- ----------------------------------------------------------------------------
create table if not exists public.lead_distribution_settings (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  method          text not null default 'round_robin',
  weights         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id),
  constraint lead_distribution_settings_method_check check (method in ('round_robin', 'weighted', 'load')),
  constraint lead_distribution_settings_weights_check check (app.distribution_weights_ok(weights))
);

comment on table public.lead_distribution_settings is
  'CAP-08: how automatic lead distribution orders the members (round_robin | weighted | load) and their weights (1..10, default 1); at most one row per organization, no row = round robin.';

create or replace trigger lead_distribution_settings_touch before insert or update on public.lead_distribution_settings
  for each row execute function app.touch_row();
create or replace trigger lead_distribution_settings_audit after insert or update or delete on public.lead_distribution_settings
  for each row execute function app.audit_row();

-- Another method needs the plan flag; checked when it is chosen, so a business whose plan
-- lost the flag can still change its weights.
create or replace function app.lead_distribution_settings_feature() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- RLS refuses this writer right after; answer nothing about the plan (the quota triggers' guard)
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  if new.method <> 'round_robin'
     and (tg_op = 'INSERT' or old.method is distinct from new.method)
     and not app.org_has_feature(new.organization_id, 'lead_distribution') then
    raise exception 'this distribution method is not in the plan' using errcode = 'P0001', hint = 'feature:lead_distribution';
  end if;
  return new;
end;
$$;
revoke all on function app.lead_distribution_settings_feature() from public, anon, authenticated;

create or replace trigger lead_distribution_settings_feature before insert or update of method on public.lead_distribution_settings
  for each row execute function app.lead_distribution_settings_feature();

alter table public.lead_distribution_settings enable row level security;
revoke all on public.lead_distribution_settings from anon, authenticated;
grant select, delete on public.lead_distribution_settings to authenticated;
grant insert (organization_id, method, weights) on public.lead_distribution_settings to authenticated;
grant update (method, weights) on public.lead_distribution_settings to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'lead_distribution_settings' and policyname = 'lead_distribution_settings_select') then
    create policy lead_distribution_settings_select on public.lead_distribution_settings for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'lead_distribution_settings' and policyname = 'lead_distribution_settings_insert') then
    create policy lead_distribution_settings_insert on public.lead_distribution_settings for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'lead_distribution_settings' and policyname = 'lead_distribution_settings_update') then
    create policy lead_distribution_settings_update on public.lead_distribution_settings for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'lead_distribution_settings' and policyname = 'lead_distribution_settings_delete') then
    create policy lead_distribution_settings_delete on public.lead_distribution_settings for delete to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- Rules
-- ----------------------------------------------------------------------------
create table if not exists public.lead_routing_rules (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  position        integer not null default 0,
  is_active       boolean not null default true,
  source_id       uuid,
  product_id      uuid,
  team_id         uuid not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, source_id) references public.lead_sources (organization_id, id) on delete cascade,
  foreign key (organization_id, product_id) references public.products (organization_id, id) on delete cascade,
  foreign key (organization_id, team_id) references public.teams (organization_id, id) on delete cascade,
  constraint lead_routing_rules_condition check (source_id is not null or product_id is not null),
  constraint lead_routing_rules_position_range check (position between 0 and 10000)
);

create index if not exists lead_routing_rules_org_idx on public.lead_routing_rules (organization_id, position);
create index if not exists lead_routing_rules_source_idx on public.lead_routing_rules (organization_id, source_id) where source_id is not null;
create index if not exists lead_routing_rules_product_idx on public.lead_routing_rules (organization_id, product_id) where product_id is not null;
create index if not exists lead_routing_rules_team_idx on public.lead_routing_rules (organization_id, team_id);

comment on table public.lead_routing_rules is
  'CAP-08: the first active rule (by position) whose source and product match a new lead sends it to its team''s distribution instead of the form''s team.';

-- 50 rules per organization; an active rule needs the plan flag (when it is added, switched
-- on, or its conditions or team change, so a business that lost the flag can still switch
-- rules off, reorder or remove them).
create or replace function app.lead_routing_rules_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- RLS refuses this writer right after; answer nothing about the plan (the quota triggers' guard)
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  if new.is_active and (
       tg_op = 'INSERT' or not old.is_active
       or new.source_id is distinct from old.source_id or new.product_id is distinct from old.product_id
       or new.team_id is distinct from old.team_id)
     and not app.org_has_feature(new.organization_id, 'lead_distribution') then
    raise exception 'distribution rules are not in the plan' using errcode = 'P0001', hint = 'feature:lead_distribution';
  end if;
  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtextextended('lead_routing_rules:' || new.organization_id::text, 0));
    if (select count(*) from public.lead_routing_rules r where r.organization_id = new.organization_id) >= 50 then
      raise exception 'too many distribution rules' using errcode = 'P0001', hint = 'lead_routing_rules:max';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.lead_routing_rules_check() from public, anon, authenticated;

create or replace trigger lead_routing_rules_check before insert or update on public.lead_routing_rules
  for each row execute function app.lead_routing_rules_check();
create or replace trigger lead_routing_rules_touch before insert or update on public.lead_routing_rules
  for each row execute function app.touch_row();
create or replace trigger lead_routing_rules_audit after insert or update or delete on public.lead_routing_rules
  for each row execute function app.audit_row();

alter table public.lead_routing_rules enable row level security;
revoke all on public.lead_routing_rules from anon, authenticated;
grant select, delete on public.lead_routing_rules to authenticated;
grant insert (organization_id, position, is_active, source_id, product_id, team_id) on public.lead_routing_rules to authenticated;
grant update (position, is_active, source_id, product_id, team_id) on public.lead_routing_rules to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'lead_routing_rules' and policyname = 'lead_routing_rules_select') then
    create policy lead_routing_rules_select on public.lead_routing_rules for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'lead_routing_rules' and policyname = 'lead_routing_rules_insert') then
    create policy lead_routing_rules_insert on public.lead_routing_rules for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'lead_routing_rules' and policyname = 'lead_routing_rules_update') then
    create policy lead_routing_rules_update on public.lead_routing_rules for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'lead_routing_rules' and policyname = 'lead_routing_rules_delete') then
    create policy lead_routing_rules_delete on public.lead_routing_rules for delete to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- The weighted method's memory (schema app: no API access)
-- ----------------------------------------------------------------------------
create table if not exists app.lead_rotation_passes (
  organization_id uuid not null,
  user_id         uuid not null,
  pass            numeric not null default 0,
  primary key (organization_id, user_id),
  foreign key (organization_id, user_id) references public.memberships (organization_id, user_id) on delete cascade
);
alter table app.lead_rotation_passes enable row level security;
revoke all on app.lead_rotation_passes from public, anon, authenticated;

create table if not exists app.lead_rotation_clock (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  vtime           numeric not null default 0
);
alter table app.lead_rotation_clock enable row level security;
revoke all on app.lead_rotation_clock from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The decision
-- ----------------------------------------------------------------------------

-- Open leads of a person: open status, not converted, not in the bin (the 'load' method).
create or replace function app.member_open_load(p_org uuid, p_user uuid) returns integer
language sql stable security definer
set search_path = ''
as $$
  select count(*)::integer
    from public.leads l
    join public.lead_statuses s on s.organization_id = l.organization_id and s.id = l.status_id
   where l.organization_id = p_org and l.owner_id = p_user
     and l.deleted_at is null and l.converted_at is null and s.kind = 'open'
$$;
revoke all on function app.member_open_load(uuid, uuid) from public, anon, authenticated;

-- A uuid from text, or null when it is not one.
create or replace function app.distribution_uuid(p_text text) returns uuid
language sql immutable
set search_path = ''
as $$
  select case when p_text ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then p_text::uuid end
$$;
revoke all on function app.distribution_uuid(text) from public, anon, authenticated;

-- The team of the first active rule that matches the lead ({source_id, product_id}), else null.
create or replace function app.lead_rule_team(p_org uuid, p_lead jsonb) returns uuid
language sql stable security definer
set search_path = ''
as $$
  select r.team_id
    from public.lead_routing_rules r
   where r.organization_id = p_org and r.is_active
     and (r.source_id is null or r.source_id = app.distribution_uuid(p_lead ->> 'source_id'))
     and (r.product_id is null or r.product_id = app.distribution_uuid(p_lead ->> 'product_id'))
   order by r.position, r.created_at, r.id
   limit 1
$$;
revoke all on function app.lead_rule_team(uuid, jsonb) from public, anon, authenticated;


-- See the header. Locks the chosen member row (skip locked), like the round robin before.
create or replace function app.lead_distribution_pick(
  p_org uuid, p_team uuid, p_at timestamptz, p_lead jsonb default null, p_excluded uuid[] default '{}',
  out turn_user uuid, out owner_id uuid, out turn_was timestamptz, out team_id uuid, out method text
)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_method text := 'round_robin';
  v_weights jsonb := '{}'::jsonb;
  v_team uuid := p_team;
  v_clock numeric := 0;
  v_key numeric;
  v_turn uuid;
  v_owner uuid;
  v_was timestamptz;
begin
  if p_org is null then
    method := v_method;
    team_id := v_team;
    return;
  end if;
  if app.org_has_feature(p_org, 'lead_distribution') then
    select s.method, s.weights into v_method, v_weights
      from public.lead_distribution_settings s where s.organization_id = p_org;
    v_method := coalesce(v_method, 'round_robin');
    v_weights := coalesce(v_weights, '{}'::jsonb);
    if p_lead is not null then
      v_team := coalesce(app.lead_rule_team(p_org, p_lead), p_team);
    end if;
  end if;
  if v_method = 'weighted' then
    select c.vtime into v_clock from app.lead_rotation_clock c where c.organization_id = p_org;
    v_clock := coalesce(v_clock, 0);
  end if;

  select m.user_id, m.last_lead_assigned_at, o.owner, greatest(coalesce(rp.pass, v_clock), v_clock)
    into v_turn, v_was, v_owner, v_key
    from public.memberships m
    cross join lateral (
      select case when app.member_in_hours(p_org, m.user_id, p_at) then m.user_id
                  else app.rotation_deputy(p_org, m.user_id, p_at) end as owner
    ) o
    left join app.lead_rotation_passes rp on rp.organization_id = m.organization_id and rp.user_id = m.user_id
   where m.organization_id = p_org
     and m.status = 'active' and m.is_available and m.role <> 'viewer' and m.seat_type = 'full'
     and (v_team is null or exists (
       select 1 from public.team_members tm
        where tm.organization_id = p_org and tm.team_id = v_team and tm.user_id = m.user_id))
     and o.owner is not null
     and not (o.owner = any (coalesce(p_excluded, '{}'::uuid[])))
   order by
     case when v_method = 'weighted' then greatest(coalesce(rp.pass, v_clock), v_clock) end,
     case when v_method = 'load'
          then app.member_open_load(p_org, o.owner)::numeric / app.distribution_weight(v_weights, o.owner) end,
     m.last_lead_assigned_at nulls first, m.created_at
   limit 1
   for update of m skip locked;

  if v_turn is not null then
    update public.memberships set last_lead_assigned_at = now()
     where organization_id = p_org and user_id = v_turn;
    if v_method = 'weighted' then
      insert into app.lead_rotation_passes (organization_id, user_id, pass)
      values (p_org, v_turn, v_key + 1.0 / app.distribution_weight(v_weights, v_turn))
      on conflict (organization_id, user_id) do update set pass = excluded.pass;
      insert into app.lead_rotation_clock (organization_id, vtime)
      values (p_org, v_key)
      on conflict (organization_id) do update set vtime = greatest(app.lead_rotation_clock.vtime, excluded.vtime);
    end if;
  end if;

  turn_user := v_turn;
  owner_id := v_owner;
  turn_was := v_was;
  team_id := v_team;
  method := v_method;
end;
$$;
revoke all on function app.lead_distribution_pick(uuid, uuid, timestamptz, jsonb, uuid[]) from public, anon, authenticated;
grant execute on function app.lead_distribution_pick(uuid, uuid, timestamptz, jsonb, uuid[]) to service_role;

-- The round robin's turn (HEB-08 signature, unchanged), now through the one pick, with no rules.
create or replace function app.next_lead_turn(
  p_org uuid, p_team uuid, p_at timestamptz,
  out turn_user uuid, out owner_id uuid, out turn_was timestamptz
)
language plpgsql security definer
set search_path = ''
as $$
begin
  select p.turn_user, p.owner_id, p.turn_was into turn_user, owner_id, turn_was
    from app.lead_distribution_pick(p_org, p_team, p_at, null, '{}'::uuid[]) p;
end;
$$;
revoke all on function app.next_lead_turn(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function app.next_lead_turn(uuid, uuid, timestamptz) to service_role;

-- ----------------------------------------------------------------------------
-- public.intake_submit: the body of preferred_channel_form (018810). Only the owner pick
-- changes: a form in round robin asks app.lead_distribution_pick with its source, and the
-- team it returns (a matching rule's, else the form's) is the new lead's team, the CAP-09
-- waiting row's team and the team of the SPD-01 notices. app.org_takes_leads and the
-- v_rotation_closed lines are kept.
-- ----------------------------------------------------------------------------
create or replace function public.intake_submit(
  p_token      text,
  p_kind       text,
  p_payload    jsonb,
  p_ip_hash    text default null,
  p_user_agent text default null,
  p_is_spam    boolean default false
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_form public.forms%rowtype;
  v_status uuid;
  v_owner uuid;
  v_lead uuid;
  v_phone_e164 text;
  -- matched lead (and the contact it became) or matched contact
  v_lead_match uuid;
  v_lead_owner uuid;
  v_lead_contact uuid;
  v_contact_match uuid;
  v_contact_owner uuid;
  v_field jsonb;
  v_key text;
  v_full_name text := nullif(left(btrim(coalesce(p_payload ->> 'full_name', '')), 200), '');
  v_phone text := nullif(left(btrim(coalesce(p_payload ->> 'phone', '')), 40), '');
  v_email text := nullif(lower(left(btrim(coalesce(p_payload ->> 'email', '')), 254)), '');
  v_company text := nullif(left(btrim(coalesce(p_payload ->> 'company_name', '')), 200), '');
  v_message text := nullif(left(btrim(coalesce(p_payload ->> 'message', '')), 5000), '');
  -- CAP-02 / ADS-01: where the visit came from (cleaned, known keys only)
  v_attr jsonb := app.intake_attribution(p_payload -> 'attribution');
  -- CAP-01: custom values as sent, and what is kept of them
  v_custom_in jsonb := case when jsonb_typeof(p_payload -> 'custom') = 'object' then p_payload -> 'custom' else '{}'::jsonb end;
  v_custom jsonb := '{}'::jsonb;
  -- values of the shown fields by form key, for the conditions of later fields
  v_values jsonb := '{}'::jsonb;
  v_shown text[] := '{}';
  v_value jsonb;
  v_cond jsonb;
  v_type text;
  v_options jsonb;
  -- SPD-05: when the person asked to be called back ('now' or a slot 'YYYY-MM-DD-HH', its business date and start hour)
  v_callback text := nullif(left(btrim(coalesce(p_payload ->> 'callback', '')), 40), '');
  v_callback_at timestamptz;
  v_callback_phrase text;
  v_callback_note text;
  v_task_owner uuid;
  v_task uuid;
  -- CAP-09: the rotation has members, but none is in working hours (or all are on leave)
  v_rotation_closed boolean := false;
  -- CAP-08: the team the new lead belongs to and is distributed in (the form's, or a matching rule's)
  v_team uuid;
  -- HEB-08: the form's owner was away with no usable deputy
  v_absent uuid;
  -- CON-10: how the person likes to be contacted, when the form asks (one of the four, else none)
  v_channel text := case when p_payload ->> 'preferred_channel' in ('phone', 'whatsapp', 'email', 'sms')
                         then p_payload ->> 'preferred_channel' end;
begin
  select * into v_form from public.forms f
   where f.token = coalesce(p_token, '') and f.kind = p_kind;
  if not found or not v_form.is_active then
    raise exception 'form not found' using errcode = 'P0002';
  end if;
  -- read-only and suspended businesses keep taking leads (owner, 8 and 13 October 2026)
  if not app.org_takes_leads(v_form.organization_id) then
    raise exception 'the organization is read-only' using errcode = 'P0001', hint = 'org:read_only';
  end if;

  -- rate limits: per sender (10 in 10 minutes) and per form (500 an hour)
  if p_ip_hash is not null and (
    select count(*) from public.form_submissions s
     where s.form_id = v_form.id and s.ip_hash = p_ip_hash and s.created_at > now() - interval '10 minutes'
  ) >= 10 then
    raise exception 'too many submissions' using errcode = 'P0001', hint = 'rate_limited';
  end if;
  if (
    select count(*) from public.form_submissions s
     where s.form_id = v_form.id and s.created_at > now() - interval '1 hour'
  ) >= 500 then
    raise exception 'too many submissions' using errcode = 'P0001', hint = 'rate_limited';
  end if;

  if p_is_spam then
    insert into public.form_submissions (organization_id, form_id, status, payload, ip_hash, user_agent)
    values (v_form.organization_id, v_form.id, 'spam', coalesce(p_payload, '{}'::jsonb), p_ip_hash, left(p_user_agent, 300));
    return jsonb_build_object('status', 'spam', 'success_message', v_form.success_message, 'redirect_url', v_form.redirect_url);
  end if;

  -- CAP-01: the form's fields in order. A hidden field loses its value and is
  -- never required; a shown custom field must hold a valid value.
  if v_form.kind = 'form' then
    for v_field in
      select a.value from jsonb_array_elements(case when jsonb_typeof(v_form.fields) = 'array' then v_form.fields else '[]'::jsonb end) a
    loop
      continue when jsonb_typeof(v_field) <> 'object';
      v_key := v_field ->> 'key';
      continue when v_key is null or v_key = any (v_shown);
      v_type := null;
      v_options := null;
      if v_key like 'cf:%' then
        select d.field_type, d.options into v_type, v_options
          from public.field_definitions d
         where d.organization_id = v_form.organization_id and d.object_type = 'lead'
           and d.key = substr(v_key, 4) and d.is_active;
        -- a field that is gone, switched off or picks a team member is not on the form
        continue when v_type is null or v_type = 'user';
        v_value := v_custom_in -> substr(v_key, 4);
      elsif v_key = 'full_name' then v_value := to_jsonb(v_full_name);
      elsif v_key = 'phone' then v_value := to_jsonb(v_phone);
      elsif v_key = 'email' then v_value := to_jsonb(v_email);
      elsif v_key = 'company_name' then v_value := to_jsonb(v_company);
      elsif v_key = 'message' then v_value := to_jsonb(v_message);
      else
        continue;
      end if;
      if v_value is not null and jsonb_typeof(v_value) = 'null' then
        v_value := null;
      end if;

      v_cond := v_field -> 'show_if';
      if jsonb_typeof(v_cond) = 'object'
         and not coalesce((v_cond ->> 'field') = any (v_shown)
                          and app.intake_condition_met(v_values -> (v_cond ->> 'field'), v_cond ->> 'value'), false) then
        -- hidden: whatever was sent for it is dropped
        if v_key = 'full_name' then v_full_name := null;
        elsif v_key = 'phone' then v_phone := null;
        elsif v_key = 'email' then v_email := null;
        elsif v_key = 'company_name' then v_company := null;
        elsif v_key = 'message' then v_message := null;
        end if;
        continue;
      end if;

      v_shown := v_shown || v_key;
      if v_type is not null and app.intake_has_value(v_value) then
        if not app.custom_value_ok(v_type, v_options, v_value) then
          raise exception 'invalid custom field: %', substr(v_key, 4) using errcode = '22023';
        end if;
        v_custom := v_custom || jsonb_build_object(substr(v_key, 4), v_value);
      end if;
      if app.intake_has_value(v_value) then
        v_values := v_values || jsonb_build_object(v_key, v_value);
      end if;
      if v_field -> 'required' = 'true'::jsonb and not app.intake_has_value(v_value) then
        raise exception 'required field missing: %', v_key using errcode = '22023';
      end if;
    end loop;
  end if;

  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid email address' using errcode = '22023';
  end if;
  if v_full_name is null and v_phone is null and v_email is null then
    raise exception 'a name, phone or email is required' using errcode = '22023';
  end if;

  -- CON-10: a channel counts only when the form asks
  if v_form.kind <> 'form' or not v_form.channel_choice then
    v_channel := null;
  end if;

  -- SPD-05: a call-back time counts only when the form offers the choice; a
  -- choice that is not one of the slots, or a slot that has ended, is refused
  -- (SPD-05 follow-ups: the slots this form offers now, app.intake_callback_pick())
  if v_form.kind = 'form' and v_form.callback_choice and v_callback is not null then
    select p.at, p.phrase into v_callback_at, v_callback_phrase
      from app.intake_callback_pick(v_form.organization_id, v_form.callback_slots_off, v_callback, now()) p;
    v_callback_note := 'ביקשו שנחזור אליהם ' || v_callback_phrase;
  else
    v_callback := null;
  end if;

  -- A repeat inquiry (same phone or email as a live lead, or as a contact)
  -- goes onto the existing record's timeline instead of creating a new lead.
  v_phone_e164 := app.normalize_phone(v_phone);
  select l.id, l.owner_id, l.converted_contact_id into v_lead_match, v_lead_owner, v_lead_contact
    from public.leads l
   where l.organization_id = v_form.organization_id and l.deleted_at is null
     and ((v_phone_e164 is not null and l.phone_e164 = v_phone_e164)
          or (v_email is not null and lower(l.email) = v_email))
   order by l.created_at desc
   limit 1;
  if v_lead_match is null then
    -- CON-01: the contact's primary phone or email, or any of its other ones
    select c.id, c.owner_id into v_contact_match, v_contact_owner
      from public.contacts c
     where c.organization_id = v_form.organization_id and c.deleted_at is null
       and c.id in (
         select c2.id from public.contacts c2
          where c2.organization_id = v_form.organization_id
            and ((v_phone_e164 is not null and c2.phone_e164 = v_phone_e164)
                 or (v_email is not null and lower(c2.email) = v_email))
         union
         select ch.contact_id from public.contact_channels ch
          where ch.organization_id = v_form.organization_id
            and ((v_phone_e164 is not null and ch.value_e164 = v_phone_e164)
                 or (v_email is not null and ch.kind = 'email' and ch.value = v_email)))
     order by c.created_at desc
     limit 1;
  end if;

  if v_lead_match is not null or v_contact_match is not null then
    -- first touch wins: the lead keeps its attribution and custom fields;
    -- this visit's are kept on the inquiry
    insert into public.activities (organization_id, type, body, lead_id, contact_id, metadata)
    values (
      v_form.organization_id, 'inquiry', v_message, v_lead_match,
      coalesce(v_lead_contact, v_contact_match),
      jsonb_build_object('form_id', v_form.id, 'form_name', v_form.name,
                         'full_name', v_full_name, 'phone', v_phone, 'email', v_email, 'company_name', v_company)
        || case when v_attr <> '{}'::jsonb then jsonb_build_object('attribution', v_attr) else '{}'::jsonb end
        || case when v_custom <> '{}'::jsonb then jsonb_build_object('custom_fields', v_custom) else '{}'::jsonb end
        || case when v_callback_at is not null then jsonb_build_object('callback_at', v_callback_at) else '{}'::jsonb end
        || case when v_channel is not null then jsonb_build_object('preferred_channel', v_channel) else '{}'::jsonb end);
    -- CON-10 (owner, 14 October 2026): the form's channel fills an empty one, or replaces one
    -- that came from a form; a channel a person set (or one older than its source) stays
    if v_channel is not null then
      if v_lead_match is not null then
        update public.leads l
           set preferred_channel = v_channel, preferred_channel_source = 'form'
         where l.organization_id = v_form.organization_id and l.id = v_lead_match
           and (l.preferred_channel is null or l.preferred_channel_source = 'form')
           and l.preferred_channel is distinct from v_channel;
      end if;
      if coalesce(v_lead_contact, v_contact_match) is not null then
        update public.contacts c
           set preferred_channel = v_channel, preferred_channel_source = 'form'
         where c.organization_id = v_form.organization_id and c.id = coalesce(v_lead_contact, v_contact_match)
           and (c.preferred_channel is null or c.preferred_channel_source = 'form')
           and c.preferred_channel is distinct from v_channel;
      end if;
    end if;
    v_owner := coalesce(v_lead_owner, v_contact_owner);
    if v_owner is not null then
      -- SPD-05: the requested call-back time, when there is one, in the body
      insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
      values (v_form.organization_id, v_owner, 'inquiry', 'פנייה חוזרת מלקוח קיים', v_callback_note,
              case when v_lead_match is not null then 'lead' else 'contact' end,
              coalesce(v_lead_match, v_contact_match));
    end if;
    -- SPD-05: a call task for the record's owner, else the form's owner
    if v_callback_at is not null then
      -- the record's owner while an active member who is not a viewer, else the form's owner, same check
      select m.user_id into v_task_owner from public.memberships m
       where m.organization_id = v_form.organization_id and m.user_id = v_owner
         and m.status = 'active' and m.role <> 'viewer';
      if v_task_owner is null then
        select m.user_id into v_task_owner from public.memberships m
         where m.organization_id = v_form.organization_id and m.user_id = v_form.owner_id
           and m.status = 'active' and m.role <> 'viewer';
      end if;
      v_task := app.intake_call_task(v_form.organization_id, v_task_owner, v_lead_match,
                                     coalesce(v_lead_contact, v_contact_match), v_callback = 'now', v_callback_at,
                                     v_callback_phrase, coalesce(v_full_name, v_phone, v_email), v_form.name);
      -- SPD-01: the lead's call task follows "לקחתי"
      if v_lead_match is not null then
        insert into app.intake_callback_tasks (task_id, organization_id, lead_id)
        values (v_task, v_form.organization_id, v_lead_match) on conflict do nothing;
      end if;
    end if;
    insert into public.form_submissions (organization_id, form_id, status, lead_id, payload, ip_hash, user_agent)
    values (v_form.organization_id, v_form.id, 'duplicate', v_lead_match, coalesce(p_payload, '{}'::jsonb), p_ip_hash, left(p_user_agent, 300));
    return jsonb_build_object(
      'status', 'duplicate',
      'lead_id', v_lead_match,
      'contact_id', coalesce(v_lead_contact, v_contact_match),
      'success_message', v_form.success_message,
      'redirect_url', v_form.redirect_url);
  end if;

  select s.id into v_status from public.lead_statuses s
   where s.organization_id = v_form.organization_id and s.kind = 'open'
   order by s.is_default desc, s.position
   limit 1;
  if v_status is null then
    raise exception 'the organization has no open lead status' using errcode = 'P0001';
  end if;

  v_team := v_form.team_id;
  if v_form.assign_mode = 'round_robin' then
    -- CAP-08: the one pick (method, weights, rules by the form's source)
    select p.owner_id, p.team_id into v_owner, v_team
      from app.lead_distribution_pick(v_form.organization_id, v_form.team_id, now(),
                                      jsonb_build_object('source_id', v_form.source_id), '{}'::uuid[]) p;
    -- CAP-09 (owner, 13 October 2026): nobody of the rotation in hours: the lead waits
    -- with no owner for a "לקחתי"; nobody available at all keeps the form owner's fallback
    v_rotation_closed := v_owner is null and app.rotation_has_members(v_form.organization_id, v_team);
  end if;
  if v_owner is null and not v_rotation_closed then
    select m.user_id into v_owner from public.memberships m
     where m.organization_id = v_form.organization_id and m.user_id = v_form.owner_id
       and m.status = 'active' and m.role <> 'viewer';
    -- HEB-08: an absent form owner's new lead goes to their deputy; with no usable
    -- deputy it has no owner and takes the SPD-01 route (no chain)
    -- (app.auto_lead_owner: the rule every automatic assigner of a fixed person uses)
    if v_owner is not null then
      select a.owner_id, a.absent_user into v_owner, v_absent
        from app.auto_lead_owner(v_form.organization_id, v_owner, now()) a;
    end if;
  end if;

  -- SPD-01: the owner is told as 'lead_new' (app.notify_assignment())
  perform set_config('app.intake', 'on', true);
  insert into public.leads (organization_id, status_id, source_id, owner_id, team_id,
                            full_name, phone, email, company_name, message,
                            campaign, utm, referrer_url, landing_url, gclid, fbclid, ctwa_clid,
                            custom_fields, preferred_channel, preferred_channel_source)
  values (v_form.organization_id, v_status, v_form.source_id, v_owner, v_team,
          v_full_name, v_phone, v_email, v_company, v_message,
          v_attr ->> 'utm_campaign',
          jsonb_strip_nulls(jsonb_build_object(
            'utm_source', v_attr -> 'utm_source', 'utm_medium', v_attr -> 'utm_medium',
            'utm_campaign', v_attr -> 'utm_campaign', 'utm_term', v_attr -> 'utm_term',
            'utm_content', v_attr -> 'utm_content',
            -- CAP-02: the extra parameters of the closed list, in one place
            'extra', v_attr -> 'extra')),
          v_attr ->> 'referrer_url', v_attr ->> 'landing_url',
          v_attr ->> 'gclid', v_attr ->> 'fbclid', v_attr ->> 'ctwa_clid',
          v_custom, v_channel, case when v_channel is not null then 'form' end)
  returning id into v_lead;
  perform set_config('app.intake', '', true);

  -- CAP-09: if nobody takes it, the rotation gives it to the first member back in hours
  if v_rotation_closed then
    insert into app.rotation_waiting_leads (lead_id, organization_id, team_id)
    values (v_lead, v_form.organization_id, v_team) on conflict do nothing;
  end if;

  -- HEB-08: back from the absence, the form's owner gets it if nobody took it (app.return_absence_leads())
  if v_owner is null and v_absent is not null then
    perform app.lead_waits_for_absent(v_form.organization_id, v_lead, v_form.id, v_absent);
  end if;

  -- SPD-01: nobody owns it: whoever may take it is told, and the first "לקחתי" wins
  if v_owner is null then
    insert into public.notifications (organization_id, user_id, type, title, entity_type, entity_id)
    select v_form.organization_id, r.user_id, 'lead_new', 'ליד חדש מחכה למי שייקח אותו', 'lead', v_lead
      from app.intake_unowned_recipients(v_form.organization_id, v_team) r;
  end if;

  -- SPD-05: a call task for the new lead's owner, and the requested time in the
  -- body of the new-lead notification (whichever kind it was sent as)
  if v_callback_at is not null then
    v_task := app.intake_call_task(v_form.organization_id, v_owner, v_lead, null, v_callback = 'now', v_callback_at,
                                   v_callback_phrase, coalesce(v_full_name, v_phone, v_email), v_form.name);
    -- SPD-01: the lead's call task follows "לקחתי"
    insert into app.intake_callback_tasks (task_id, organization_id, lead_id)
    values (v_task, v_form.organization_id, v_lead) on conflict do nothing;
    update public.notifications n set body = v_callback_note
     where n.organization_id = v_form.organization_id and n.entity_type = 'lead' and n.entity_id = v_lead
       and n.body is null;
  end if;

  insert into public.form_submissions (organization_id, form_id, status, lead_id, payload, ip_hash, user_agent)
  values (v_form.organization_id, v_form.id, 'accepted', v_lead, coalesce(p_payload, '{}'::jsonb), p_ip_hash, left(p_user_agent, 300));

  return jsonb_build_object(
    'status', 'accepted',
    'lead_id', v_lead,
    'success_message', v_form.success_message,
    'redirect_url', v_form.redirect_url);
end;
$$;
revoke all on function public.intake_submit(text, text, jsonb, text, text, boolean) from public, anon, authenticated;
grant execute on function public.intake_submit(text, text, jsonb, text, text, boolean) to service_role;

-- ----------------------------------------------------------------------------
-- app.check_lead_responses: the body of absence_deputy_followups (018730). The SPD-03
-- pass-on asks app.lead_distribution_pick once with the excluded people, instead of looping
-- over app.next_lead_turn and putting the skipped members' stamps back: the pick never
-- stamps a member it skips, so they keep their turn, under every method.
-- ----------------------------------------------------------------------------
create or replace function app.check_lead_responses() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_lead record;
  v_target integer;
  v_action text;
  v_max integer;
  v_due timestamptz;
  v_owner_name text;
  v_new_name text;
  v_excluded uuid[];
  v_new uuid;
  v_done integer := 0;
begin
  for v_row in
    select d.lead_id, d.organization_id, d.window_start, d.created_at, d.passes, d.passed_from
      from (
        select c.lead_id, c.organization_id, c.window_start, c.created_at, c.next_check_at, c.passes, c.passed_from,
               row_number() over (partition by c.organization_id order by c.next_check_at, c.created_at) as n
          from app.lead_response_checks c
         where c.resolved_at is null and c.next_check_at <= now()
      ) d
     where d.n <= app.response_check_per_org()
     order by d.next_check_at, d.created_at
     limit app.response_check_limit()
  loop
    begin
      begin
        select l.owner_id, l.team_id, l.deleted_at, l.converted_at, l.taken_at,
               coalesce(nullif(btrim(l.full_name), ''), nullif(btrim(l.company_name), ''), l.phone, l.email, 'ליד ללא שם') as name,
               s.kind as status_kind
          into v_lead
          from public.leads l
          join public.lead_statuses s on s.organization_id = l.organization_id and s.id = l.status_id
         where l.organization_id = v_row.organization_id and l.id = v_row.lead_id
           for update of l nowait;
      exception when lock_not_available then
        -- a handover or a "לקחתי" holds the lead: look again in a minute (never waits)
        perform app.response_check_later(v_row.lead_id, interval '1 minute');
        continue;
      end;

      if not found or v_lead.deleted_at is not null or v_lead.converted_at is not null or v_lead.status_kind <> 'open' then
        update app.lead_response_checks set resolved_at = now(), outcome = 'closed' where lead_id = v_row.lead_id;
      elsif exists (
        select 1 from public.activities a
         where a.organization_id = v_row.organization_id and a.lead_id = v_row.lead_id
           and a.created_by is not null and a.type = any (app.contact_types()) and not a.is_private) then
        update app.lead_response_checks set resolved_at = now(), outcome = 'contacted' where lead_id = v_row.lead_id;
      elsif v_row.created_at < now() - interval '14 days' then
        update app.lead_response_checks set resolved_at = now(), outcome = 'expired' where lead_id = v_row.lead_id;
      elsif not app.org_writable(v_row.organization_id) then
        update app.lead_response_checks set next_check_at = now() + interval '15 minutes' where lead_id = v_row.lead_id;
      elsif v_lead.owner_id is null then
        -- nobody owns it yet (SPD-01, CAP-09): the owner trigger wakes the row
        update app.lead_response_checks set next_check_at = now() + interval '1 day' where lead_id = v_row.lead_id;
      else
        v_target := app.response_target_minutes(v_row.organization_id);
        v_due := app.response_deadline(v_row.organization_id, v_row.window_start, v_target);
        if v_due is null then
          update app.lead_response_checks set next_check_at = now() + interval '1 day' where lead_id = v_row.lead_id;
        elsif v_due > now() then
          -- at most 15 minutes ahead, so a changed target or calendar is seen soon
          update app.lead_response_checks set next_check_at = least(v_due, now() + interval '15 minutes') where lead_id = v_row.lead_id;
        else
          select coalesce(s.breach_action, 'notify'), coalesce(s.max_passes, 2) into v_action, v_max
            from (select 1) one
            left join public.lead_response_settings s on s.organization_id = v_row.organization_id;
          select nullif(btrim(p.full_name), '') into v_owner_name from public.profiles p where p.id = v_lead.owner_id;

          -- SPD-03: pass it on, when allowed and someone qualifies
          v_new := null;
          if v_action = 'pass_on' and v_lead.taken_at is null and v_row.passes < v_max
             and app.org_has_feature(v_row.organization_id, 'auto_reassign') then
            v_excluded := array_append(v_row.passed_from, v_lead.owner_id);
            -- CAP-08: one pick (the business's method, no rules: the lead's team already is the
            -- pool) that skips everyone the lead was taken from; the skipped keep their turn
            select p.owner_id into v_new
              from app.lead_distribution_pick(v_row.organization_id, v_lead.team_id, now(), null, v_excluded) p;
          end if;

          if v_action = 'none' then
            update app.lead_response_checks set resolved_at = now(), outcome = 'no_action' where lead_id = v_row.lead_id;
          elsif v_new is not null then
            -- notify_assignment tells the new owner ('assigned'); leads_response_owner starts their clock
            update public.leads set owner_id = v_new
             where organization_id = v_row.organization_id and id = v_row.lead_id and owner_id = v_lead.owner_id;
            -- the lead's open SPD-05 call task follows it, as on "לקחתי" (marked in
            -- app.intake_callback_tasks; app.intake_follow keeps notify_assignment quiet)
            perform set_config('app.intake_follow', 'on', true);
            update public.tasks t
               set owner_id = v_new
             where t.organization_id = v_row.organization_id and t.lead_id = v_row.lead_id
               and t.owner_id = v_lead.owner_id and t.status = 'open' and t.deleted_at is null
               and exists (select 1 from app.intake_callback_tasks ct
                            where ct.organization_id = v_row.organization_id and ct.task_id = t.id);
            perform set_config('app.intake_follow', '', true);
            select nullif(btrim(p.full_name), '') into v_new_name from public.profiles p where p.id = v_new;
            insert into public.activities (organization_id, type, lead_id, body, metadata)
            values (v_row.organization_id, 'system', v_row.lead_id,
                    left('הליד הועבר' || coalesce(' מ' || v_owner_name, '') || coalesce(' ל' || v_new_name, '')
                         || ' כי לא נוצר קשר בתוך ' || v_target || ' דקות', 500),
                    jsonb_build_object('kind', 'response_pass', 'from_user_id', v_lead.owner_id, 'to_user_id', v_new,
                                       'target_minutes', v_target, 'pass', v_row.passes + 1));
            insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
            values (v_row.organization_id, v_lead.owner_id, 'response_overdue',
                    'ליד הועבר לנציג אחר',
                    left(v_lead.name || ' · לא נוצר קשר בתוך ' || v_target || ' דקות', 500),
                    'lead', v_row.lead_id);
            insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
            select v_row.organization_id, r.user_id, 'response_overdue',
                   left('ליד לא נענה בתוך ' || v_target || ' דקות והועבר', 200),
                   left(v_lead.name || coalesce(' · מ' || v_owner_name, '') || coalesce(' ל' || v_new_name, ''), 500),
                   'lead', v_row.lead_id
              from app.response_managers(v_row.organization_id, v_lead.team_id, v_new) r
             -- the new owner already got 'assigned' (review L7)
             where r.user_id <> v_lead.owner_id and r.user_id <> v_new;
            update app.lead_response_checks
               set passes = passes + 1,
                   passed_from = v_excluded,
                   next_check_at = now() + interval '1 minute'
             where lead_id = v_row.lead_id;
            v_done := v_done + 1;
          else
            insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
            select v_row.organization_id, r.user_id, 'response_overdue',
                   left('ליד מחכה למענה יותר מ-' || v_target || ' דקות', 200),
                   left(v_lead.name || coalesce(' · באחריות ' || v_owner_name, ''), 500),
                   'lead', v_row.lead_id
              from app.response_managers(v_row.organization_id, v_lead.team_id, v_lead.owner_id) r;
            update app.lead_response_checks set resolved_at = now(), notified_at = now(), outcome = 'notified'
             where lead_id = v_row.lead_id;
            v_done := v_done + 1;
          end if;
        end if;
      end if;
    exception when others then
      -- this row's changes are rolled back; look at it again later (never waits), go on with the others
      begin
        perform app.response_check_later(v_row.lead_id, interval '10 minutes');
      exception when others then
        null;
      end;
    end;
  end loop;
  return v_done;
end;
$$;
revoke all on function app.check_lead_responses() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- app.run_automation_actions: the body of absence_warning_name (018800). An automation's
-- round robin on a lead goes through app.lead_distribution_pick with the lead's source and
-- requested product (the rules); on other records through app.next_lead_owner, as before
-- (which now applies the business's method too).
-- ----------------------------------------------------------------------------
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
          if p_entity = 'lead' then
            -- CAP-08: the one pick, with the rules by the lead's source and requested product
            select p.owner_id into v_user
              from app.lead_distribution_pick(v_org, (v_action ->> 'team_id')::uuid, now(),
                                              jsonb_build_object('source_id', v_record ->> 'source_id',
                                                                 'product_id', v_record ->> 'requested_product_id'),
                                              '{}'::uuid[]) p;
          else
            v_user := app.next_lead_owner(v_org, (v_action ->> 'team_id')::uuid);
          end if;
          if v_user is null then
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
