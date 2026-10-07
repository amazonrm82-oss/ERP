-- 20261006002400_transfer_records: part 2 of 2. Run the parts in order.
create or replace function public.transfer_records(p_org uuid, p_from uuid, p_to uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_leads int; v_contacts int; v_companies int; v_deals int; v_tasks int;
  v_from_name text;
begin
  if not app.is_admin(p_org) or not app.org_writable(p_org) then
    raise exception 'admins only' using errcode = '42501';
  end if;
  if p_from = p_to then
    raise exception 'the same person' using errcode = '22023';
  end if;
  if not exists (select 1 from public.memberships m where m.organization_id = p_org and m.user_id = p_from) then
    raise exception 'not a member' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.memberships m
                  where m.organization_id = p_org and m.user_id = p_to and m.status = 'active' and m.role <> 'viewer') then
    raise exception 'the new owner must be an active user who can edit' using errcode = 'P0001', hint = 'transfer:target';
  end if;

  perform set_config('app.bulk_transfer', 'on', true);
  perform set_config('app.automation_running', 'on', true);

  update public.leads set owner_id = p_to where organization_id = p_org and owner_id = p_from;
  get diagnostics v_leads = row_count;
  update public.contacts set owner_id = p_to where organization_id = p_org and owner_id = p_from;
  get diagnostics v_contacts = row_count;
  update public.companies set owner_id = p_to where organization_id = p_org and owner_id = p_from;
  get diagnostics v_companies = row_count;
  update public.deals set owner_id = p_to where organization_id = p_org and owner_id = p_from;
  get diagnostics v_deals = row_count;
  update public.tasks set owner_id = p_to where organization_id = p_org and owner_id = p_from;
  get diagnostics v_tasks = row_count;

  perform set_config('app.bulk_transfer', 'off', true);
  perform set_config('app.automation_running', 'off', true);

  select coalesce(nullif(p.full_name, ''), p.email) into v_from_name from public.profiles p where p.id = p_from;
  if v_leads + v_contacts + v_companies + v_deals + v_tasks > 0 and p_to is distinct from auth.uid() then
    insert into public.notifications (organization_id, user_id, type, title, body)
    values (p_org, p_to, 'assigned', 'הועברו אליך רשומות של ' || coalesce(v_from_name, 'משתמש'),
            format('%s לידים, %s אנשי קשר, %s חברות, %s עסקאות ו-%s משימות.', v_leads, v_contacts, v_companies, v_deals, v_tasks));
  end if;

  return jsonb_build_object('leads', v_leads, 'contacts', v_contacts, 'companies', v_companies, 'deals', v_deals, 'tasks', v_tasks);
end;
$$;

revoke all on function public.transfer_records(uuid, uuid, uuid) from public, anon;
grant execute on function public.transfer_records(uuid, uuid, uuid) to authenticated;
