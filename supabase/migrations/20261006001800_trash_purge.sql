-- =============================================================================
-- 0018 Permanent deletion from the recycle bin, and cleanup after 30 days
-- =============================================================================
-- Until now an activity or task was deleted with ANY record it was linked to, so
-- purging a converted lead would also have wiped the history of the contact made
-- from it. Now:
-- * app.purge_links(): before a lead, contact, company or deal is deleted, the
--   activities, tasks and notifications that belong to it alone go with it.
-- * The foreign keys become ON DELETE SET NULL, so an activity or task that is
--   also linked to another record stays there.
-- * Admins delete permanently from the recycle bin (the existing delete policy:
--   only rows already in the bin, admins only, writable organization).
-- * app.purge_trash(): pg_cron job 'crm-purge-trash', every night at 02:30 UTC,
--   deletes whatever has been in the recycle bin for more than 30 days.
-- Every statement is safe to run twice.

create or replace function app.purge_links() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_col text := case tg_table_name
                  when 'leads' then 'lead_id'
                  when 'contacts' then 'contact_id'
                  when 'companies' then 'company_id'
                  when 'deals' then 'deal_id'
                end;
begin
  execute format(
    'delete from public.activities where organization_id = $1 and %I = $2
       and num_nonnulls(lead_id, contact_id, company_id, deal_id) = 1', v_col)
    using old.organization_id, old.id;
  execute format(
    'delete from public.tasks where organization_id = $1 and %I = $2
       and num_nonnulls(lead_id, contact_id, company_id, deal_id) = 1', v_col)
    using old.organization_id, old.id;
  delete from public.notifications n
   where n.organization_id = old.organization_id and n.entity_id = old.id;
  return old;
end;
$$;
revoke all on function app.purge_links() from public, anon, authenticated;

create or replace trigger leads_purge_links before delete on public.leads
  for each row execute function app.purge_links();
create or replace trigger contacts_purge_links before delete on public.contacts
  for each row execute function app.purge_links();
create or replace trigger companies_purge_links before delete on public.companies
  for each row execute function app.purge_links();
create or replace trigger deals_purge_links before delete on public.deals
  for each row execute function app.purge_links();

-- what is left linked to another record keeps that link
alter table public.activities
  drop constraint if exists activities_organization_id_lead_id_fkey,
  drop constraint if exists activities_organization_id_contact_id_fkey,
  drop constraint if exists activities_organization_id_company_id_fkey,
  drop constraint if exists activities_organization_id_deal_id_fkey,
  add constraint activities_organization_id_lead_id_fkey foreign key (organization_id, lead_id)
    references public.leads (organization_id, id) on delete set null (lead_id),
  add constraint activities_organization_id_contact_id_fkey foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id) on delete set null (contact_id),
  add constraint activities_organization_id_company_id_fkey foreign key (organization_id, company_id)
    references public.companies (organization_id, id) on delete set null (company_id),
  add constraint activities_organization_id_deal_id_fkey foreign key (organization_id, deal_id)
    references public.deals (organization_id, id) on delete set null (deal_id);

alter table public.tasks
  drop constraint if exists tasks_organization_id_lead_id_fkey,
  drop constraint if exists tasks_organization_id_contact_id_fkey,
  drop constraint if exists tasks_organization_id_company_id_fkey,
  drop constraint if exists tasks_organization_id_deal_id_fkey,
  add constraint tasks_organization_id_lead_id_fkey foreign key (organization_id, lead_id)
    references public.leads (organization_id, id) on delete set null (lead_id),
  add constraint tasks_organization_id_contact_id_fkey foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id) on delete set null (contact_id),
  add constraint tasks_organization_id_company_id_fkey foreign key (organization_id, company_id)
    references public.companies (organization_id, id) on delete set null (company_id),
  add constraint tasks_organization_id_deal_id_fkey foreign key (organization_id, deal_id)
    references public.deals (organization_id, id) on delete set null (deal_id);

-- the nightly cleanup: 30 days in the recycle bin, then gone (tasks too)
create or replace function app.purge_trash() returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_cutoff timestamptz := now() - interval '30 days';
  v_deals int; v_leads int; v_contacts int; v_companies int; v_tasks int;
begin
  delete from public.deals where deleted_at < v_cutoff;
  get diagnostics v_deals = row_count;
  delete from public.leads where deleted_at < v_cutoff;
  get diagnostics v_leads = row_count;
  delete from public.contacts where deleted_at < v_cutoff;
  get diagnostics v_contacts = row_count;
  delete from public.companies where deleted_at < v_cutoff;
  get diagnostics v_companies = row_count;
  delete from public.tasks where deleted_at < v_cutoff;
  get diagnostics v_tasks = row_count;
  return jsonb_build_object('deals', v_deals, 'leads', v_leads, 'contacts', v_contacts, 'companies', v_companies, 'tasks', v_tasks);
end;
$$;
revoke all on function app.purge_trash() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-purge-trash', '30 2 * * *', 'select app.purge_trash();');
  end if;
end;
$$;
