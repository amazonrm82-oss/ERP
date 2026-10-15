-- =============================================================================
-- Individual permissions for a single user, on top of the role (PRM-01, wave 2)
-- =============================================================================
-- An owner or admin may give a manager or a member one or more extra
-- permissions from a closed list. Owners and admins hold all of them
-- implicitly. The closed list (app.member_permission_keys(), mirrored by
-- MEMBER_PERMISSIONS in src/features/permissions/keys.ts; a unit test reads this
-- file):
--
--   issue_documents     הפקת מסמכים              (no module yet: DOC-*)
--   issue_credits       זיכוי                     (no module yet: DOC-*)
--   record_payments     רישום תשלומים            (no module yet: PAY-*)
--   view_costs          צפייה בעלות וברווח       (no module yet: PRD-06 and others)
--   export              ייצוא רשימות ודוחות       (gated here)
--   import              ייבוא                     (gated here)
--   edit_catalog        עריכת קטלוג              (gated here)
--   mass_send           שליחה המונית             (no module yet)
--   manage_automations  ניהול אוטומציות          (gated here)
--
-- The keys whose module is not built yet are stored and granted like the others;
-- each module, when built, asks app.has_permission(org, key).
--
-- * public.member_permissions: one row per (organization, user), the granted
--   keys as a sorted text[] checked against the closed list. Composite FK to
--   memberships (organization_id, user_id) with on delete cascade: a removed
--   member loses the row. Clients only read (the row is their own, or they are
--   owner/admin); every write goes through public.set_member_permissions().
-- * Who holds a grant (app.has_grant): an active manager or member whose
--   session passes the two-step rule (app.membership_role), in a business whose
--   plan holds the capability 'granular_permissions' (owner, 13 October 2026:
--   from "מקצועי" up). A viewer, a suspended member, a support session and a
--   closed business hold none. A plan without the capability keeps the stored
--   rows but they do nothing until the capability returns.
-- * Suspending a member, or changing their role to anything but manager or
--   member, clears their grants (trigger memberships_clear_permissions), so a
--   return or a later demotion starts from nothing.
-- * Who grants: owners and admins of a writable business
--   (set_member_permissions). Adding a key needs the plan capability (hint
--   feature:granular_permissions); removing never does. A target that is not an
--   active manager or member is refused (hint permissions:role). Every change is
--   written to the audit log (user, old and new keys), by trigger.
--
-- Gates widened, each to "the role rule OR this grant", nothing else:
-- * export: app.can_export(org); public.log_list_export() and the report part of
--   public.log_export() (the full export stays the owner's). Their bodies are
--   those of migrations product_import (0159) and export_log_format (0180) with
--   only the role check replaced.
-- * import: app.can_import(org) (0012) gains the grant; it decides import_jobs
--   insert and update. Products still need edit_catalog to be written.
-- * catalog: app.can_edit_catalog(org) replaces app.is_admin(org) in the write
--   policies of products, product_categories, product_units, price_lists and
--   price_list_lines, and in the outsider guards of the definer triggers
--   app.products_quota (0166), app.price_lists_quota (0164),
--   app.price_list_lines_check (0165) and app.price_list_lines_vat (0169), so a
--   grant holder is counted against the quota like an admin (the bodies are
--   otherwise unchanged).
-- * automations: app.can_manage_automations(org) replaces app.is_admin(org) in
--   the policies of automations and automation_runs, and in
--   public.run_automation_now(), which for a grant holder (not an owner or
--   admin) also needs the record to be one the caller reads.
--
-- Every statement is safe to run twice. No drops, no row removal.

-- ----------------------------------------------------------------------------
-- The closed list
-- ----------------------------------------------------------------------------
create or replace function app.member_permission_keys() returns text[]
language sql immutable
set search_path = ''
as $$
  select array['issue_documents', 'issue_credits', 'record_payments', 'view_costs', 'export', 'import',
               'edit_catalog', 'mass_send', 'manage_automations']::text[]
$$;
revoke all on function app.member_permission_keys() from public, anon;
grant execute on function app.member_permission_keys() to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The table
-- ----------------------------------------------------------------------------
create table if not exists public.member_permissions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id         uuid not null,
  permissions     text[] not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  updated_by      uuid default auth.uid() references auth.users (id) on delete set null,
  unique (organization_id, id),
  unique (organization_id, user_id),
  constraint member_permissions_membership_fk foreign key (organization_id, user_id)
    references public.memberships (organization_id, user_id) on delete cascade,
  -- the keys of app.member_permission_keys(), written out (a check cannot call a function
  -- that may change); keep the two in step
  constraint member_permissions_known check (
    permissions <@ array['issue_documents', 'issue_credits', 'record_payments', 'view_costs', 'export', 'import',
                         'edit_catalog', 'mass_send', 'manage_automations']::text[]
    and array_position(permissions, null) is null)
);

create index if not exists member_permissions_user_idx on public.member_permissions (user_id);

alter table public.member_permissions enable row level security;
revoke all on public.member_permissions from anon, authenticated;
grant all on public.member_permissions to service_role;
grant select on public.member_permissions to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'member_permissions'
                  and policyname = 'member_permissions_select') then
    -- one's own row, or every row for owners and admins
    create policy member_permissions_select on public.member_permissions for select to authenticated
      using (app.is_member(organization_id)
             and (user_id = (select auth.uid()) or app.is_admin(organization_id)));
  end if;
end;
$$;

create or replace trigger member_permissions_touch before insert or update on public.member_permissions
  for each row execute function app.touch_row();

-- The audit entry: the user (also as entity_id, so the log names whose permissions
-- changed) and the keys before and after (a removed member's row goes with the
-- membership; logged when it held keys).
create or replace function app.member_permissions_audit() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old text[] := '{}';
  v_new text[] := '{}';
  v_row public.member_permissions;
begin
  if tg_op = 'DELETE' then
    v_row := old;
    v_old := old.permissions;
    if not app.org_exists(old.organization_id) then
      return null;
    end if;
  else
    v_row := new;
    v_new := new.permissions;
    if tg_op = 'UPDATE' then
      v_old := old.permissions;
    end if;
  end if;
  if v_old @> v_new and v_new @> v_old then
    return null;
  end if;
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (v_row.organization_id, auth.uid(), case when tg_op = 'DELETE' then 'delete' else 'update' end,
          'member_permissions', v_row.user_id,
          jsonb_build_object('user_id', v_row.user_id,
                             'permissions', jsonb_build_object('old', to_jsonb(v_old), 'new', to_jsonb(v_new))));
  return null;
end;
$$;
revoke all on function app.member_permissions_audit() from public, anon, authenticated;

create or replace trigger member_permissions_audit after insert or update or delete on public.member_permissions
  for each row execute function app.member_permissions_audit();

-- ----------------------------------------------------------------------------
-- The helpers
-- ----------------------------------------------------------------------------
-- An explicit grant of the caller (owners and admins are not asked here).
create or replace function app.has_grant(p_org uuid, p_key text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce(app.membership_role(p_org) in ('manager', 'member'), false)
     and app.org_has_feature(p_org, 'granular_permissions')
     and exists (select 1 from public.member_permissions mp
                  where mp.organization_id = p_org and mp.user_id = auth.uid()
                    and p_key = any (mp.permissions));
$$;

-- The rule for a module whose only role rule is "owners and admins": they hold
-- every key; a manager or member holds what was granted.
create or replace function app.has_permission(p_org uuid, p_key text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce(app.membership_role(p_org) in ('owner', 'admin'), false) or app.has_grant(p_org, p_key);
$$;

-- export: owners, admins and team managers (SPEC 7.1), or the grant
create or replace function app.can_export(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce(app.role_in(p_org)::text in ('owner', 'admin', 'manager'), false) or app.has_grant(p_org, 'export');
$$;

-- import (0012): owners, admins and team managers of a writable business, or the grant
create or replace function app.can_import(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select app.org_writable(p_org)
     and (coalesce(app.role_in(p_org)::text in ('owner', 'admin', 'manager'), false) or app.has_grant(p_org, 'import'));
$$;

-- the catalog (products, categories, units, price lists): owners and admins, or the grant
create or replace function app.can_edit_catalog(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select app.is_admin(p_org) or app.has_grant(p_org, 'edit_catalog');
$$;

-- automations: owners and admins, or the grant
create or replace function app.can_manage_automations(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select app.is_admin(p_org) or app.has_grant(p_org, 'manage_automations');
$$;

revoke all on function app.has_grant(uuid, text) from public, anon;
revoke all on function app.has_permission(uuid, text) from public, anon;
revoke all on function app.can_export(uuid) from public, anon;
revoke all on function app.can_import(uuid) from public, anon;
revoke all on function app.can_edit_catalog(uuid) from public, anon;
revoke all on function app.can_manage_automations(uuid) from public, anon;
grant execute on function app.has_grant(uuid, text) to authenticated, service_role;
grant execute on function app.has_permission(uuid, text) to authenticated, service_role;
grant execute on function app.can_export(uuid) to authenticated, service_role;
grant execute on function app.can_import(uuid) to authenticated, service_role;
grant execute on function app.can_edit_catalog(uuid) to authenticated, service_role;
grant execute on function app.can_manage_automations(uuid) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- A suspended member, or one whose role is no longer manager or member, loses the grants
-- ----------------------------------------------------------------------------
create or replace function app.memberships_clear_permissions() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.status <> 'active' or new.role not in ('manager', 'member') then
    update public.member_permissions mp
       set permissions = '{}'
     where mp.organization_id = new.organization_id and mp.user_id = new.user_id
       and mp.permissions <> '{}';
  end if;
  return null;
end;
$$;
revoke all on function app.memberships_clear_permissions() from public, anon, authenticated;

create or replace trigger memberships_clear_permissions after update of status, role on public.memberships
  for each row execute function app.memberships_clear_permissions();

-- ----------------------------------------------------------------------------
-- Granting: owners and admins of a writable business
-- ----------------------------------------------------------------------------
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

-- The keys the caller holds in this business (all of them for owners and admins),
-- for the screens; the database checks every action again.
create or replace function public.my_permissions(p_org uuid) returns text[]
language sql stable security definer
set search_path = ''
as $$
  select coalesce(array(select k from unnest(app.member_permission_keys()) as k
                         where app.has_permission(p_org, k) order by k), '{}');
$$;
revoke all on function public.my_permissions(uuid) from public, anon;
grant execute on function public.my_permissions(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Export
-- ----------------------------------------------------------------------------
-- body of product_import (0159); only the role check changed
create or replace function public.log_list_export(
  p_org uuid,
  p_object text,
  p_format text,
  p_rows integer,
  p_scope text,
  p_filters jsonb
) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_table text := case p_object when 'lead' then 'leads' when 'contact' then 'contacts' when 'company' then 'companies'
                                when 'deal' then 'deals' when 'task' then 'tasks' when 'product' then 'products' end;
begin
  if not app.can_export(p_org) then
    raise exception 'export is for owners, admins, team managers and members with the export permission' using errcode = '42501';
  end if;
  if v_table is null or p_format not in ('csv', 'xlsx') or p_scope not in ('filtered', 'selected')
     or p_rows is null or p_rows < 0 or p_rows > 1000000 then
    raise exception 'invalid export' using errcode = '22023';
  end if;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (
    p_org, auth.uid(), 'export', v_table, null,
    jsonb_build_object('format', p_format, 'rows', p_rows, 'scope', p_scope)
      -- the filters as the list had them, without typed text; left out when they
      -- are not an object or too large to keep
      || case when jsonb_typeof(p_filters) = 'object' and pg_column_size(p_filters) <= 8192
              then jsonb_build_object('filters', app.export_filters(p_filters)) else '{}'::jsonb end
  );
end;
$$;
revoke all on function public.log_list_export(uuid, text, text, integer, text, jsonb) from public, anon;
grant execute on function public.log_list_export(uuid, text, text, integer, text, jsonb) to authenticated;

-- body of export_log_format (0180); only the report's role check changed
create or replace function public.log_export(
  p_org uuid,
  p_kind text,
  p_report text,
  p_rows integer,
  p_format text default 'csv'
) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_role public.membership_role := app.role_in(p_org);
begin
  if p_kind = 'full' then
    if v_role is distinct from 'owner' then
      raise exception 'the full export is for the owner' using errcode = '42501';
    end if;
  elsif p_kind = 'report' then
    if not app.can_export(p_org) then
      raise exception 'export is for owners, admins, team managers and members with the export permission' using errcode = '42501';
    end if;
    -- the report keys of src/features/reports/definitions.ts; keep the two in step
    if p_report is null or p_report not in ('sources', 'funnel', 'response', 'reps', 'activity', 'forecast', 'lost', 'cycle', 'stuck', 'revenue') then
      raise exception 'invalid export' using errcode = '22023';
    end if;
  else
    raise exception 'invalid export' using errcode = '22023';
  end if;
  if p_rows is null or p_rows < 0 or p_rows > 10000000 then
    raise exception 'invalid export' using errcode = '22023';
  end if;
  -- RPT-02: the file formats of a report export
  if p_format is null or p_format not in ('csv', 'xlsx') then
    raise exception 'invalid export' using errcode = '22023';
  end if;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (
    p_org, auth.uid(), 'export',
    case p_kind when 'full' then 'full_export' else 'reports' end,
    null,
    jsonb_build_object('kind', p_kind, 'rows', p_rows, 'format', case p_kind when 'full' then 'zip' else p_format end)
      || case when p_kind = 'report' then jsonb_build_object('report', p_report) else '{}'::jsonb end
  );
end;
$$;
revoke all on function public.log_export(uuid, text, text, integer, text) from public, anon;
grant execute on function public.log_export(uuid, text, text, integer, text) to authenticated;

-- ----------------------------------------------------------------------------
-- Catalog
-- ----------------------------------------------------------------------------
alter policy products_insert on public.products
  with check (app.can_edit_catalog(organization_id) and app.org_writable(organization_id)
              and app.org_has_feature(organization_id, 'products'));
alter policy products_update on public.products
  using (app.can_edit_catalog(organization_id) and app.org_writable(organization_id))
  with check (app.can_edit_catalog(organization_id) and app.org_writable(organization_id));
alter policy products_delete on public.products
  using (app.can_edit_catalog(organization_id) and app.org_writable(organization_id));

alter policy product_categories_insert on public.product_categories
  with check (app.can_edit_catalog(organization_id) and app.org_writable(organization_id));
alter policy product_categories_update on public.product_categories
  using (app.can_edit_catalog(organization_id) and app.org_writable(organization_id))
  with check (app.can_edit_catalog(organization_id) and app.org_writable(organization_id));
alter policy product_categories_delete on public.product_categories
  using (app.can_edit_catalog(organization_id) and app.org_writable(organization_id));

alter policy product_units_insert on public.product_units
  with check (app.can_edit_catalog(organization_id) and app.org_writable(organization_id));
alter policy product_units_update on public.product_units
  using (app.can_edit_catalog(organization_id) and app.org_writable(organization_id))
  with check (app.can_edit_catalog(organization_id) and app.org_writable(organization_id));
alter policy product_units_delete on public.product_units
  using (app.can_edit_catalog(organization_id) and app.org_writable(organization_id));

alter policy price_lists_insert on public.price_lists
  with check (app.can_edit_catalog(organization_id) and app.org_writable(organization_id)
              and app.org_has_feature(organization_id, 'price_lists'));
alter policy price_lists_update on public.price_lists
  using (app.can_edit_catalog(organization_id) and app.org_writable(organization_id))
  with check (app.can_edit_catalog(organization_id) and app.org_writable(organization_id));
alter policy price_lists_delete on public.price_lists
  using (app.can_edit_catalog(organization_id) and app.org_writable(organization_id));

alter policy price_list_lines_insert on public.price_list_lines
  with check (app.can_edit_catalog(organization_id) and app.org_writable(organization_id)
              and app.org_has_feature(organization_id, 'price_lists'));
alter policy price_list_lines_update on public.price_list_lines
  using (app.can_edit_catalog(organization_id) and app.org_writable(organization_id))
  with check (app.can_edit_catalog(organization_id) and app.org_writable(organization_id));
alter policy price_list_lines_delete on public.price_list_lines
  using (app.can_edit_catalog(organization_id) and app.org_writable(organization_id));

-- body of quota_trigger_guard (0166); the outsider guard asks app.can_edit_catalog
create or replace function app.products_quota() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_limit numeric;
begin
  -- RLS refuses this writer right after; answer nothing about the plan
  if auth.uid() is not null and not app.can_edit_catalog(new.organization_id) then
    return new;
  end if;
  if not app.org_has_feature(new.organization_id, 'products') then
    raise exception 'products are not in this plan' using errcode = 'P0001', hint = 'feature:products';
  end if;
  v_limit := app.org_limit(new.organization_id, 'max_products');
  if v_limit is null then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('products:' || new.organization_id::text, 0));
  if (select count(*) from public.products p where p.organization_id = new.organization_id) + 1 > v_limit then
    raise exception 'plan limit reached (max_products = %)', v_limit using errcode = 'P0001', hint = 'limit:max_products';
  end if;
  return new;
end;
$$;
revoke all on function app.products_quota() from public, anon, authenticated;

-- body of price_lists (0164); the outsider guard asks app.can_edit_catalog
create or replace function app.price_lists_quota() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_limit numeric;
begin
  -- A person who may not edit this business's catalog is refused by RLS
  -- (42501) right after this trigger; answering here would tell an outsider
  -- the business's plan state. auth.uid(), not current_user: inside a definer
  -- current_user is the owner. Server writers without a session are checked.
  if auth.uid() is not null and not app.can_edit_catalog(new.organization_id) then
    return new;
  end if;
  if not app.org_has_feature(new.organization_id, 'price_lists') then
    raise exception 'price lists are not in this plan' using errcode = 'P0001', hint = 'feature:price_lists';
  end if;
  v_limit := app.org_limit(new.organization_id, 'max_price_lists');
  if v_limit is null then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('price_lists:' || new.organization_id::text, 0));
  if (select count(*) from public.price_lists l where l.organization_id = new.organization_id) + 1 > v_limit then
    raise exception 'plan limit reached (max_price_lists = %)', v_limit using errcode = 'P0001', hint = 'limit:max_price_lists';
  end if;
  return new;
end;
$$;
revoke all on function app.price_lists_quota() from public, anon, authenticated;

-- body of price_list_lines (0165); the outsider guard asks app.can_edit_catalog
create or replace function app.price_list_lines_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- A person who may not edit this business's catalog is refused by RLS
  -- (42501) right after this trigger; answering here would tell an outsider
  -- the business's plan state. auth.uid(), not current_user: inside a definer
  -- current_user is the owner. Server writers without a session are checked.
  if auth.uid() is not null and not app.can_edit_catalog(new.organization_id) then
    return new;
  end if;
  if not app.org_has_feature(new.organization_id, 'price_lists') then
    raise exception 'price lists are not in this plan' using errcode = 'P0001', hint = 'feature:price_lists';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('price_list_lines:' || new.price_list_id::text || ':' || new.product_id::text, 0));
  if (select count(*) from public.price_list_lines l
       where l.organization_id = new.organization_id and l.price_list_id = new.price_list_id
         and l.product_id = new.product_id) >= 20 then
    raise exception 'at most 20 quantity tiers per product in a price list' using errcode = 'P0001', hint = 'price_list_lines:tiers';
  end if;
  return new;
end;
$$;
revoke all on function app.price_list_lines_check() from public, anon, authenticated;

-- body of price_list_vat (0169); the outsider guard asks app.can_edit_catalog
create or replace function app.price_list_lines_vat() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_include boolean;
begin
  -- RLS refuses this writer right after; touch nothing of the list
  if auth.uid() is not null and not app.can_edit_catalog(new.organization_id) then
    return new;
  end if;
  select l.prices_include_vat into v_include
    from public.price_lists l
   where l.organization_id = new.organization_id and l.id = new.price_list_id
     for share;
  new.price_includes_vat := new.price_agorot is not null and coalesce(v_include, false);
  return new;
end;
$$;
revoke all on function app.price_list_lines_vat() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Automations
-- ----------------------------------------------------------------------------
alter policy automations_select on public.automations
  using (app.can_manage_automations(organization_id));
alter policy automations_insert on public.automations
  with check (app.can_manage_automations(organization_id) and app.org_writable(organization_id));
alter policy automations_update on public.automations
  using (app.can_manage_automations(organization_id) and app.org_writable(organization_id))
  with check (app.can_manage_automations(organization_id));
alter policy automations_delete on public.automations
  using (app.can_manage_automations(organization_id) and app.org_writable(organization_id));
alter policy automation_runs_select on public.automation_runs
  using (app.can_manage_automations(organization_id));

-- body of automations (0009); the permission check asks app.can_manage_automations,
-- and a grant holder may test a rule only on a record they read
create or replace function public.run_automation_now(p_automation_id uuid, p_entity_id uuid) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_auto public.automations%rowtype;
  v_record jsonb;
  v_status text;
  v_steps jsonb;
begin
  select * into v_auto from public.automations a where a.id = p_automation_id;
  if not found or not app.can_manage_automations(v_auto.organization_id) then
    raise exception 'automation not found' using errcode = 'P0002';
  end if;
  if not app.org_writable(v_auto.organization_id) then
    raise exception 'the organization is read-only' using errcode = '42501';
  end if;
  v_record := app.automation_record(v_auto.entity_type, v_auto.organization_id, p_entity_id);
  if v_record is null
     or (not app.is_admin(v_auto.organization_id)
         and not app.can_read_record(v_auto.organization_id, (v_record ->> 'owner_id')::uuid, (v_record ->> 'team_id')::uuid)) then
    raise exception 'record not found' using errcode = 'P0002';
  end if;
  v_status := app.execute_automation(v_auto, p_entity_id, 'manual:' || gen_random_uuid(), false);
  select r.steps into v_steps from public.automation_runs r
   where r.automation_id = v_auto.id and r.entity_id = p_entity_id
   order by r.created_at desc limit 1;
  return jsonb_build_object('status', v_status, 'steps', coalesce(v_steps, '[]'::jsonb));
end;
$$;
revoke all on function public.run_automation_now(uuid, uuid) from public, anon;
grant execute on function public.run_automation_now(uuid, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
