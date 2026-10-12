-- =============================================================================
-- Contact type and company type from a managed list (CON-02)
-- =============================================================================
-- * public.record_type_options: the types an organization offers for contacts
--   and for companies (object_type 'contact' | 'company'), e.g. customer,
--   prospect, supplier, partner, competitor, other. Configuration: everyone in
--   the organization reads, owners and admins write (as disqualify_reasons). A
--   hidden type (is_active = false) is no longer offered but stays on the
--   records that have it. At most 50 per organization and object type (hint
--   'record_types:max'). Names are unique per organization and object type,
--   ignoring case. New organizations start empty (create_organization is not
--   changed); an admin adds types, or the suggested ones, in the settings.
-- * contacts.type_id / companies.type_id: the record's type, a composite
--   foreign key into the same organization; deleting a type leaves its records
--   without one. Renaming a type renames it everywhere. The older free-text
--   columns contact_type / company_type are kept and shown while no type is set.
-- * Trigger *_type_check: a person (authenticated / anon) who sets or changes a
--   record's type must pick an active type of the same object type (hint
--   'record_type:invalid'). Server writes are trusted. An unchanged type is not
--   checked again, so a record keeps a type that was hidden later.
-- * sort_type(contacts | companies): the type's position, for sorting the lists
--   (as sort_status, migration 0032).
-- Every statement is safe to run twice.

create table if not exists public.record_type_options (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  object_type     text not null check (object_type in ('contact', 'company')),
  name            text not null check (char_length(name) between 1 and 60 and name = btrim(name)),
  position        integer not null default 0,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id)
);

create unique index if not exists record_type_options_name_idx on public.record_type_options (organization_id, object_type, lower(name));
create index if not exists record_type_options_org_idx on public.record_type_options (organization_id, object_type, position);

alter table public.record_type_options enable row level security;

revoke all on public.record_type_options from anon, authenticated;
-- organization and object type never change: records point at a type by id
grant select, insert, delete on public.record_type_options to authenticated;
grant update (name, position, is_active) on public.record_type_options to authenticated;

-- policies as for the other configuration tables, created only when missing
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'record_type_options' and policyname = 'record_type_options_select') then
    create policy record_type_options_select on public.record_type_options for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'record_type_options' and policyname = 'record_type_options_insert') then
    create policy record_type_options_insert on public.record_type_options for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'record_type_options' and policyname = 'record_type_options_update') then
    create policy record_type_options_update on public.record_type_options for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'record_type_options' and policyname = 'record_type_options_delete') then
    create policy record_type_options_delete on public.record_type_options for delete to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

create or replace trigger record_type_options_touch before update on public.record_type_options
  for each row execute function app.touch_row();
create or replace trigger record_type_options_audit after insert or update or delete on public.record_type_options
  for each row execute function app.audit_row();

-- ----------------------------------------------------------------------------
-- At most 50 types per organization and object type
-- ----------------------------------------------------------------------------
create or replace function app.record_type_options_cap() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- one insert at a time per organization, so two cannot both pass the count
  perform pg_advisory_xact_lock(hashtextextended('record_type_options:' || new.organization_id::text, 0));
  if (select count(*) from public.record_type_options r
       where r.organization_id = new.organization_id and r.object_type = new.object_type) >= 50 then
    raise exception 'too many record types' using errcode = 'P0001', hint = 'record_types:max';
  end if;
  return new;
end;
$$;
revoke all on function app.record_type_options_cap() from public, anon, authenticated;

create or replace trigger record_type_options_cap before insert on public.record_type_options
  for each row execute function app.record_type_options_cap();

-- ----------------------------------------------------------------------------
-- The type of a contact and of a company
-- ----------------------------------------------------------------------------
alter table public.contacts add column if not exists type_id uuid;
alter table public.companies add column if not exists type_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'contacts_type_fk' and conrelid = 'public.contacts'::regclass) then
    alter table public.contacts add constraint contacts_type_fk foreign key (organization_id, type_id)
      references public.record_type_options (organization_id, id) on delete set null (type_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'companies_type_fk' and conrelid = 'public.companies'::regclass) then
    alter table public.companies add constraint companies_type_fk foreign key (organization_id, type_id)
      references public.record_type_options (organization_id, id) on delete set null (type_id);
  end if;
end;
$$;

create index if not exists contacts_type_idx on public.contacts (organization_id, type_id) where type_id is not null;
create index if not exists companies_type_idx on public.companies (organization_id, type_id) where type_id is not null;

create or replace function app.check_record_type() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  -- security invoker on purpose: current_user tells a browser write from a server one
  if current_user not in ('authenticated', 'anon') or new.type_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.type_id is not distinct from old.type_id then
    return new;
  end if;
  if not exists (select 1 from public.record_type_options r
                  where r.organization_id = new.organization_id and r.id = new.type_id
                    and r.object_type = tg_argv[0] and r.is_active) then
    raise exception 'pick a type from the list' using errcode = 'P0001', hint = 'record_type:invalid';
  end if;
  return new;
end;
$$;
revoke all on function app.check_record_type() from public, anon, authenticated;

create or replace trigger contacts_type_check before insert or update of type_id on public.contacts
  for each row execute function app.check_record_type('contact');
create or replace trigger companies_type_check before insert or update of type_id on public.companies
  for each row execute function app.check_record_type('company');

-- ----------------------------------------------------------------------------
-- Sorting the lists by type (the order set in the settings)
-- ----------------------------------------------------------------------------
create or replace function public.sort_type(public.contacts) returns integer
language sql stable security invoker
set search_path = ''
as $$
  select r.position from public.record_type_options r where r.organization_id = $1.organization_id and r.id = $1.type_id;
$$;

create or replace function public.sort_type(public.companies) returns integer
language sql stable security invoker
set search_path = ''
as $$
  select r.position from public.record_type_options r where r.organization_id = $1.organization_id and r.id = $1.type_id;
$$;

revoke all on function public.sort_type(public.contacts) from public, anon;
revoke all on function public.sort_type(public.companies) from public, anon;
grant execute on function public.sort_type(public.contacts) to authenticated;
grant execute on function public.sort_type(public.companies) to authenticated;

-- the API learns about the new column and computed fields when it reloads its schema cache
notify pgrst, 'reload schema';
