-- 20261006002700_audit_erase: part 1 of 3. Run the parts in order.
-- =============================================================================
-- 0027 Erasing a person's details from the audit log (privacy requests)
-- =============================================================================
-- A permanently deleted record still lives in the audit log: its delete entry
-- keeps the full row, and its updates keep old and new values. When a person
-- asks a business to delete their details, an owner or admin first deletes the
-- record for good (recycle bin), then erases it from the log here:
-- * public.audit_erase_candidates(org, query): deleted leads, contacts,
--   companies and deals in the log that match a name, phone or email
--   (security invoker: the audit log's RLS, admins only).
-- * public.audit_erase_record(org, type, id): the entries of that record and of
--   the tasks and files deleted with it keep who, what and when, but their
--   contents become {"erased": true}. Also emptied: the merge snapshot of it on
--   the record it was merged into, and lead form submissions with its email or
--   phone. A new entry records the erasure itself (no personal details).
-- * Purging a lead now also empties its form submissions (app.purge_links).
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
  -- what the person typed into a lead form goes with the lead
  if tg_table_name = 'leads' then
    update public.form_submissions s set payload = '{}'::jsonb, user_agent = null
     where s.organization_id = old.organization_id and s.lead_id = old.id;
  end if;
  return old;
end;
$$;
revoke all on function app.purge_links() from public, anon, authenticated;
