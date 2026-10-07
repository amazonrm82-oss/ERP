-- 20261006001800_trash_purge: part 1 of 2. Run the parts in order.
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
