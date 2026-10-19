-- =============================================================================
-- LEAD-08 part (a): a business switches the leads module or the companies module off
-- =============================================================================
-- Spec (SPEC-ADDITIONS, LEAD-08): a business that works straight with contacts and deals turns leads off; a business
-- that sells to private people turns companies off. The menu, the forms and the intake adapt.
-- * public.org_modules: one row per business; leads_enabled and companies_enabled, both true by default; no row = both
--   on, so nothing changes until a business decides. Members read; owners/admins of a writable business write; no
--   delete (switch back on instead); audited. Core: every plan, no plan key (a way of working, not a capability).
-- * Switching off hides, it never removes: every lead and company stays, RLS is unchanged, and switching back on shows
--   everything again. The app hides the module (menu, "+" menu, its pages, form fields, search, reports).
-- * What the public intake does with leads off (a contact and a "לחזור ללקוח" task, owner 18 October 2026, answer (א))
--   is part (b), in a later migration; until then intake keeps making leads.
-- A table of its own, not columns on an existing settings table: no other one-row business setting is about the
-- business's shape (org_terms holds words, org_calendar_settings days and hours), and a table of its own keeps the
-- grants, the audit entity and the later intake read to these two switches alone.
-- Additive only. Safe to run twice.

create table if not exists public.org_modules (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  leads_enabled      boolean not null default true,
  companies_enabled  boolean not null default true,
  updated_by         uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id)
);

create or replace trigger org_modules_touch before insert or update on public.org_modules
  for each row execute function app.touch_row();
create or replace trigger org_modules_audit after insert or update or delete on public.org_modules
  for each row execute function app.audit_row();

alter table public.org_modules enable row level security;
revoke all on public.org_modules from anon, authenticated;
grant select on public.org_modules to authenticated;
grant insert (organization_id, leads_enabled, companies_enabled) on public.org_modules to authenticated;
grant update (leads_enabled, companies_enabled) on public.org_modules to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'org_modules' and policyname = 'org_modules_select') then
    create policy org_modules_select on public.org_modules for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'org_modules' and policyname = 'org_modules_insert') then
    create policy org_modules_insert on public.org_modules for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'org_modules' and policyname = 'org_modules_update') then
    create policy org_modules_update on public.org_modules for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

notify pgrst, 'reload schema';
