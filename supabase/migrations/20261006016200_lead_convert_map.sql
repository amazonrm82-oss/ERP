-- =============================================================================
-- Field mapping on lead conversion (LEAD-06, wave 2)
-- =============================================================================
-- Until now a lead's custom field values were copied on conversion to the
-- contact and deal field with the same label and type (0029). Owners and admins
-- can now say, per lead custom field and per target (contact | deal), where the
-- value goes. public.conversion_field_maps, mode:
--   * no row, or mode 'auto'   the same-label rule (same label, same type,
--                              active, first by position), skipping every
--                              field a hand-picked mapping claims (below)
--   * mode 'none'              not copied to this target
--   * mode 'field'             copied to target_field_id, while that field is
--                              active and of the same type; otherwise nothing
--                              is copied (no fall back to the same-label rule)
-- A field picked by hand (mode 'field') is claimed: no other lead field ever
-- reaches it through the same-label rule, even when the lead field that claims
-- it is empty or its value does not fit on that lead. At most one lead field
-- claims a field (unique). Two lead fields that reach one field by the same-label
-- rule: the first by position wins (before, the result depended on row order).
-- Values still go through app.custom_value_ok().
-- A target must be a field of the target type with the same field type as the
-- lead field (trigger conversion_field_maps_check, hint 'convert_map:invalid').
-- When the target field is deleted, nothing is copied and the value stays on the
-- lead, with no fall back to the same-label rule (owner, 13 October 2026,
-- DECISIONS.md): the FK sets the target to null and the trigger switches the
-- mode to 'none' and sets target_removed, so the row remembers that its field
-- was deleted (as distinct from a person's "do not copy"). target_removed is
-- server-only (no client grant); any write of a person clears it. The settings
-- screen shows such rows, and owners and admins see a reminder until then.
-- When the lead field is deleted, its rows go with it (cascade).
-- public.save_conversion_field_map(org, map) applies the whole screen in one
-- transaction (security invoker: RLS decides; a write RLS hides raises 42501).
-- It never deletes: going back to "auto" sets mode 'auto'.
-- public.convert_lead() is unchanged: the trigger leads_convert_custom_fields
-- calls app.carry_custom_fields(), which is redefined here.
-- Configuration like field_definitions: everyone in the organization reads,
-- owners and admins of a writable organization write; audited.
-- Every statement is safe to run twice. No deletes, no drops.

-- the composite foreign keys below need it; field_definitions.id is already unique
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.field_definitions'::regclass and conname = 'field_definitions_organization_id_id_key') then
    alter table public.field_definitions add constraint field_definitions_organization_id_id_key unique (organization_id, id);
  end if;
end;
$$;

create table if not exists public.conversion_field_maps (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  lead_field_id   uuid not null,
  target_type     text not null constraint conversion_field_maps_target_type_check check (target_type in ('contact', 'deal')),
  mode            text not null default 'field' constraint conversion_field_maps_mode_check check (mode in ('auto', 'none', 'field')),
  target_field_id uuid,
  -- server only: the picked field was deleted and no person has written the row since
  target_removed  boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint conversion_field_maps_mode_target check ((mode = 'field') = (target_field_id is not null)),
  constraint conversion_field_maps_removed_none check (not target_removed or mode = 'none'),
  unique (organization_id, id),
  unique (organization_id, lead_field_id, target_type),
  -- one lead field per hand-picked target (nulls are distinct)
  unique (organization_id, target_type, target_field_id),
  constraint conversion_field_maps_lead_field_fk foreign key (organization_id, lead_field_id)
    references public.field_definitions (organization_id, id) on delete cascade,
  constraint conversion_field_maps_target_field_fk foreign key (organization_id, target_field_id)
    references public.field_definitions (organization_id, id) on delete set null (target_field_id)
);

alter table public.conversion_field_maps add column if not exists target_removed boolean not null default false;

alter table public.conversion_field_maps enable row level security;

revoke all on public.conversion_field_maps from anon, authenticated;
grant select, delete on public.conversion_field_maps to authenticated;
grant insert (organization_id, lead_field_id, target_type, mode, target_field_id) on public.conversion_field_maps to authenticated;
grant update (mode, target_field_id) on public.conversion_field_maps to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'conversion_field_maps' and policyname = 'conversion_field_maps_select') then
    create policy conversion_field_maps_select on public.conversion_field_maps for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'conversion_field_maps' and policyname = 'conversion_field_maps_insert') then
    create policy conversion_field_maps_insert on public.conversion_field_maps for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'conversion_field_maps' and policyname = 'conversion_field_maps_update') then
    create policy conversion_field_maps_update on public.conversion_field_maps for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'conversion_field_maps' and policyname = 'conversion_field_maps_delete') then
    create policy conversion_field_maps_delete on public.conversion_field_maps for delete to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

create index if not exists conversion_field_maps_target_idx
  on public.conversion_field_maps (organization_id, target_field_id) where target_field_id is not null;

create or replace trigger conversion_field_maps_touch before update on public.conversion_field_maps
  for each row execute function app.touch_row();
create or replace trigger conversion_field_maps_audit after insert or update or delete on public.conversion_field_maps
  for each row execute function app.audit_row();

-- A lead field, and a target of the target type with the same field type.
-- Security invoker: it reads field_definitions with the writer's rights, and it
-- checks nothing for a writer who is not an owner or admin of the row's
-- organization (RLS refuses them right after, with the same 42501 whatever the
-- organization holds). The lead field is checked only when the row is created
-- or points at another lead field, so the foreign key's clearing of a deleted
-- target always passes (also in a statement that deletes the lead field too, or
-- after the lead field was moved to another record type). It also keeps
-- target_removed: true only when the FK clears a target whose field is gone,
-- false on every other write.
create or replace function app.conversion_field_maps_check() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_lead_type text;
  v_lead_changed boolean;
begin
  -- the target field was deleted (FK set null): nothing is copied, and the row remembers why
  if tg_op = 'UPDATE' and new.mode = 'field' and new.target_field_id is null and old.target_field_id is not null then
    new.mode := 'none';
    new.target_removed := not exists (
      select 1 from public.field_definitions d where d.organization_id = old.organization_id and d.id = old.target_field_id
    );
  else
    new.target_removed := false;
  end if;
  if not app.is_admin(new.organization_id) then
    return new;
  end if;
  v_lead_changed := tg_op = 'INSERT' or new.lead_field_id is distinct from old.lead_field_id
                    or new.organization_id is distinct from old.organization_id;
  if v_lead_changed or (new.target_field_id is not null
      and (new.target_field_id is distinct from old.target_field_id or new.target_type is distinct from old.target_type)) then
    select s.field_type into v_lead_type
      from public.field_definitions s
     where s.organization_id = new.organization_id and s.id = new.lead_field_id and s.object_type = 'lead';
    if v_lead_type is null then
      raise exception 'not a lead custom field' using errcode = '23514', hint = 'convert_map:invalid';
    end if;
    if new.target_field_id is not null and not exists (
      select 1 from public.field_definitions d
       where d.organization_id = new.organization_id and d.id = new.target_field_id
         and d.object_type = new.target_type and d.field_type = v_lead_type
    ) then
      raise exception 'target field does not fit' using errcode = '23514', hint = 'convert_map:invalid';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.conversion_field_maps_check() from public, anon, authenticated;

create or replace trigger conversion_field_maps_check
  before insert or update of organization_id, lead_field_id, target_type, mode, target_field_id on public.conversion_field_maps
  for each row execute function app.conversion_field_maps_check();

-- ----------------------------------------------------------------------------
-- Saving the settings screen in one transaction
-- ----------------------------------------------------------------------------
-- p_map: [{"lead_field_id": uuid, "target_type": "contact"|"deal",
--          "choice": "auto"|"none"|<field uuid>}, ...], at most 400 entries,
-- one per lead field and target type. Entries that match what is stored are
-- left alone. A newly picked field must be active, of the target type and of
-- the lead field's type (hint 'convert_map:invalid'); two entries may not pick
-- the same field (23505, hint 'convert_map:duplicate'), nor may an entry pick a
-- field another stored mapping holds (the unique constraint, 23505). A field
-- that moves from one lead field to another is released first, so a swap works.
-- Returns {"changed": n}.
create or replace function public.save_conversion_field_map(p_org uuid, p_map jsonb) returns jsonb
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_item jsonb;
  v_lead uuid;
  v_type text;
  v_choice text;
  v_target uuid;
  v_lead_type text;
  v_row public.conversion_field_maps%rowtype;
  v_state text;
  v_n integer;
  v_changed integer := 0;
begin
  if p_org is null or p_map is null or jsonb_typeof(p_map) <> 'array' or jsonb_array_length(p_map) > 400 then
    raise exception 'invalid mapping' using errcode = '22023', hint = 'convert_map:invalid';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_map) e
     where jsonb_typeof(e) <> 'object'
        or jsonb_typeof(e -> 'lead_field_id') is distinct from 'string' or (e ->> 'lead_field_id') !~ v_uuid
        or jsonb_typeof(e -> 'target_type') is distinct from 'string' or (e ->> 'target_type') not in ('contact', 'deal')
        or jsonb_typeof(e -> 'choice') is distinct from 'string'
        or not ((e ->> 'choice') in ('auto', 'none') or (e ->> 'choice') ~ v_uuid)
  ) or (
    select count(*) <> count(distinct (e ->> 'lead_field_id', e ->> 'target_type'))
      from jsonb_array_elements(p_map) e
  ) then
    raise exception 'invalid mapping' using errcode = '22023', hint = 'convert_map:invalid';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_map) e
     where (e ->> 'choice') not in ('auto', 'none')
     group by e ->> 'target_type', e ->> 'choice'
    having count(*) > 1
  ) then
    raise exception 'one field picked twice' using errcode = '23505', hint = 'convert_map:duplicate';
  end if;

  -- 1. every entry that changes lets go of a field it holds, and "auto" / "none" are written
  for v_item in select e from jsonb_array_elements(p_map) e loop
    v_lead := (v_item ->> 'lead_field_id')::uuid;
    v_type := v_item ->> 'target_type';
    v_choice := v_item ->> 'choice';
    select * into v_row from public.conversion_field_maps m
     where m.organization_id = p_org and m.lead_field_id = v_lead and m.target_type = v_type;
    -- a row whose field was deleted always changes, so the choice of a person clears target_removed
    v_state := case when v_row.id is null then 'auto' when v_row.target_removed then 'removed'
                    when v_row.mode = 'field' then v_row.target_field_id::text else v_row.mode end;
    continue when v_state = v_choice;
    if v_row.id is null then
      continue when v_choice <> 'none';
      if not exists (select 1 from public.field_definitions s where s.organization_id = p_org and s.id = v_lead and s.object_type = 'lead') then
        raise exception 'not a lead custom field' using errcode = '23514', hint = 'convert_map:invalid';
      end if;
      insert into public.conversion_field_maps (organization_id, lead_field_id, target_type, mode, target_field_id)
      values (p_org, v_lead, v_type, 'none', null);
      v_changed := v_changed + 1;
    elsif v_choice in ('auto', 'none') or v_row.mode = 'field' then
      update public.conversion_field_maps m
         set mode = case when v_choice = 'auto' then 'auto' else 'none' end, target_field_id = null
       where m.organization_id = p_org and m.id = v_row.id;
      get diagnostics v_n = row_count;
      if v_n = 0 then
        raise exception 'not permitted' using errcode = '42501';
      end if;
      v_changed := v_changed + 1;
    end if;
  end loop;

  -- 2. the fields picked by hand
  for v_item in select e from jsonb_array_elements(p_map) e where (e ->> 'choice') not in ('auto', 'none') loop
    v_lead := (v_item ->> 'lead_field_id')::uuid;
    v_type := v_item ->> 'target_type';
    v_target := (v_item ->> 'choice')::uuid;
    select * into v_row from public.conversion_field_maps m
     where m.organization_id = p_org and m.lead_field_id = v_lead and m.target_type = v_type;
    continue when v_row.id is not null and v_row.mode = 'field' and v_row.target_field_id = v_target;
    select s.field_type into v_lead_type
      from public.field_definitions s
     where s.organization_id = p_org and s.id = v_lead and s.object_type = 'lead';
    if v_lead_type is null or not exists (
      select 1 from public.field_definitions d
       where d.organization_id = p_org and d.id = v_target and d.object_type = v_type
         and d.field_type = v_lead_type and d.is_active
    ) then
      raise exception 'target field does not fit' using errcode = '23514', hint = 'convert_map:invalid';
    end if;
    if v_row.id is null then
      insert into public.conversion_field_maps (organization_id, lead_field_id, target_type, mode, target_field_id)
      values (p_org, v_lead, v_type, 'field', v_target);
    else
      update public.conversion_field_maps m
         set mode = 'field', target_field_id = v_target
       where m.organization_id = p_org and m.id = v_row.id;
      get diagnostics v_n = row_count;
      if v_n = 0 then
        raise exception 'not permitted' using errcode = '42501';
      end if;
    end if;
    v_changed := v_changed + 1;
  end loop;

  return jsonb_build_object('changed', v_changed);
end;
$$;
revoke all on function public.save_conversion_field_map(uuid, jsonb) from public, anon;
grant execute on function public.save_conversion_field_map(uuid, jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- The copy (called by app.convert_custom_fields(), trigger leads_convert_custom_fields)
-- ----------------------------------------------------------------------------
create or replace function app.carry_custom_fields(p_org uuid, p_from jsonb, p_type text) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(c.key, c.value), '{}'::jsonb)
    from (
      select distinct on (t.key) t.key, v.value
        from jsonb_each(p_from) v
        join public.field_definitions s
          on s.organization_id = p_org and s.object_type = 'lead' and s.key = v.key
        left join public.conversion_field_maps m
          on m.organization_id = p_org and m.lead_field_id = s.id and m.target_type = p_type
        join lateral (
          -- picked by hand: that field only, while it is active and of the same type
          select d.key, d.field_type, d.options
            from public.field_definitions d
           where m.mode = 'field' and d.organization_id = p_org and d.id = m.target_field_id
             and d.object_type = p_type and d.is_active and d.field_type = s.field_type
          union all
          -- "auto": same label and type, as before (0029), never a field picked by hand
          select x.key, x.field_type, x.options
            from (
              select d.key, d.field_type, d.options
                from public.field_definitions d
               where (m.id is null or m.mode = 'auto')
                 and d.organization_id = p_org and d.object_type = p_type and d.is_active
                 and lower(btrim(d.label)) = lower(btrim(s.label)) and d.field_type = s.field_type
                 and not exists (
                   select 1 from public.conversion_field_maps o
                    where o.organization_id = p_org and o.target_type = p_type and o.mode = 'field' and o.target_field_id = d.id
                 )
               order by d.position, d.created_at
               limit 1
            ) x
        ) t on true
       where jsonb_typeof(v.value) <> 'null' and app.custom_value_ok(t.field_type, t.options, v.value)
       order by t.key, s.position, s.created_at
    ) c;
$$;
revoke all on function app.carry_custom_fields(uuid, jsonb, text) from public, anon, authenticated;
