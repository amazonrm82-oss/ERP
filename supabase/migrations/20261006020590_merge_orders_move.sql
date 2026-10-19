-- =============================================================================
-- A merge moves orders in app.merge_move_links, like quotes (ORD-01 follow-up)
-- =============================================================================
-- ORD-01 (020570) moved a merged duplicate's orders in app.merge_orders, a trigger on the `merged` timeline entry
-- (as CON-05 does for company links). Orders now move where every other link moves: app.merge_move_links, called by
-- public.merge_records before the duplicate is removed.
-- * app.merge_move_links: the body of 20261006020105 (QUO-01, its latest) plus the orders block. A contact merge points
--   orders.contact_id and orders.delivery_contact_id at the kept contact; a company merge points orders.company_id at the
--   kept company; a lead has no orders. Every update is held to p_org. app.order_server is 'on' only for these updates
--   (numbered orders are frozen for a person) and is then put back to what it was.
-- * app.merge_orders: now does nothing, so nothing moves twice. The trigger activities_merge_orders stays (no drop);
--   its function returns at once.
-- Only redefines two functions; safe to run twice.

create or replace function app.merge_move_links(p_org uuid, p_type text, p_keep uuid, p_merge uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $$
declare
  v_col text := p_type || '_id';
  v_owner uuid;
  v_team uuid;
  v_server text;
begin
  execute format('update public.activities set %1$I = $1 where organization_id = $2 and %1$I = $3', v_col) using p_keep, p_org, p_merge;
  execute format('update public.tasks set %1$I = $1 where organization_id = $2 and %1$I = $3', v_col) using p_keep, p_org, p_merge;
  execute format('update public.files set %1$I = $1 where organization_id = $2 and %1$I = $3', v_col) using p_keep, p_org, p_merge;
  execute format('update public.meetings set %1$I = $1 where organization_id = $2 and %1$I = $3', v_col) using p_keep, p_org, p_merge;
  update public.notifications set entity_id = p_keep where organization_id = p_org and entity_id = p_merge;
  -- CNS-01: the duplicate's consent history goes to the kept record (time and seq kept;
  -- the guard lets the link move and subject_id follows)
  if p_type in ('lead', 'contact') then
    execute format('update public.consents set %1$I = $1 where organization_id = $2 and %1$I = $3', v_col) using p_keep, p_org, p_merge;
  end if;
  -- followers who may read the kept record, one row per user; a row that would
  -- clash, or whose user may not read the kept record, stays and goes with the duplicate
  execute format('select owner_id, team_id from public.%I where organization_id = $1 and id = $2',
                 case p_type when 'lead' then 'leads' when 'contact' then 'contacts' else 'companies' end)
    into v_owner, v_team using p_org, p_keep;
  execute format(
    'update public.record_followers f set %1$I = $1
      where f.organization_id = $2 and f.%1$I = $3
        and app.user_can_read_record($2, f.user_id, $4, $5)
        and not exists (select 1 from public.record_followers k
                         where k.organization_id = $2 and k.user_id = f.user_id and k.%1$I = $1)', v_col)
    using p_keep, p_org, p_merge, v_owner, v_team;

  if p_type = 'lead' then
    update public.form_submissions set lead_id = p_keep where organization_id = p_org and lead_id = p_merge;
    -- LEAD-05: a call-back the duplicate asked for counts for the kept lead (one mark,
    -- the earliest time); the duplicate's own mark goes with it by cascade
    insert into app.lead_callback_requests as k (organization_id, lead_id, requested_at)
    select c.organization_id, p_keep, c.requested_at
      from app.lead_callback_requests c
     where c.organization_id = p_org and c.lead_id = p_merge
    on conflict (organization_id, lead_id) do update
      set requested_at = least(k.requested_at, excluded.requested_at);
    perform app.lead_score_write(p_org, p_keep);
  elsif p_type = 'contact' then
    update public.deals set contact_id = p_keep where organization_id = p_org and contact_id = p_merge;
    -- one row per deal: a row that would clash stays and goes with the duplicate
    update public.deal_contacts dc set contact_id = p_keep
     where dc.organization_id = p_org and dc.contact_id = p_merge
       and not exists (select 1 from public.deal_contacts k where k.deal_id = dc.deal_id and k.contact_id = p_keep);
    update public.leads set converted_contact_id = p_keep where organization_id = p_org and converted_contact_id = p_merge;
    perform app.merge_contact_channels_move(p_org, p_keep, p_merge);
    -- QUO-01: its quotes (they would go with the duplicate by cascade)
    update public.quotes set contact_id = p_keep where organization_id = p_org and contact_id = p_merge;
  elsif p_type = 'company' then
    update public.contacts set company_id = p_keep where organization_id = p_org and company_id = p_merge;
    update public.deals set company_id = p_keep where organization_id = p_org and company_id = p_merge;
    update public.leads set converted_company_id = p_keep where organization_id = p_org and converted_company_id = p_merge;
    update public.companies set parent_company_id = case when id = p_keep then null else p_keep end
     where organization_id = p_org and parent_company_id = p_merge;
    -- QUO-01: its quotes
    update public.quotes set company_id = p_keep where organization_id = p_org and company_id = p_merge;
  end if;

  -- ORD-01: its orders (moved here from the `merged` entry's trigger app.merge_orders, 020570). A numbered order is
  -- frozen for a person; this is a server move, so app.order_server is on for these updates only and then put back.
  -- A lead has no orders.
  if p_type in ('contact', 'company') then
    v_server := current_setting('app.order_server', true);
    perform set_config('app.order_server', 'on', true);
    if p_type = 'contact' then
      update public.orders set contact_id = p_keep where organization_id = p_org and contact_id = p_merge;
      update public.orders set delivery_contact_id = p_keep where organization_id = p_org and delivery_contact_id = p_merge;
    else
      update public.orders set company_id = p_keep where organization_id = p_org and company_id = p_merge;
    end if;
    perform set_config('app.order_server', coalesce(v_server, ''), true);
  end if;
end;
$$;
revoke all on function app.merge_move_links(uuid, text, uuid, uuid) from public, anon, authenticated;

create or replace function app.merge_orders() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- orders move in app.merge_move_links since this migration; the `merged` entry no longer moves anything
  return null;
end;
$$;
revoke all on function app.merge_orders() from public, anon, authenticated, service_role;
