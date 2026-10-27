-- =============================================================================
-- PAY-02 fix (review of GAP-12, 27 October 2026): app.money_same_customer answered NULL, not false, when one side had no deal
-- or no contact (`p_deal_a is not null and p_deal_a = p_deal_b` is null when p_deal_b is null). Its callers write
-- `not app.money_same_customer(...)` (payment_allocations_check) or `... or not app.money_same_customer(...) or ...`
-- (accounting_documents_proforma), so a NULL let the write through: a payment with a deal and no contact could be allocated
-- to an unrelated contact's invoice, and an invoice on a deal with no contact could bill another customer's contact-only
-- proforma. Every equality term is now coalesced to false, so the function always answers true or false.
-- * Body copied from its latest definition (020790) with only the coalesces added. Signature, grants and callers unchanged.
-- * Stands alone: depends on nothing newer than 020790.
-- Every statement is safe to run twice. No drops, no row removal.

create or replace function app.money_same_customer(p_org uuid, p_deal_a uuid, p_contact_a uuid, p_deal_b uuid, p_contact_b uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce(p_deal_a is not null and p_deal_a = p_deal_b, false)
      or coalesce(p_contact_a is not null and p_contact_a = p_contact_b, false)
      or exists (
           select 1
             from (select c.company_id from public.contacts c where c.organization_id = p_org and c.id = p_contact_a
                   union all
                   select d.company_id from public.deals d where d.organization_id = p_org and d.id = p_deal_a) a
             join (select c.company_id from public.contacts c where c.organization_id = p_org and c.id = p_contact_b
                   union all
                   select d.company_id from public.deals d where d.organization_id = p_org and d.id = p_deal_b) b
               on a.company_id = b.company_id
         )
$$;
revoke all on function app.money_same_customer(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;
