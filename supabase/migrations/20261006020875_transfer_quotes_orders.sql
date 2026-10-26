-- Handover of quotes and orders (lead's decision, 26 October 2026).
--
-- public.transfer_records(org, from, to) moved owner_id on leads, contacts, companies, deals, tasks
-- and meetings. It now also moves the person's quotes and orders, in every status (drafts, sent,
-- accepted, cancelled; numbered and cancelled orders too), like it moves closed deals and done tasks:
-- the owner is who gets the notices about a quote or an order, and the owner filter of the reports.
--
-- app.quotes_check and app.orders_check keep owner_id for every writer on update (new.owner_id :=
-- old.owner_id). The narrowest allowance: a separate BEFORE UPDATE trigger, named to run after every
-- other BEFORE trigger of the table (quotes_zzz_owner_transfer, orders_zz_owner_transfer), sets
-- owner_id to the handover's target only when
--   * transfer_records is running in this transaction: it sets app.owner_transfer_org / _from / _to
--     (transaction-local, cleared again before it returns; a client cannot set them through the API);
--   * the row is of that organization and its old owner is that person.
-- Nothing else is touched: the frozen checks of quotes_check / orders_check have already run and
-- put back every other server-kept column; the handover's update writes owner_id only.
-- The audit triggers (after update) log the owner change as they do for the other tables.
--
-- Safe to run twice: create or replace only.

create or replace function app.document_owner_transfer() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('app.owner_transfer_org', true), '') = new.organization_id::text
     and old.owner_id is not null
     and coalesce(current_setting('app.owner_transfer_from', true), '') = old.owner_id::text
     and coalesce(current_setting('app.owner_transfer_to', true), '') <> '' then
    new.owner_id := current_setting('app.owner_transfer_to', true)::uuid;
  end if;
  return new;
end;
$$;
revoke all on function app.document_owner_transfer() from public, anon, authenticated;

create or replace trigger quotes_zzz_owner_transfer before update of owner_id on public.quotes
  for each row execute function app.document_owner_transfer();
create or replace trigger orders_zz_owner_transfer before update of owner_id on public.orders
  for each row execute function app.document_owner_transfer();

-- Same body as in 0053d (20261006005330), plus quotes and orders (update and count) and the
-- settings that let their owner move.
create or replace function public.transfer_records(p_org uuid, p_from uuid, p_to uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_leads int; v_contacts int; v_companies int; v_deals int; v_tasks int; v_meetings int;
  v_quotes int; v_orders int;
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
  -- meetings have no recycle bin: every meeting they organize moves
  update public.meetings set owner_id = p_to where organization_id = p_org and owner_id = p_from;
  get diagnostics v_meetings = row_count;

  -- quotes and orders keep their owner for every other writer (app.quotes_check, app.orders_check);
  -- app.document_owner_transfer moves it while these settings name this handover
  perform set_config('app.owner_transfer_org', p_org::text, true);
  perform set_config('app.owner_transfer_from', p_from::text, true);
  perform set_config('app.owner_transfer_to', p_to::text, true);
  update public.quotes set owner_id = p_to where organization_id = p_org and owner_id = p_from;
  get diagnostics v_quotes = row_count;
  update public.orders set owner_id = p_to where organization_id = p_org and owner_id = p_from;
  get diagnostics v_orders = row_count;
  perform set_config('app.owner_transfer_org', '', true);
  perform set_config('app.owner_transfer_from', '', true);
  perform set_config('app.owner_transfer_to', '', true);

  perform set_config('app.bulk_transfer', 'off', true);
  perform set_config('app.automation_running', 'off', true);

  select coalesce(nullif(p.full_name, ''), p.email) into v_from_name from public.profiles p where p.id = p_from;
  if v_leads + v_contacts + v_companies + v_deals + v_tasks + v_meetings + v_quotes + v_orders > 0
     and p_to is distinct from auth.uid() then
    insert into public.notifications (organization_id, user_id, type, title, body)
    values (p_org, p_to, 'assigned', 'הועברו אליכם רשומות של ' || coalesce(v_from_name, 'משתמש'),
            format('%s לידים, %s אנשי קשר, %s חברות, %s עסקאות, %s משימות, %s פגישות, %s הצעות מחיר ו-%s הזמנות.',
                   v_leads, v_contacts, v_companies, v_deals, v_tasks, v_meetings, v_quotes, v_orders));
  end if;

  return jsonb_build_object('leads', v_leads, 'contacts', v_contacts, 'companies', v_companies, 'deals', v_deals,
                            'tasks', v_tasks, 'meetings', v_meetings, 'quotes', v_quotes, 'orders', v_orders);
end;
$$;
revoke all on function public.transfer_records(uuid, uuid, uuid) from public, anon;
grant execute on function public.transfer_records(uuid, uuid, uuid) to authenticated;
