-- =============================================================================
-- PAY-02 answer 7 (owner, 21 October 2026): an optional due date on a tax invoice or a proforma, filled from the customer's
-- payment terms (CON-08) and editable on the document
-- =============================================================================
-- * accounting_documents.due_date (nullable). Only a tax invoice or a proforma carries one (hint document:due_date), never
--   before the document's date (same hint). A person sets it on insert and changes or clears it later only while the document
--   is active (a cancelled document's date never changes, same hint)
--   (column grants; accounting_documents_check leaves it alone: it is not one of the document's frozen facts).
-- * On insert, an empty due date of a tax invoice or a proforma is filled by app.payment_due_date(doc_date, terms, days)
--   (0179) from the effective terms: the document's contact (else its deal's contact) when that contact has terms, else that
--   contact's company, else the deal's company; no terms anywhere = no due date. The terms are read as the server (definer):
--   a recorder who cannot read the company still gets its terms' date, and only the date.
-- * "Overdue" (the screen): a due date before the business's today and a balance above 0 (public.money_allocation_state).
-- Every statement is safe to run twice. No drops, no row removal.

alter table public.accounting_documents add column if not exists due_date date;
grant insert (due_date), update (due_date) on public.accounting_documents to authenticated;

-- the effective terms of a document's customer, as (terms, days); null when none (no grants)
create or replace function app.document_customer_terms(p_org uuid, p_deal uuid, p_contact uuid)
returns table (terms text, days integer)
language sql stable security definer
set search_path = ''
as $$
  with customer as (
    select coalesce(p_contact, (select d.contact_id from public.deals d where d.organization_id = p_org and d.id = p_deal)) as contact_id,
           (select d.company_id from public.deals d where d.organization_id = p_org and d.id = p_deal) as deal_company_id
  )
  select t.terms, t.days
    from customer cu,
         lateral (
           select c.payment_terms as terms, c.payment_days as days, 1 as rank
             from public.contacts c where c.organization_id = p_org and c.id = cu.contact_id and c.payment_terms is not null
           union all
           select co.payment_terms, co.payment_days, 2
             from public.contacts c
             join public.companies co on co.organization_id = c.organization_id and co.id = c.company_id
            where c.organization_id = p_org and c.id = cu.contact_id and co.payment_terms is not null
           union all
           select co.payment_terms, co.payment_days, 3
             from public.companies co where co.organization_id = p_org and co.id = cu.deal_company_id and co.payment_terms is not null
         ) t
   order by t.rank
   limit 1
$$;
revoke all on function app.document_customer_terms(uuid, uuid, uuid) from public, anon, authenticated, service_role;

create or replace function app.accounting_documents_due_date() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_terms record;
begin
  -- outsider guard: RLS refuses (42501) a person who may not record documents here, before anything is revealed
  if auth.uid() is not null and not (app.can_record_documents(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;
  if tg_op = 'INSERT' and new.due_date is null and new.doc_type in ('tax_invoice', 'proforma') then
    select * into v_terms from app.document_customer_terms(new.organization_id, new.deal_id, new.contact_id);
    if v_terms.terms is not null then
      begin
        new.due_date := app.payment_due_date(new.doc_date, v_terms.terms, v_terms.days);
      exception when sqlstate '22023' then
        -- terms the date rule refuses (payment_terms:invalid) leave the date empty; the document is still recorded
        new.due_date := null;
      end;
    end if;
  end if;
  -- a cancelled document's due date never changes, cleared or set (review of 020765)
  if tg_op = 'UPDATE' and new.due_date is distinct from old.due_date and (old.status <> 'active' or new.status <> 'active') then
    raise exception 'a cancelled document keeps its due date' using errcode = 'P0001', hint = 'document:due_date';
  end if;
  if new.due_date is distinct from (case when tg_op = 'UPDATE' then old.due_date end) and new.due_date is not null then
    if new.doc_type not in ('tax_invoice', 'proforma') or new.due_date < new.doc_date then
      raise exception 'a due date goes on an active tax invoice or proforma, on or after its date' using errcode = 'P0001', hint = 'document:due_date';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.accounting_documents_due_date() from public, anon, authenticated, service_role;

create or replace trigger accounting_documents_due_date before insert or update of due_date on public.accounting_documents
  for each row execute function app.accounting_documents_due_date();
