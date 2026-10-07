-- 20261006002000_merge_records: part 2 of 4. Run the parts in order.
-- moves every reference from one record to another (same organization, same type)
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
