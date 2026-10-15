-- =============================================================================
-- The roles of a contact on a deal as a managed list (CON-03 follow-up)
-- =============================================================================
-- Owner, 14 October 2026 (DECISIONS.md "תפקידים בעסקה"): a managed list per business under the
-- 12 October rule. The four roles of migration deal_contact_roles are the defaults; the business
-- renames, hides, deletes and adds them, at most 20.
--
-- * public.deal_contact_roles: configuration like deal_loss_reasons (0121). Members read; owners and
--   admins of a writable organization write; a hidden role (is_active = false) is no longer offered but
--   stays on the links that have it; names unique per organization ignoring case; at most 20 (trigger
--   deal_contact_roles_cap, hint 'deal_contact_roles:max'; an outsider gets RLS's plain refusal first).
--   `key` is server-only (column grants): the seed writes the old code ('decision_maker', 'influencer',
--   'user', 'finance') on the default it made, so a link saved before this migration finds its role.
--   Audited.
-- * deal_contacts.role_id (nullable, composite FK, set null of the column when the role is deleted):
--   the role picked from the list. deal_contacts.role (text, the old code) stays and is not rewritten:
--   a link with no role_id is shown by the role of its organization's list with that key (its current
--   name), else with no role (the default was deleted). Trigger deal_contacts_role_pick (invoker):
--   a person (role authenticated) may pick only an active role of the deal's organization (hint
--   'deal_contact_role:invalid'), and a write that sets or changes role_id clears the old text, so a
--   link never carries both. No existing row is changed by this migration.
-- * Defaults: app.seed_deal_contact_roles(org) inserts them while the list is empty; the trigger
--   organizations_seed_deal_contact_roles seeds every new organization (create_organization is not
--   changed), and existing organizations whose list is empty are seeded at the end. Names and keys
--   mirror DEFAULT_DEAL_CONTACT_ROLES in src/features/deal-contacts/roles.ts (unit test).
-- Every statement is safe to run twice. No deletes, no drops.

create table if not exists public.deal_contact_roles (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name            text not null check (char_length(name) between 1 and 60 and name = btrim(name)),
  key             text check (key is null or key in ('decision_maker', 'influencer', 'user', 'finance')),
  position        integer not null default 0,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id)
);

create unique index if not exists deal_contact_roles_name_idx on public.deal_contact_roles (organization_id, lower(name));
create unique index if not exists deal_contact_roles_key_idx on public.deal_contact_roles (organization_id, key) where key is not null;
create index if not exists deal_contact_roles_org_idx on public.deal_contact_roles (organization_id, position);

alter table public.deal_contact_roles enable row level security;

revoke all on public.deal_contact_roles from anon, authenticated;
grant select, delete on public.deal_contact_roles to authenticated;
grant insert (organization_id, name, position, is_active) on public.deal_contact_roles to authenticated;
grant update (name, position, is_active) on public.deal_contact_roles to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'deal_contact_roles' and policyname = 'deal_contact_roles_select') then
    create policy deal_contact_roles_select on public.deal_contact_roles for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'deal_contact_roles' and policyname = 'deal_contact_roles_insert') then
    create policy deal_contact_roles_insert on public.deal_contact_roles for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'deal_contact_roles' and policyname = 'deal_contact_roles_update') then
    create policy deal_contact_roles_update on public.deal_contact_roles for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'deal_contact_roles' and policyname = 'deal_contact_roles_delete') then
    create policy deal_contact_roles_delete on public.deal_contact_roles for delete to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

create or replace trigger deal_contact_roles_touch before update on public.deal_contact_roles
  for each row execute function app.touch_row();
create or replace trigger deal_contact_roles_audit after insert or update or delete on public.deal_contact_roles
  for each row execute function app.audit_row();

create or replace function app.deal_contact_roles_cap() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- an outsider gets RLS's plain refusal and learns nothing about the organization
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  -- one insert at a time per organization, so two cannot both pass the count
  perform pg_advisory_xact_lock(hashtextextended('deal_contact_roles:' || new.organization_id::text, 0));
  if (select count(*) from public.deal_contact_roles r where r.organization_id = new.organization_id) >= 20 then
    raise exception 'too many deal contact roles' using errcode = 'P0001', hint = 'deal_contact_roles:max';
  end if;
  return new;
end;
$$;
revoke all on function app.deal_contact_roles_cap() from public, anon, authenticated;

create or replace trigger deal_contact_roles_cap before insert on public.deal_contact_roles
  for each row execute function app.deal_contact_roles_cap();

-- ----------------------------------------------------------------------------
-- The link's role
-- ----------------------------------------------------------------------------
alter table public.deal_contacts add column if not exists role_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.deal_contacts'::regclass and conname = 'deal_contacts_role_fk') then
    alter table public.deal_contacts add constraint deal_contacts_role_fk foreign key (organization_id, role_id)
      references public.deal_contact_roles (organization_id, id) on delete set null (role_id);
  end if;
end;
$$;

create index if not exists deal_contacts_role_idx on public.deal_contacts (organization_id, role_id) where role_id is not null;

-- deal_contacts has column-level update grants since deal_contact_roles (role only); insert stays table-wide
grant update (role_id) on public.deal_contacts to authenticated;

create or replace function app.deal_contact_role_check() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  -- security invoker on purpose: current_user tells a person's write from the server's (a deleted role
  -- clears role_id through the foreign key, run as the table owner)
  if tg_op = 'UPDATE' and new.role_id is not distinct from old.role_id then
    return new;
  end if;
  if tg_op = 'INSERT' and new.role_id is null then
    return new;
  end if;
  -- the list's role replaces the old code
  new.role := null;
  if new.role_id is not null and current_user = 'authenticated'
     and not exists (select 1 from public.deal_contact_roles r
                      where r.organization_id = new.organization_id and r.id = new.role_id and r.is_active) then
    raise exception 'this role is not on the list' using errcode = 'P0001', hint = 'deal_contact_role:invalid';
  end if;
  return new;
end;
$$;
revoke all on function app.deal_contact_role_check() from public, anon, authenticated;

create or replace trigger deal_contacts_role_pick before insert or update on public.deal_contacts
  for each row execute function app.deal_contact_role_check();

-- ----------------------------------------------------------------------------
-- Default roles: an organization starts with these and renames or deletes them
-- ----------------------------------------------------------------------------
create or replace function app.seed_deal_contact_roles(p_org uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.deal_contact_roles (organization_id, name, key, position)
  select p_org, d.name, d.key, d.pos
    from (values ('מקבל החלטה', 'decision_maker', 0),
                 ('משפיע', 'influencer', 1),
                 ('משתמש', 'user', 2),
                 ('איש כספים', 'finance', 3)) as d(name, key, pos)
   where not exists (select 1 from public.deal_contact_roles r where r.organization_id = p_org)
   order by d.pos;
end;
$$;
revoke all on function app.seed_deal_contact_roles(uuid) from public, anon, authenticated;

create or replace function app.organizations_seed_deal_contact_roles() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform app.seed_deal_contact_roles(new.id);
  return null;
end;
$$;
revoke all on function app.organizations_seed_deal_contact_roles() from public, anon, authenticated;

create or replace trigger organizations_seed_deal_contact_roles after insert on public.organizations
  for each row execute function app.organizations_seed_deal_contact_roles();

-- existing organizations whose list is empty: once. A re-run seeds again only a list that is empty then
-- (managed lists rule).
select app.seed_deal_contact_roles(o.id) from public.organizations o;

notify pgrst, 'reload schema';
