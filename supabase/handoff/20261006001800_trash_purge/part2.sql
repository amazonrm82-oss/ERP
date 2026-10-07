-- 20261006001800_trash_purge: part 2 of 2. Run the parts in order.
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
