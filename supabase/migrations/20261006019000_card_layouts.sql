-- =============================================================================
-- Card view editor: groups of fields on the record card (FLD-08, wave 2)
-- =============================================================================
-- public.card_layouts: at most one row per organization and record type
-- (lead | contact | company | deal). `groups` is an ordered jsonb list of
--   {"title": text 1..60 characters, "columns": 1 | 2, "fields": [key, ...]}
-- where a key is
--   * a built-in field of the type's details card, listed in
--     app.card_layout_builtin_keys() and mirrored by CARD_LAYOUT_BUILT_IN in
--     src/features/card-layout/layout.ts (tests/db/99-card-layouts.test.ts keeps
--     them equal), or
--   * "cf:<key>" for a custom field of the same type (field_definitions).
-- At most 20 groups and 60 fields in all, each key once.
--
-- No row = the default layout (built in the app), so nothing changes until a
-- business edits its card. "Back to default" writes the default value; there
-- is no delete grant. The layout affects the details card only: forms, required
-- fields and the list columns are unchanged. A field that sits in no group is
-- shown by the app in a final group, so a layout never hides a field.
--
-- A "cf:" key must name a custom field of the same type when it is written. A
-- custom field that is hidden or deleted later is not refused: a key the row
-- already held may stay (the card skips it), so an old layout can still be saved.
--
-- Members read; owners and admins of a writable organization write. Audited.
-- Every statement is safe to run twice. No deletes, no drops.

-- ----------------------------------------------------------------------------
-- The built-in keys of each type (the details card's own fields, in card order)
-- ----------------------------------------------------------------------------
create or replace function app.card_layout_builtin_keys(p_type text) returns text[]
language sql immutable
set search_path = ''
as $$
  select case p_type
    when 'lead' then array['full_name', 'phone', 'email', 'company_name', 'source_id', 'requested_product_id',
                           'preferred_channel', 'owner_id', 'budget', 'last_contacted_at', 'created_at', 'disqualify_reason']
    when 'contact' then array['full_name', 'phone', 'email', 'job_title', 'company_id', 'type', 'birth_date',
                              'preferred_locale', 'preferred_channel', 'source_id', 'owner_id', 'created_at']
    when 'company' then array['type', 'parent_company_id', 'country', 'tax_id', 'industry', 'phone', 'email',
                              'website', 'city', 'address_line', 'owner_id', 'created_at']
    when 'deal' then array['amount', 'contact_id', 'company_id', 'expected_close_date', 'recurring_kind',
                           'recurring_amount', 'recurring_start', 'renewal_date', 'closed_at', 'lost_reason',
                           'competitor', 'owner_id', 'created_at']
    else array[]::text[]
  end
$$;
revoke all on function app.card_layout_builtin_keys(text) from public, anon;
grant execute on function app.card_layout_builtin_keys(text) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The table
-- ----------------------------------------------------------------------------
create table if not exists public.card_layouts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  object_type     text not null
                  constraint card_layouts_object_type_check
                  check (object_type in ('lead', 'contact', 'company', 'deal')),
  groups          jsonb not null default '[]'::jsonb
                  constraint card_layouts_groups_array
                  check (jsonb_typeof(groups) = 'array'),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, object_type)
);

comment on table public.card_layouts is
  'FLD-08: the groups of fields on the record details card per organization and record type. No row = the default layout.';

alter table public.card_layouts enable row level security;
revoke all on public.card_layouts from anon, authenticated;
grant select on public.card_layouts to authenticated;
grant insert (organization_id, object_type, groups) on public.card_layouts to authenticated;
grant update (groups) on public.card_layouts to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'card_layouts' and policyname = 'card_layouts_select') then
    create policy card_layouts_select on public.card_layouts for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'card_layouts' and policyname = 'card_layouts_insert') then
    create policy card_layouts_insert on public.card_layouts for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'card_layouts' and policyname = 'card_layouts_update') then
    create policy card_layouts_update on public.card_layouts for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- The check (hint card_layout:invalid)
-- ----------------------------------------------------------------------------
-- Security invoker: the custom fields are read with the writer's rights, so a
-- writer from another organization sees none and learns nothing (RLS then
-- refuses the row itself with 42501).
create or replace function app.card_layouts_check() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_builtin text[] := app.card_layout_builtin_keys(new.object_type);
  v_old_keys text[] := '{}';
  v_seen text[] := '{}';
  v_group jsonb;
  v_field jsonb;
  v_key text;
  v_title text;
  v_ok boolean := true;
begin
  if tg_op = 'UPDATE' and jsonb_typeof(old.groups) = 'array' then
    select coalesce(array_agg(f.k), '{}')
      into v_old_keys
      from jsonb_array_elements(old.groups) as g(v),
           lateral jsonb_array_elements_text(case when jsonb_typeof(g.v -> 'fields') = 'array' then g.v -> 'fields' else '[]'::jsonb end) as f(k)
     where jsonb_typeof(g.v) = 'object';
  end if;

  if new.groups is null or jsonb_typeof(new.groups) <> 'array' or jsonb_array_length(new.groups) > 20 then
    v_ok := false;
  else
    for v_group in select g.v from jsonb_array_elements(new.groups) as g(v) loop
      if jsonb_typeof(v_group) <> 'object'
         or exists (select 1 from jsonb_object_keys(v_group) as k where k not in ('title', 'columns', 'fields'))
         or jsonb_typeof(v_group -> 'title') is distinct from 'string'
         or jsonb_typeof(v_group -> 'columns') is distinct from 'number'
         or (v_group -> 'columns') not in ('1'::jsonb, '2'::jsonb)
         or jsonb_typeof(v_group -> 'fields') is distinct from 'array' then
        v_ok := false;
        exit;
      end if;
      v_title := v_group ->> 'title';
      -- no leading or trailing white space: the set JavaScript's trim() removes (TITLE_EDGE_SPACE in layout.ts),
      -- written out so the rule does not depend on the database locale
      if v_title ~ '^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$' or char_length(v_title) not between 1 and 60 then
        v_ok := false;
        exit;
      end if;
      for v_field in select f.v from jsonb_array_elements(v_group -> 'fields') as f(v) loop
        if jsonb_typeof(v_field) <> 'string' then
          v_ok := false;
          exit;
        end if;
        v_key := v_field #>> '{}';
        if v_key = any (v_seen) or cardinality(v_seen) >= 60 then
          v_ok := false;
          exit;
        end if;
        v_seen := v_seen || v_key;
        if v_key = any (v_builtin) then
          continue;
        end if;
        if v_key !~ '^cf:[a-z][a-z0-9_]{0,39}$' then
          v_ok := false;
          exit;
        end if;
        -- a custom field of the same type; one the row already held may since be hidden or deleted
        if not (v_key = any (v_old_keys))
           and not exists (select 1 from public.field_definitions d
                            where d.organization_id = new.organization_id and d.object_type = new.object_type
                              and d.key = substr(v_key, 4)) then
          v_ok := false;
          exit;
        end if;
      end loop;
      exit when not v_ok;
    end loop;
  end if;

  if not v_ok then
    raise exception 'invalid card layout' using errcode = 'P0001', hint = 'card_layout:invalid';
  end if;
  return new;
end;
$$;
revoke all on function app.card_layouts_check() from public, anon, authenticated;

create or replace trigger card_layouts_check before insert or update on public.card_layouts
  for each row execute function app.card_layouts_check();
create or replace trigger card_layouts_touch before update on public.card_layouts
  for each row execute function app.touch_row();
create or replace trigger card_layouts_audit after insert or update or delete on public.card_layouts
  for each row execute function app.audit_row();
