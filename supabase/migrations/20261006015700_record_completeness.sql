-- =============================================================================
-- Record completeness: which important fields are missing (DQL-01, wave 2)
-- =============================================================================
-- public.completeness_settings: one row per organization and record type
-- (lead | contact | company | deal) with the keys of the fields that count as
-- important, in the order they are shown. A key is
--   * a built-in field of the type, listed in app.completeness_builtin_keys()
--     ("contact" = a phone or an email; amount_agorot counts when above zero),
--     mirrored by COMPLETENESS_BUILT_IN in src/features/data-quality/completeness.ts
--     (tests/db/96-record-completeness.test.ts keeps them equal), or
--   * "cf:<key>" for a custom field of the same type (field_definitions).
-- A key the list no longer knows (a hidden or deleted custom field) is skipped,
-- never counted as missing.
-- Managed list (owner's rule of 12 October 2026): every organization starts with
-- the defaults of app.completeness_default_keys() (22.9: lead = phone or email,
-- source, owner), seeded by the trigger organizations_seed_completeness for new
-- organizations and once below for existing ones. Owners and admins of a
-- writable organization change them; everyone in the organization reads them.
-- Audited. No delete grant: a type with nothing important has an empty list.
--
-- The score lives in the database only, so lists, cards and the "to complete"
-- page agree:
--   app.completeness_keys(org, type)     the important keys that still exist
--                                        (security definer, members and support
--                                        sessions only; see below)
--   app.completeness_missing(type, row jsonb, keys)
--                                        the keys the row leaves empty; for a
--                                        contact, a further phone or email
--                                        (contact_channels) counts too
--   public.completeness(leads|contacts|companies|deals)
--                                        computed field, 0..100, for
--                                        order=completeness in lists
--   public.record_completeness(org, type, ids)
--                                        score + missing keys per id
--   public.incomplete_records(org, type, owner, limit)
--                                        a person's live records under 100%,
--                                        worst first
-- The records themselves are always read with the caller's rights (RLS).
--
-- Speed (review of 13 October 2026): a sorted list evaluates the computed field
-- for every visible row. Reading the settings through RLS cost one
-- app.is_member() per row (about 0.3 ms each, 20,000 leads took 6.6 to 28 s).
-- So the keys come from app.completeness_keys(), a security definer function
-- that checks the caller itself once per call: the condition of
-- app.membership_role() (with its two-step rule, written out inside the same
-- statement because calling it doubled the cost; keep the two in step) or
-- app.support_session(), the same people app.is_member() lets in; anyone else
-- gets null. The computed
-- fields are plain SQL with no SET clause and no sub-select, so the planner
-- inlines them; every name in them is schema-qualified and they run with the
-- caller's rights (security invoker), so a caller's search_path cannot change
-- what they do. The helpers they call are the same: invoker, qualified names,
-- no SET (a SET clause costs a GUC save and restore on every row).
-- Every statement is safe to run twice. No deletes, no drops.

-- ----------------------------------------------------------------------------
-- The keys
-- ----------------------------------------------------------------------------
-- No SET clause: it is evaluated for every row of a sorted list, and a SET clause
-- keeps the planner from inlining it. It names nothing but its own literals.
create or replace function app.completeness_builtin_keys(p_type text) returns text[]
language sql immutable
as $$
  select case p_type
    when 'lead' then array['contact', 'full_name', 'phone', 'email', 'company_name', 'job_title', 'source_id', 'owner_id']
    when 'contact' then array['contact', 'full_name', 'phone', 'email', 'job_title', 'company_id', 'source_id', 'city', 'birth_date', 'owner_id']
    when 'company' then array['contact', 'phone', 'email', 'website', 'tax_id', 'industry', 'city', 'owner_id']
    when 'deal' then array['amount_agorot', 'expected_close_date', 'contact_id', 'company_id', 'source_id', 'owner_id']
    else array[]::text[]
  end
$$;
revoke all on function app.completeness_builtin_keys(text) from public, anon;
grant execute on function app.completeness_builtin_keys(text) to authenticated, service_role;

create or replace function app.completeness_default_keys(p_type text) returns text[]
language sql immutable
set search_path = ''
as $$
  select case p_type
    when 'lead' then array['contact', 'source_id', 'owner_id']
    when 'contact' then array['contact', 'company_id']
    when 'company' then array['contact', 'industry']
    when 'deal' then array['amount_agorot', 'expected_close_date', 'contact_id']
    else array[]::text[]
  end
$$;
revoke all on function app.completeness_default_keys(text) from public, anon;
grant execute on function app.completeness_default_keys(text) to authenticated, service_role;

-- the shape of a list: at most 40 keys, no empty or repeated key
create or replace function app.completeness_fields_ok(p_fields text[]) returns boolean
language sql immutable
set search_path = ''
as $$
  select p_fields is not null
     and coalesce(array_length(p_fields, 1), 0) <= 40
     and array_position(p_fields, null) is null
     and coalesce((select bool_and(k ~ '^(cf:)?[a-z][a-z0-9_]{0,39}$') from unnest(p_fields) as k), true)
     and (select count(distinct k) from unnest(p_fields) as k) = coalesce(array_length(p_fields, 1), 0)
$$;
revoke all on function app.completeness_fields_ok(text[]) from public, anon;
grant execute on function app.completeness_fields_ok(text[]) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The settings table
-- ----------------------------------------------------------------------------
create table if not exists public.completeness_settings (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  object_type     text not null
                  constraint completeness_settings_object_type_check
                  check (object_type in ('lead', 'contact', 'company', 'deal')),
  fields          text[] not null default '{}'
                  constraint completeness_settings_fields_check
                  check (app.completeness_fields_ok(fields)),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, object_type)
);

comment on table public.completeness_settings is
  'DQL-01: the fields that count as important per organization and record type (built-in keys or cf:<key>).';

alter table public.completeness_settings enable row level security;
revoke all on public.completeness_settings from anon, authenticated;
grant select on public.completeness_settings to authenticated;
grant insert (organization_id, object_type, fields) on public.completeness_settings to authenticated;
grant update (fields) on public.completeness_settings to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'completeness_settings' and policyname = 'completeness_settings_select') then
    create policy completeness_settings_select on public.completeness_settings for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'completeness_settings' and policyname = 'completeness_settings_insert') then
    create policy completeness_settings_insert on public.completeness_settings for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'completeness_settings' and policyname = 'completeness_settings_update') then
    create policy completeness_settings_update on public.completeness_settings for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

create or replace trigger completeness_settings_touch before update on public.completeness_settings
  for each row execute function app.touch_row();
create or replace trigger completeness_settings_audit after insert or update or delete on public.completeness_settings
  for each row execute function app.audit_row();

-- ----------------------------------------------------------------------------
-- Defaults for every organization
-- ----------------------------------------------------------------------------
create or replace function app.seed_completeness_settings(p_org uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.completeness_settings (organization_id, object_type, fields)
  select p_org, t.type, app.completeness_default_keys(t.type)
    from unnest(array['lead', 'contact', 'company', 'deal']) as t(type)
  on conflict (organization_id, object_type) do nothing;
end;
$$;
revoke all on function app.seed_completeness_settings(uuid) from public, anon, authenticated;

create or replace function app.organizations_seed_completeness() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform app.seed_completeness_settings(new.id);
  return null;
end;
$$;
revoke all on function app.organizations_seed_completeness() from public, anon, authenticated;

create or replace trigger organizations_seed_completeness after insert on public.organizations
  for each row execute function app.organizations_seed_completeness();

select app.seed_completeness_settings(o.id) from public.organizations o;

-- ----------------------------------------------------------------------------
-- The important keys of an organization and type
-- ----------------------------------------------------------------------------
-- The keys of the settings row, in the configured order, without cf:<key> of a
-- hidden or deleted custom field (a built-in key the type does not know is
-- skipped later, by app.completeness_missing / app.completeness_total). Null for
-- a caller app.is_member() would refuse (no role from app.membership_role(),
-- including its two-step rule, and no open support session). Security definer
-- and one SQL statement: no RLS per row (see the header).
create or replace function app.completeness_keys(p_org uuid, p_type text) returns text[]
language sql stable security definer
set search_path = ''
as $$
  select case
    -- the condition of app.membership_role() (migration 0014), written out so it runs as part of
    -- this one statement (calling it costs about 0.2 ms a row); keep the two in step
    when not (exists (select 1
                        from public.memberships m
                        join public.organizations o on o.id = m.organization_id
                       where m.organization_id = p_org and m.user_id = auth.uid() and m.status = 'active'
                         and (coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'aal', '') = 'aal2'
                              or (not o.require_mfa
                                  and not exists (select 1 from auth.mfa_factors f
                                                   where f.user_id = auth.uid() and f.status::text = 'verified'))))
              or app.support_session(p_org)) then null
    else (
      -- custom field keys are checked against field_definitions only when the list has one
      select case
               when not exists (select 1 from unnest(s.fields) as k where k like 'cf:%') then s.fields
               else array(select f.k
                            from unnest(s.fields) with ordinality as f(k, n)
                           where f.k not like 'cf:%'
                              or exists (select 1 from public.field_definitions d
                                          where d.organization_id = p_org and d.object_type = p_type
                                            and d.key = substr(f.k, 4) and d.is_active)
                           order by f.n)
             end
        from public.completeness_settings s
       where s.organization_id = p_org and s.object_type = p_type)
  end
$$;
revoke all on function app.completeness_keys(uuid, text) from public, anon;
grant execute on function app.completeness_keys(uuid, text) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Is a value filled?
-- ----------------------------------------------------------------------------
-- No SET clause on purpose (see the header): invoker, every name qualified.
create or replace function app.completeness_value_filled(p_value jsonb) returns boolean
language sql immutable
as $$
  select case pg_catalog.jsonb_typeof(p_value)
    when 'string' then pg_catalog.btrim(p_value #>> '{}') <> ''
    when 'array' then pg_catalog.jsonb_array_length(p_value) > 0
    when 'object' then p_value <> '{}'::jsonb
    when 'number' then true
    when 'boolean' then true
    else false
  end
$$;
revoke all on function app.completeness_value_filled(jsonb) from public, anon;
grant execute on function app.completeness_value_filled(jsonb) to authenticated, service_role;

-- The keys of p_keys the row leaves empty, in order. p_keys comes from
-- app.completeness_keys(); a key that is not a built-in key of the type and not
-- cf:<key> is skipped. A contact's phone or email also counts when it is only
-- among its further ones (a merge can leave a contact with no primary phone but
-- a further one); that is read with the caller's rights, and only when the
-- primary is empty.
create or replace function app.completeness_missing(p_type text, p_row jsonb, p_keys text[]) returns text[]
language plpgsql stable
as $$
declare
  v_builtin text[] := app.completeness_builtin_keys(p_type);
  v_missing text[] := array[]::text[];
  v_key text;
  v_phone boolean;
  v_email boolean;
  v_filled boolean;
begin
  if p_keys is null then
    return array[]::text[];
  end if;
  foreach v_key in array p_keys loop
    if v_key like 'cf:%' then
      v_filled := app.completeness_value_filled(p_row -> 'custom_fields' -> pg_catalog.substr(v_key, 4));
    elsif not (v_key = any (v_builtin)) then
      continue;
    elsif v_key = 'amount_agorot' then
      v_filled := coalesce((p_row ->> 'amount_agorot')::numeric, 0) > 0;
    elsif v_key in ('contact', 'phone', 'email') then
      if v_phone is null then
        v_phone := app.completeness_value_filled(p_row -> 'phone');
        v_email := app.completeness_value_filled(p_row -> 'email');
        if p_type = 'contact' and not (v_phone and v_email) then
          v_phone := v_phone or exists (select 1 from public.contact_channels ch
                                         where ch.organization_id = (p_row ->> 'organization_id')::uuid
                                           and ch.contact_id = (p_row ->> 'id')::uuid and ch.kind = 'phone');
          v_email := v_email or exists (select 1 from public.contact_channels ch
                                         where ch.organization_id = (p_row ->> 'organization_id')::uuid
                                           and ch.contact_id = (p_row ->> 'id')::uuid and ch.kind = 'email');
        end if;
      end if;
      v_filled := case v_key when 'contact' then v_phone or v_email when 'phone' then v_phone else v_email end;
    else
      v_filled := app.completeness_value_filled(p_row -> v_key);
    end if;
    if not v_filled then
      v_missing := v_missing || v_key;
    end if;
  end loop;
  return v_missing;
end;
$$;
revoke all on function app.completeness_missing(text, jsonb, text[]) from public, anon;
grant execute on function app.completeness_missing(text, jsonb, text[]) to authenticated, service_role;

-- How many of p_keys count for the type (the score's denominator).
-- PL/pgSQL rather than SQL: a SQL function with a sub-select is not inlined, and
-- running it once per row cost more than everything else together.
create or replace function app.completeness_total(p_type text, p_keys text[]) returns integer
language plpgsql immutable
as $$
declare
  v_builtin text[] := app.completeness_builtin_keys(p_type);
  v_key text;
  v_total integer := 0;
begin
  if p_keys is null then
    return 0;
  end if;
  foreach v_key in array p_keys loop
    if v_key like 'cf:%' or v_key = any (v_builtin) then
      v_total := v_total + 1;
    end if;
  end loop;
  return v_total;
end;
$$;
revoke all on function app.completeness_total(text, text[]) from public, anon;
grant execute on function app.completeness_total(text, text[]) to authenticated, service_role;

-- 0..100, rounded down (100 only when nothing is missing); 100 with nothing important
create or replace function app.completeness_score(p_total integer, p_missing text[]) returns integer
language sql immutable
as $$
  select case when coalesce(p_total, 0) = 0 then 100
              else ((p_total - coalesce(pg_catalog.cardinality(p_missing), 0)) * 100) / p_total end
$$;
revoke all on function app.completeness_score(integer, text[]) from public, anon;
grant execute on function app.completeness_score(integer, text[]) to authenticated, service_role;

-- The score of one row from its keys. PL/pgSQL: as SQL it is not inlined
-- (p_keys is used twice and is a function call), and a SQL function that is not
-- inlined is slow to call once per row.
create or replace function app.completeness_row_score(p_type text, p_row jsonb, p_keys text[]) returns integer
language plpgsql stable
as $$
begin
  return app.completeness_score(app.completeness_total(p_type, p_keys), app.completeness_missing(p_type, p_row, p_keys));
end;
$$;
revoke all on function app.completeness_row_score(text, jsonb, text[]) from public, anon;
grant execute on function app.completeness_row_score(text, jsonb, text[]) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Computed fields for the lists (order=completeness). Plain SQL, no SET, no
-- sub-select: inlined by the planner (see the header).
-- ----------------------------------------------------------------------------
create or replace function public.completeness(public.leads) returns integer
language sql stable
as $$
  select app.completeness_row_score('lead', pg_catalog.to_jsonb($1), app.completeness_keys(($1).organization_id, 'lead'))
$$;
create or replace function public.completeness(public.contacts) returns integer
language sql stable
as $$
  select app.completeness_row_score('contact', pg_catalog.to_jsonb($1), app.completeness_keys(($1).organization_id, 'contact'))
$$;
create or replace function public.completeness(public.companies) returns integer
language sql stable
as $$
  select app.completeness_row_score('company', pg_catalog.to_jsonb($1), app.completeness_keys(($1).organization_id, 'company'))
$$;
create or replace function public.completeness(public.deals) returns integer
language sql stable
as $$
  select app.completeness_row_score('deal', pg_catalog.to_jsonb($1), app.completeness_keys(($1).organization_id, 'deal'))
$$;
revoke all on function public.completeness(public.leads) from public, anon;
revoke all on function public.completeness(public.contacts) from public, anon;
revoke all on function public.completeness(public.companies) from public, anon;
revoke all on function public.completeness(public.deals) from public, anon;
grant execute on function public.completeness(public.leads) to authenticated;
grant execute on function public.completeness(public.contacts) to authenticated;
grant execute on function public.completeness(public.companies) to authenticated;
grant execute on function public.completeness(public.deals) to authenticated;

-- the table of a record type (null for anything else)
create or replace function app.completeness_table(p_type text) returns text
language sql immutable
set search_path = ''
as $$
  select case p_type when 'lead' then 'leads' when 'contact' then 'contacts' when 'company' then 'companies' when 'deal' then 'deals' end
$$;
revoke all on function app.completeness_table(text) from public, anon;
grant execute on function app.completeness_table(text) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Score and missing keys of given records: [{id, score, missing}]
-- ----------------------------------------------------------------------------
create or replace function public.record_completeness(p_org uuid, p_type text, p_ids uuid[]) returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_table text := app.completeness_table(p_type);
  v_keys text[] := app.completeness_keys(p_org, p_type);
  v_result jsonb;
begin
  if v_table is null then
    raise exception 'unknown record type' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_ids), 0) > 200 then
    raise exception 'too many ids' using errcode = '22023';
  end if;
  execute format(
    'select coalesce(jsonb_agg(jsonb_build_object(''id'', e.id, ''score'', app.completeness_score($5, e.missing), ''missing'', to_jsonb(e.missing)) order by e.id), ''[]''::jsonb)
       from (select r.id, app.completeness_missing($3, to_jsonb(r), $4) as missing
               from public.%I r
              where r.organization_id = $1 and r.id = any ($2)) e', v_table)
    into v_result
    using p_org, coalesce(p_ids, array[]::uuid[]), p_type, v_keys, app.completeness_total(p_type, v_keys);
  return v_result;
end;
$$;
revoke all on function public.record_completeness(uuid, text, uuid[]) from public, anon;
grant execute on function public.record_completeness(uuid, text, uuid[]) to authenticated;

-- ----------------------------------------------------------------------------
-- A person's live records under 100%, worst first (the "to complete" page):
-- {total, rows: [{id, name, score, missing}]}. Live = not in the recycle bin;
-- a lead whose status is open (not converted, not "not relevant"); an open deal.
-- ----------------------------------------------------------------------------
create or replace function public.incomplete_records(p_org uuid, p_type text, p_owner uuid, p_limit integer default 100) returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_table text := app.completeness_table(p_type);
  v_name text;
  v_live text;
  v_keys text[] := app.completeness_keys(p_org, p_type);
  v_result jsonb;
begin
  if v_table is null then
    raise exception 'unknown record type' using errcode = '22023';
  end if;
  if p_owner is null or p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'invalid arguments' using errcode = '22023';
  end if;
  v_name := case p_type
    when 'lead' then 'coalesce(r.full_name, r.email, r.phone, r.company_name)'
    when 'contact' then 'coalesce(r.full_name, r.email, r.phone)'
    else 'r.name'
  end;
  v_live := case p_type
    -- the open statuses are read once (as an array), not once per lead
    when 'lead' then 'and r.converted_at is null and r.status_id = any ($7)'
    when 'deal' then 'and r.status = ''open'''
    else ''
  end;
  execute format(
    'with base as (
       select r.id, %s as name, r.created_at, app.completeness_missing($3, to_jsonb(r), $5) as missing
         from public.%I r
        where r.organization_id = $1 and r.owner_id = $2 and r.deleted_at is null %s
     ), scored as (
       select base.*, app.completeness_score($6, base.missing) as score from base
     ), incomplete as (
       select * from scored where score < 100
     )
     select jsonb_build_object(
       ''total'', (select count(*) from incomplete),
       ''rows'', coalesce((
         select jsonb_agg(jsonb_build_object(''id'', i.id, ''name'', i.name, ''score'', i.score, ''missing'', to_jsonb(i.missing)) order by i.score, i.created_at desc, i.id)
           from (select * from incomplete order by score, created_at desc, id limit $4) i), ''[]''::jsonb))',
    v_name, v_table, v_live)
    into v_result
    using p_org, p_owner, p_type, p_limit, v_keys, app.completeness_total(p_type, v_keys),
          array(select st.id from public.lead_statuses st where st.organization_id = p_org and st.kind = 'open');
  return v_result;
end;
$$;
revoke all on function public.incomplete_records(uuid, text, uuid, integer) from public, anon;
grant execute on function public.incomplete_records(uuid, text, uuid, integer) to authenticated;
