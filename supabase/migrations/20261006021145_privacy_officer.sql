-- =============================================================================
-- PRK-06: the business's privacy officer ("אחראי פרטיות")
-- =============================================================================
-- Spec (SPEC-ADDITIONS 18.9, PRK-06, wave 3): mark a member of the business as its privacy officer. They
-- receive the data subjects' requests (PRK-02), and from wave 4 the periodic report (PRK-05). The mark adds
-- no rights on data.
-- * Privacy, so every plan, no plan key (CLAUDE.md, "Plans and capabilities").
-- * One officer per business (lead's choice, recorded in the report: the spec says "a member", and the
--   requests need one clear recipient; a business that wants more can forward).
-- * public.org_privacy_settings: one row per business (no row = no officer). `privacy_officer_id` is a
--   composite FK to memberships (organization_id, user_id) with ON DELETE SET NULL of that column only,
--   so a member who leaves the business stops being its officer. Members read the row (everyone may know
--   whom to turn to); owners and admins of a writable business write it, through column grants only.
-- * Trigger org_privacy_settings_check (invoker; outsider guard first, so an outsider gets RLS's plain
--   42501): a new or changed officer must be an active member of the business (hint privacy_officer:member).
-- * A member who is suspended stops being the officer (trigger memberships_privacy_officer_off, definer,
--   after update of status), like PRM-01's grants (memberships_clear_permissions).
-- * Audited (app.audit_row): who set or removed the officer, and when.
-- * The mark is read by nothing that decides access: no policy, helper or function asks it for rights.
--   app.privacy_officer(org) (definer, no grants) answers the active officer's user id for the server
--   functions that will route requests to them (PRK-02) and send the report (PRK-05).
-- Every statement is safe to run twice. No drops, no row removal.

create table if not exists public.org_privacy_settings (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  privacy_officer_id  uuid,
  updated_by          uuid references auth.users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id),
  constraint org_privacy_settings_officer_fk foreign key (organization_id, privacy_officer_id)
    references public.memberships (organization_id, user_id) on delete set null (privacy_officer_id)
);

create index if not exists org_privacy_settings_officer_idx on public.org_privacy_settings (organization_id, privacy_officer_id);

comment on table public.org_privacy_settings is
  'PRK-06: one row per business; its privacy officer (receives privacy requests and reports; no data rights)';

alter table public.org_privacy_settings enable row level security;
revoke all on public.org_privacy_settings from anon, authenticated;
grant select on public.org_privacy_settings to authenticated;
grant insert (organization_id, privacy_officer_id) on public.org_privacy_settings to authenticated;
grant update (privacy_officer_id) on public.org_privacy_settings to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'org_privacy_settings' and policyname = 'org_privacy_settings_select') then
    create policy org_privacy_settings_select on public.org_privacy_settings for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'org_privacy_settings' and policyname = 'org_privacy_settings_insert') then
    create policy org_privacy_settings_insert on public.org_privacy_settings for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'org_privacy_settings' and policyname = 'org_privacy_settings_update') then
    create policy org_privacy_settings_update on public.org_privacy_settings for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- The officer is an active member of the business
-- ----------------------------------------------------------------------------
create or replace function app.org_privacy_settings_check() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.privacy_officer_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.privacy_officer_id is not distinct from old.privacy_officer_id then
    return new;
  end if;
  -- an outsider gets RLS's plain refusal, and learns nothing about the business's members
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  if not exists (select 1 from public.memberships m
                  where m.organization_id = new.organization_id and m.user_id = new.privacy_officer_id
                    and m.status = 'active') then
    raise exception 'the privacy officer must be an active member of the business'
      using errcode = 'P0001', hint = 'privacy_officer:member';
  end if;
  return new;
end;
$$;
revoke all on function app.org_privacy_settings_check() from public, anon, authenticated;

create or replace trigger org_privacy_settings_check before insert or update on public.org_privacy_settings
  for each row execute function app.org_privacy_settings_check();
create or replace trigger org_privacy_settings_touch before insert or update on public.org_privacy_settings
  for each row execute function app.touch_row();
create or replace trigger org_privacy_settings_audit after insert or update or delete on public.org_privacy_settings
  for each row execute function app.audit_row();

-- ----------------------------------------------------------------------------
-- A suspended member is no longer the officer
-- ----------------------------------------------------------------------------
create or replace function app.memberships_privacy_officer_off() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.status <> 'active' then
    update public.org_privacy_settings s
       set privacy_officer_id = null
     where s.organization_id = new.organization_id and s.privacy_officer_id = new.user_id;
  end if;
  return null;
end;
$$;
revoke all on function app.memberships_privacy_officer_off() from public, anon, authenticated;

create or replace trigger memberships_privacy_officer_off after update of status on public.memberships
  for each row when (new.status is distinct from old.status)
  execute function app.memberships_privacy_officer_off();

-- ----------------------------------------------------------------------------
-- Whom the server routes privacy requests and reports to (PRK-02, PRK-05)
-- ----------------------------------------------------------------------------
create or replace function app.privacy_officer(p_org uuid) returns uuid
language sql stable security definer
set search_path = ''
as $$
  select s.privacy_officer_id
    from public.org_privacy_settings s
    join public.memberships m on m.organization_id = s.organization_id and m.user_id = s.privacy_officer_id
   where s.organization_id = p_org and m.status = 'active'
$$;
revoke all on function app.privacy_officer(uuid) from public, anon, authenticated;

comment on function app.privacy_officer(uuid) is
  'PRK-06: the business''s active privacy officer (null when none); for server routing only, never an access rule';

notify pgrst, 'reload schema';
