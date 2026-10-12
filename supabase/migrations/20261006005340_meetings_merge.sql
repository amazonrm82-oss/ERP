-- =============================================================================
-- 0053e Meetings: a merge moves meetings too (CAL-01; split from 0053)
-- =============================================================================
-- Kept apart from 0053d because the function body holds a DELETE: the
-- connector stops on it, so this one is pasted in the SQL Editor.
-- Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- Merging records: meetings follow the record that is kept.
-- Same body as in the merge migration (0020), plus the meetings line.
-- ----------------------------------------------------------------------------
create or replace function app.merge_move_links(p_org uuid, p_type text, p_keep uuid, p_merge uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_col text := p_type || '_id';
begin
  execute format('update public.activities set %1$I = $1 where organization_id = $2 and %1$I = $3', v_col) using p_keep, p_org, p_merge;
  execute format('update public.tasks set %1$I = $1 where organization_id = $2 and %1$I = $3', v_col) using p_keep, p_org, p_merge;
  execute format('update public.files set %1$I = $1 where organization_id = $2 and %1$I = $3', v_col) using p_keep, p_org, p_merge;
  execute format('update public.meetings set %1$I = $1 where organization_id = $2 and %1$I = $3', v_col) using p_keep, p_org, p_merge;
  update public.notifications set entity_id = p_keep where organization_id = p_org and entity_id = p_merge;

  if p_type = 'lead' then
    update public.form_submissions set lead_id = p_keep where organization_id = p_org and lead_id = p_merge;
  elsif p_type = 'contact' then
    update public.deals set contact_id = p_keep where organization_id = p_org and contact_id = p_merge;
    insert into public.deal_contacts (organization_id, deal_id, contact_id, role)
      select organization_id, deal_id, p_keep, role from public.deal_contacts where organization_id = p_org and contact_id = p_merge
      on conflict do nothing;
    delete from public.deal_contacts where organization_id = p_org and contact_id = p_merge;
    update public.leads set converted_contact_id = p_keep where organization_id = p_org and converted_contact_id = p_merge;
  elsif p_type = 'company' then
    update public.contacts set company_id = p_keep where organization_id = p_org and company_id = p_merge;
    update public.deals set company_id = p_keep where organization_id = p_org and company_id = p_merge;
    update public.leads set converted_company_id = p_keep where organization_id = p_org and converted_company_id = p_merge;
    update public.companies set parent_company_id = case when id = p_keep then null else p_keep end
     where organization_id = p_org and parent_company_id = p_merge;
  end if;
end;
$$;
revoke all on function app.merge_move_links(uuid, text, uuid, uuid) from public, anon, authenticated;
