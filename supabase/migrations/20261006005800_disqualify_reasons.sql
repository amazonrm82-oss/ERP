-- =============================================================================
-- "Not relevant" needs a reason from the organization's own list (LEAD-03)
-- =============================================================================
-- * public.disqualify_reasons: the reasons an organization offers when a lead
--   is moved to a status of kind 'disqualified'. Configuration: everyone in the
--   organization reads, owners and admins write (as lead_sources). A hidden
--   reason (is_active = false) is no longer offered. At most 50 per organization
--   (hint 'reasons:max'). Names are unique per organization, ignoring case.
-- * The lead keeps the reason's name in leads.disqualify_reason, as before: a
--   snapshot, so renaming or deleting a reason does not change leads that were
--   already disqualified, and reports read one column.
-- * Trigger leads_disqualify_reason: when a person (role authenticated) changes
--   a lead's status or reason and the new status is of kind 'disqualified', the
--   reason must be the name of an active reason of the organization; while the
--   organization has no active reason yet, any non-empty reason (hint
--   'lead:disqualify_reason'). Server-side changes (automations, conversion,
--   merge) and new leads (form, import) are not checked here.
-- * New organizations start with an empty list (create_organization is not
--   changed); an admin adds reasons, or the suggested ones, in the settings.
-- Every statement is safe to run twice.

create table if not exists public.disqualify_reasons (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name            text not null check (char_length(name) between 1 and 80 and name = btrim(name)),
  position        integer not null default 0,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id)
);

create unique index if not exists disqualify_reasons_name_idx on public.disqualify_reasons (organization_id, lower(name));
create index if not exists disqualify_reasons_org_idx on public.disqualify_reasons (organization_id, position);

alter table public.disqualify_reasons enable row level security;

revoke all on public.disqualify_reasons from anon, authenticated;
grant select, insert, update, delete on public.disqualify_reasons to authenticated;

-- policies as for the other configuration tables (0004), created only when missing
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'disqualify_reasons' and policyname = 'disqualify_reasons_select') then
    create policy disqualify_reasons_select on public.disqualify_reasons for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'disqualify_reasons' and policyname = 'disqualify_reasons_insert') then
    create policy disqualify_reasons_insert on public.disqualify_reasons for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'disqualify_reasons' and policyname = 'disqualify_reasons_update') then
    create policy disqualify_reasons_update on public.disqualify_reasons for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'disqualify_reasons' and policyname = 'disqualify_reasons_delete') then
    create policy disqualify_reasons_delete on public.disqualify_reasons for delete to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

create or replace trigger disqualify_reasons_touch before update on public.disqualify_reasons
  for each row execute function app.touch_row();
create or replace trigger disqualify_reasons_audit after insert or update or delete on public.disqualify_reasons
  for each row execute function app.audit_row();

-- ----------------------------------------------------------------------------
-- At most 50 reasons per organization
-- ----------------------------------------------------------------------------
create or replace function app.disqualify_reasons_cap() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- one insert at a time per organization, so two cannot both pass the count
  perform pg_advisory_xact_lock(hashtextextended('disqualify_reasons:' || new.organization_id::text, 0));
  if (select count(*) from public.disqualify_reasons r where r.organization_id = new.organization_id) >= 50 then
    raise exception 'too many disqualify reasons' using errcode = 'P0001', hint = 'reasons:max';
  end if;
  return new;
end;
$$;
revoke all on function app.disqualify_reasons_cap() from public, anon, authenticated;

create or replace trigger disqualify_reasons_cap before insert on public.disqualify_reasons
  for each row execute function app.disqualify_reasons_cap();

-- ----------------------------------------------------------------------------
-- A person who disqualifies a lead picks a reason from the list
-- ----------------------------------------------------------------------------
create or replace function app.check_disqualify_reason() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_kind public.lead_status_kind;
  v_reason text := btrim(coalesce(new.disqualify_reason, ''));
begin
  -- security invoker on purpose: current_user tells a browser write from a server one
  if current_user <> 'authenticated'
     or (new.status_id is not distinct from old.status_id
         and new.disqualify_reason is not distinct from old.disqualify_reason) then
    return new;
  end if;
  select s.kind into v_kind from public.lead_statuses s
   where s.organization_id = new.organization_id and s.id = new.status_id;
  if v_kind is distinct from 'disqualified' then
    return new;
  end if;
  if exists (select 1 from public.disqualify_reasons r where r.organization_id = new.organization_id and r.is_active) then
    if not exists (select 1 from public.disqualify_reasons r
                    where r.organization_id = new.organization_id and r.is_active and r.name = v_reason) then
      raise exception 'pick a reason from the list' using errcode = 'P0001', hint = 'lead:disqualify_reason';
    end if;
  elsif v_reason = '' then
    raise exception 'a reason is required' using errcode = 'P0001', hint = 'lead:disqualify_reason';
  end if;
  return new;
end;
$$;
revoke all on function app.check_disqualify_reason() from public, anon, authenticated;

create or replace trigger leads_disqualify_reason before update of status_id, disqualify_reason on public.leads
  for each row execute function app.check_disqualify_reason();
