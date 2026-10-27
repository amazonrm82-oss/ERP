-- =============================================================================
-- RVW-54 (weekly review 27 October 2026): app.payments_advance's same-customer test answered NULL, not false, when one side
-- had no deal or no contact (`v_deal is not null and v_deal = new.deal_id` is null when new.deal_id is null), and
-- `if ... or not (NULL) then raise` does not raise. A contact-only payment could be marked as an advance of a sent quote on
-- another customer's deal that has no contact. Each equality term is now coalesced to false (as 021075 did for
-- app.money_same_customer), so the test always answers true or false.
-- * Body copied from its only definition (020890) with only the two coalesces added. Signature, grants and trigger unchanged.
-- Every statement is safe to run twice. No drops, no row removal.

-- a person's mark and link (invoker: the quote or order is read with the person's rights)
create or replace function app.payments_advance() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_deal uuid;
  v_contact uuid;
  v_company uuid;
  v_status text;
  v_found boolean := false;
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if row(new.is_advance, new.advance_quote_id, new.advance_order_id)
       is not distinct from row(old.is_advance, old.advance_quote_id, old.advance_order_id) then
      return new;
    end if;
    if old.status = 'cancelled' then
      raise exception 'a cancelled payment does not change' using errcode = 'P0001', hint = 'payment:cancelled';
    end if;
    if not app.is_admin(new.organization_id) then
      raise exception 'only owners and admins correct a payment' using errcode = 'P0001', hint = 'payment:correction';
    end if;
    if new.advance_quote_id is not distinct from old.advance_quote_id
       and new.advance_order_id is not distinct from old.advance_order_id then
      return new;
    end if;
  end if;
  if new.advance_quote_id is not null then
    select q.deal_id, q.contact_id, null::uuid, q.status, true into v_deal, v_contact, v_company, v_status, v_found
      from public.quotes q where q.organization_id = new.organization_id and q.id = new.advance_quote_id;
  elsif new.advance_order_id is not null then
    select o.deal_id, o.contact_id, o.company_id, o.status, true into v_deal, v_contact, v_company, v_status, v_found
      from public.orders o where o.organization_id = new.organization_id and o.id = new.advance_order_id;
  else
    return new;
  end if;
  if not coalesce(v_found, false) or v_status in ('draft', 'cancelled')
     or not (coalesce(v_deal is not null and v_deal = new.deal_id, false)
             or coalesce(v_contact is not null and v_contact = new.contact_id, false)
             or exists (
                  select 1
                    from (select c.company_id from public.contacts c where c.organization_id = new.organization_id and c.id = new.contact_id
                          union all
                          select d.company_id from public.deals d where d.organization_id = new.organization_id and d.id = new.deal_id) a
                    join (select c.company_id from public.contacts c where c.organization_id = new.organization_id and c.id = v_contact
                          union all
                          select d.company_id from public.deals d where d.organization_id = new.organization_id and d.id = v_deal
                          union all
                          select v_company) b on a.company_id = b.company_id)) then
    raise exception 'an advance links a sent quote or a numbered order of the same customer' using errcode = 'P0001', hint = 'payment:advance_link';
  end if;
  return new;
end;
$$;
revoke all on function app.payments_advance() from public, anon, authenticated, service_role;
