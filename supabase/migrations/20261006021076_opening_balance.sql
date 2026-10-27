-- =============================================================================
-- GAP-12 (continued): the opening balance of an imported customer (owner, 26 October 2026, DECISIONS.md "היסטוריה בייבוא:
-- יתרות, כרטיסייה ודוחות", answer (1) א). Plan key `documents`, as DOC-01.
-- =============================================================================
-- * A new accounting document type `opening_balance` ("יתרת פתיחה"). Representation:
--     - the amount is SIGNED for this type only: positive = the customer owes (a debit), negative = the business owes the
--       customer (a credit); never 0. Every other type keeps amount_agorot between 0 and 10^12 (constraint
--       accounting_documents_amount_agorot_check, replaced here with the same rule for them);
--     - no running number: `number` is null for this type and only for it (constraint accounting_documents_number_shape;
--       the column loses its NOT NULL). The type+number uniqueness of the other types is unchanged: the unique index
--       accounting_documents_number_once treats nulls as distinct, and accounting_documents_check skips its duplicate check
--       (document:duplicate) for this type only. The screen and the timeline name it "יתרת פתיחה מתאריך <date>".
-- * Owner's answers of 26 October 2026: (1) א a company may hold it (company_id, opening balances only); (3) ב one active
--   per customer, replaced through public.opening_balance_set (the old one cancelled "הוחלפה בייבוא" / "הוחלפה ביתרה חדשה");
--   (4) ג no due date from the payment terms, only a typed one; (5) ב no document_recorded automation.
-- * Owners and admins only (app.is_admin): recording it (hint document:opening_admin, in accounting_documents_check after
--   the outsider guard, so a stranger still meets RLS's 42501), and any later change of it by a person (cancelling, its due
--   date). The server paths (the FK set-null of a purge, a merge, an erasure) pass as for every document. No order link
--   (document:opening_balance), never a deal (accounting_documents_opening_shape): a contact's or a company's.
-- * Like a regular document:
--     - a positive opening balance is a debt like a tax invoice: it takes payments (PAY-02: payment_allocations_check,
--       money_allocation_candidates; a company's from the payments of that company's contacts and deals,
--       app.money_in_company), has a balance and a state (money_allocation_state), a typed due date, counts as overdue and
--       in the debt_overdue automation (app.scheduled_debt_overdue; AUT-06's still-holds and app.document_balance read
--       money_allocation_state unchanged), and money_apply_credit offers it the customer's credit (through the candidates);
--     - a negative opening balance is a credit like a credit invoice: no balance or state ('none'), no payments, no due date;
--       in the ledger it is a credit line. (PAY-03 credit: see the next migration, opening_credit.)
--     - BAL-01 (customer_ledger, both branches, and app.customer_money_rows): a debit of the positive amount, or a credit of
--       the negative amount's size; a company's is a line of the company's ledger and of its contacts'.
--     - DOC-04 timeline: "נרשם מסמך: יתרת פתיחה מתאריך DD.MM.YYYY" (app.document_type_label learns the type), on the
--       contact or the company.
--     - except: it never fires the AUT-04 document_recorded automation trigger (a WHEN on accounting_documents_emit_recorded).
--     - LST-09: app.export_choice_values keeps 'opening_balance' in an export's audit filters.
--     - merge: a contact's moves with app.merge_move_links as before; a company's through the `merged` entry
--       (app.merge_company_opening_balances). Erasure: SHARED GROUND app.audit_erase_core, one marked change (companies).
-- * Bodies copied from their latest definitions, changed only where marked GAP-12: app.accounting_documents_check (020630),
--   app.accounting_documents_due_date (020795), app.payment_allocations_check and public.money_allocation_candidates (020790),
--   public.money_allocation_state (020890), app.scheduled_debt_overdue (020805), public.customer_ledger and
--   app.customer_money_rows (020895), app.document_type_label and app.accounting_documents_timeline (020750),
--   app.export_choice_values (020690), app.audit_erase_core (021030). payment_allocations_check also coalesces
--   app.money_same_customer, which answered null (letting a payment through) when one side had no deal or no contact.
--   Not changed: an erased customer's document file is renamed "מסמך <number>"; for an opening balance that reads "מסמך"
--   with the extension (a neutral name, nothing personal).
-- Every statement is safe to run twice. No drops of objects, no row removal.

-- ----------------------------------------------------------------------------
-- The type, the signed amount and the missing number
-- ----------------------------------------------------------------------------
alter table public.accounting_documents drop constraint if exists accounting_documents_doc_type_check;
alter table public.accounting_documents add constraint accounting_documents_doc_type_check
  check (doc_type in ('tax_invoice', 'tax_invoice_receipt', 'receipt', 'credit_invoice', 'proforma', 'opening_balance'));

alter table public.accounting_documents drop constraint if exists accounting_documents_amount_agorot_check;
alter table public.accounting_documents add constraint accounting_documents_amount_agorot_check check (
  (doc_type <> 'opening_balance' and amount_agorot between 0 and 1000000000000)
  or (doc_type = 'opening_balance' and amount_agorot between -1000000000000 and 1000000000000 and amount_agorot <> 0));

alter table public.accounting_documents alter column number drop not null;
alter table public.accounting_documents drop constraint if exists accounting_documents_number_shape;
alter table public.accounting_documents add constraint accounting_documents_number_shape
  check ((doc_type = 'opening_balance') = (number is null));

-- ----------------------------------------------------------------------------
-- Owner's answer (1) א: an opening balance may belong to a company. company_id is allowed on an opening balance only
-- (constraint accounting_documents_company_shape): every other document keeps its deal/contact rule, so PAY-02's
-- proforma link, quick sale, files and DOC-04 stay as they are. An opening balance is a customer's, never a deal's: it is
-- on a contact or on a company, never both and never on a deal (accounting_documents_opening_shape; the trigger asks for
-- one of the two on insert, a purge may later leave none, like every document).
-- Reading a company's opening balance follows the company's RLS (a document follows its deal, else its contact, else its
-- company, else owners/admins/managers by role). A purge clears company_id (set null of the column). Insert-only grant,
-- like the other parent columns.
-- ----------------------------------------------------------------------------
alter table public.accounting_documents add column if not exists company_id uuid;
alter table public.accounting_documents drop constraint if exists accounting_documents_company_fk;
alter table public.accounting_documents add constraint accounting_documents_company_fk foreign key (organization_id, company_id)
  references public.companies (organization_id, id) on delete set null (company_id);
create index if not exists accounting_documents_company_idx on public.accounting_documents (organization_id, company_id);
grant insert (company_id) on public.accounting_documents to authenticated;
-- the lead's interim decision (27 October 2026): an import's own opening balances carry the job (server only, no grant), so
-- the import's undo cancels them and they are not "work" on the imported record
alter table public.accounting_documents add column if not exists import_job_id uuid;
alter table public.accounting_documents drop constraint if exists accounting_documents_import_job_fk;
alter table public.accounting_documents add constraint accounting_documents_import_job_fk foreign key (organization_id, import_job_id)
  references public.import_jobs (organization_id, id) on delete set null (import_job_id);
create index if not exists accounting_documents_import_job_idx on public.accounting_documents (organization_id, import_job_id);
alter table public.accounting_documents drop constraint if exists accounting_documents_company_shape;
alter table public.accounting_documents add constraint accounting_documents_company_shape
  check (company_id is null or doc_type = 'opening_balance');
alter table public.accounting_documents drop constraint if exists accounting_documents_opening_shape;
alter table public.accounting_documents add constraint accounting_documents_opening_shape
  check (doc_type <> 'opening_balance' or (deal_id is null and (contact_id is null or company_id is null)));

alter policy accounting_documents_select on public.accounting_documents
  using (case when accounting_documents.deal_id is not null
              then exists (select 1 from public.deals d where d.organization_id = accounting_documents.organization_id and d.id = accounting_documents.deal_id)
              when accounting_documents.contact_id is not null
              then exists (select 1 from public.contacts c where c.organization_id = accounting_documents.organization_id and c.id = accounting_documents.contact_id)
              -- GAP-12: a company's opening balance follows the company
              when accounting_documents.company_id is not null
              then exists (select 1 from public.companies co where co.organization_id = accounting_documents.organization_id and co.id = accounting_documents.company_id)
              else coalesce(app.role_in(accounting_documents.organization_id) in ('owner', 'admin', 'manager'), false)
         end);
alter policy accounting_documents_insert on public.accounting_documents
  with check (app.can_record_documents(organization_id) and app.org_writable(organization_id)
              and app.org_has_feature(organization_id, 'documents')
              and (deal_id is not null or contact_id is not null or company_id is not null)
              and (deal_id is null or exists (select 1 from public.deals d
                                               where d.organization_id = accounting_documents.organization_id
                                                 and d.id = accounting_documents.deal_id and d.deleted_at is null))
              and (contact_id is null or exists (select 1 from public.contacts c
                                                  where c.organization_id = accounting_documents.organization_id
                                                    and c.id = accounting_documents.contact_id and c.deleted_at is null))
              -- GAP-12: a live company the caller reads
              and (company_id is null or exists (select 1 from public.companies co
                                                  where co.organization_id = accounting_documents.organization_id
                                                    and co.id = accounting_documents.company_id and co.deleted_at is null)));
alter policy accounting_documents_update on public.accounting_documents
  using (app.can_record_documents(organization_id) and app.org_writable(organization_id)
         and case when accounting_documents.deal_id is not null
                  then exists (select 1 from public.deals d where d.organization_id = accounting_documents.organization_id and d.id = accounting_documents.deal_id)
                  when accounting_documents.contact_id is not null
                  then exists (select 1 from public.contacts c where c.organization_id = accounting_documents.organization_id and c.id = accounting_documents.contact_id)
                  when accounting_documents.company_id is not null
                  then exists (select 1 from public.companies co where co.organization_id = accounting_documents.organization_id and co.id = accounting_documents.company_id)
                  else coalesce(app.role_in(accounting_documents.organization_id) in ('owner', 'admin', 'manager'), false)
             end)
  with check (app.can_record_documents(organization_id) and app.org_writable(organization_id));

-- ----------------------------------------------------------------------------
-- Who records it, and its number (020630's trigger)
-- ----------------------------------------------------------------------------
create or replace function app.accounting_documents_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- outsider guard: RLS refuses (42501) a person who may not record documents here, before anything is revealed
  if auth.uid() is not null and not (app.can_record_documents(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- GAP-12: an opening balance is recorded by owners and admins only, carries no number and no order
    if new.doc_type = 'opening_balance' then
      if auth.uid() is not null and not app.is_admin(new.organization_id) then
        raise exception 'only owners and admins record an opening balance' using errcode = 'P0001', hint = 'document:opening_admin';
      end if;
      if new.order_id is not null then
        raise exception 'an opening balance belongs to no order' using errcode = 'P0001', hint = 'document:opening_balance';
      end if;
      new.number := null;
    else
      new.number := btrim(coalesce(new.number, ''));
    end if;
    new.status := 'active';
    new.cancel_reason := null;
    new.cancelled_at := null;
    new.cancelled_by := null;
    new.created_by := coalesce(auth.uid(), new.created_by);
    -- GAP-12: or, for an opening balance, a company
    if new.deal_id is null and new.contact_id is null and new.company_id is null then
      raise exception 'a document belongs to a deal or a contact' using errcode = 'P0001', hint = 'document:parent';
    end if;
    if new.doc_type = 'opening_balance' then
      -- owner's answer (3) ב: one active opening balance per customer (a contact, or a company); a new one replaces the old
      -- through public.opening_balance_set, which cancels it first in the same transaction. A merge may leave two on the
      -- kept record (both stay counted); the next replace cancels every active one.
      perform pg_advisory_xact_lock(hashtextextended('opening_balance:' || new.organization_id::text || ':'
                                                     || coalesce(new.contact_id, new.company_id)::text, 0));
      if exists (select 1 from public.accounting_documents a
                  where a.organization_id = new.organization_id and a.doc_type = 'opening_balance' and a.status = 'active'
                    and ((new.contact_id is not null and a.contact_id = new.contact_id)
                         or (new.company_id is not null and a.company_id = new.company_id))) then
        raise exception 'the customer has an opening balance already; replace it' using errcode = 'P0001', hint = 'document:opening_exists';
      end if;
      return new;
    end if;
    -- the same type and number once per business (the unique index stays behind it for a race)
    perform pg_advisory_xact_lock(hashtextextended('accounting_documents:' || new.organization_id::text || ':' || new.doc_type || ':' || new.number, 0));
    if exists (select 1 from public.accounting_documents a
                where a.organization_id = new.organization_id and a.doc_type = new.doc_type and a.number = new.number) then
      raise exception 'a document of this type and number is already recorded' using errcode = 'P0001', hint = 'document:duplicate';
    end if;
    return new;
  end if;

  -- UPDATE. A purge clears the deal or the contact through the composite FK (a nested trigger): only that passes
  if pg_trigger_depth() > 1
     and (row(new.organization_id, new.doc_type, new.number, new.doc_date, new.amount_agorot, new.currency, new.status,
              new.cancel_reason, new.cancelled_at, new.cancelled_by, new.created_by, new.created_at)
          is not distinct from
          row(old.organization_id, old.doc_type, old.number, old.doc_date, old.amount_agorot, old.currency, old.status,
              old.cancel_reason, old.cancelled_at, old.cancelled_by, old.created_by, old.created_at))
     and (new.deal_id is not distinct from old.deal_id or new.deal_id is null)
     and (new.contact_id is not distinct from old.contact_id or new.contact_id is null)
     and (new.company_id is not distinct from old.company_id or new.company_id is null)
     and (new.import_job_id is not distinct from old.import_job_id or new.import_job_id is null) then
    return new;
  end if;
  -- a privacy erasure replaces a cancel reason with the neutral text (app.audit_erase_core sets the flag for its update only)
  if current_setting('app.document_server', true) = 'erase'
     and old.status = 'cancelled'
     and new.cancel_reason = 'הסיבה נמחקה (מחיקת פרטיות)'
     and row(new.organization_id, new.deal_id, new.contact_id, new.company_id, new.doc_type, new.number, new.doc_date,
             new.amount_agorot, new.currency, new.status, new.cancelled_at, new.cancelled_by, new.created_by, new.created_at)
         is not distinct from
         row(old.organization_id, old.deal_id, old.contact_id, old.company_id, old.doc_type, old.number, old.doc_date,
             old.amount_agorot, old.currency, old.status, old.cancelled_at, old.cancelled_by, old.created_by, old.created_at) then
    return new;
  end if;
  -- a merge moves the duplicate contact's documents (app.merge_move_links sets the flag for its updates only); GAP-12: and a
  -- company merge the duplicate company's opening balances (app.merge_company_opening_balances)
  if current_setting('app.document_server', true) = 'on'
     and row(new.organization_id, new.deal_id, new.doc_type, new.number, new.doc_date, new.amount_agorot, new.currency,
             new.status, new.cancel_reason, new.cancelled_at, new.cancelled_by)
         is not distinct from
         row(old.organization_id, old.deal_id, old.doc_type, old.number, old.doc_date, old.amount_agorot, old.currency,
             old.status, old.cancel_reason, old.cancelled_at, old.cancelled_by) then
    return new;
  end if;
  -- GAP-12: undoing an import cancels the job's own opening balances (app.import_opening_cancel sets the flag for its
  -- update only): the cancel and nothing else, whoever undoes
  if current_setting('app.document_server', true) = 'undo'
     and old.doc_type = 'opening_balance' and old.status = 'active' and old.import_job_id is not null
     and new.status = 'cancelled' and new.cancel_reason = 'בוטל עם ביטול הייבוא'
     and row(new.organization_id, new.deal_id, new.contact_id, new.company_id, new.doc_type, new.number, new.doc_date,
             new.amount_agorot, new.currency, new.due_date, new.import_job_id, new.created_by, new.created_at)
         is not distinct from
         row(old.organization_id, old.deal_id, old.contact_id, old.company_id, old.doc_type, old.number, old.doc_date,
             old.amount_agorot, old.currency, old.due_date, old.import_job_id, old.created_by, old.created_at) then
    new.cancelled_at := now();
    new.cancelled_by := auth.uid();
    return new;
  end if;
  -- GAP-12: a person other than an owner or admin changes nothing on an opening balance (its due date and its cancelling
  -- included); the server paths above passed already
  if old.doc_type = 'opening_balance' and auth.uid() is not null and not app.is_admin(new.organization_id) then
    raise exception 'only owners and admins change an opening balance' using errcode = 'P0001', hint = 'document:opening_admin';
  end if;
  -- (the currency is held to 'ILS' by its check until DEAL-12; then it joins this list)
  if row(new.organization_id, new.deal_id, new.contact_id, new.company_id, new.doc_type, new.number, new.doc_date,
         new.amount_agorot, new.import_job_id, new.created_by, new.created_at)
     is distinct from
     row(old.organization_id, old.deal_id, old.contact_id, old.company_id, old.doc_type, old.number, old.doc_date,
         old.amount_agorot, old.import_job_id, old.created_by, old.created_at) then
    raise exception 'a recorded document does not change; cancel it instead' using errcode = 'P0001', hint = 'document:frozen';
  end if;
  if old.status = 'cancelled' then
    if new.status is distinct from old.status or new.cancel_reason is distinct from old.cancel_reason
       or new.cancelled_at is distinct from old.cancelled_at or new.cancelled_by is distinct from old.cancelled_by then
      raise exception 'a cancelled document stays cancelled' using errcode = 'P0001', hint = 'document:cancelled';
    end if;
    return new;
  end if;
  if new.status = 'active' then
    if new.cancel_reason is not null then
      raise exception 'a reason goes with a cancellation' using errcode = 'P0001', hint = 'document:cancel_reason';
    end if;
    new.cancelled_at := null;
    new.cancelled_by := null;
    return new;
  end if;
  -- cancelling: the reason is required, the time and the person are the server's
  new.cancel_reason := nullif(btrim(coalesce(new.cancel_reason, '')), '');
  if new.cancel_reason is null or char_length(new.cancel_reason) > 500 then
    raise exception 'cancelling needs a reason' using errcode = 'P0001', hint = 'document:cancel_reason';
  end if;
  new.cancelled_at := now();
  new.cancelled_by := auth.uid();
  return new;
end;
$$;
revoke all on function app.accounting_documents_check() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- AUT-04: an opening balance is a historical balance, not a newly issued document: it never fires the document_recorded
-- trigger (the lead's interim decision, an owner question). Only the trigger's WHEN changes; app.emit_document_recorded
-- (020800) is unchanged. The timeline entry stays.
-- ----------------------------------------------------------------------------
create or replace trigger accounting_documents_emit_recorded after insert on public.accounting_documents
  for each row when (new.doc_type <> 'opening_balance') execute function app.emit_document_recorded();

-- ----------------------------------------------------------------------------
-- A positive opening balance carries a due date (020795's trigger)
-- ----------------------------------------------------------------------------
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
  -- GAP-12, owner's answer (4) ג: an opening balance never gets a due date from the terms; only a typed one
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
    -- GAP-12: a positive opening balance (a debt) carries one too
    if (new.doc_type not in ('tax_invoice', 'proforma') and not (new.doc_type = 'opening_balance' and new.amount_agorot > 0))
       or new.due_date < new.doc_date then
      raise exception 'a due date goes on an active tax invoice, proforma or opening debt, on or after its date' using errcode = 'P0001', hint = 'document:due_date';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.accounting_documents_due_date() from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- PAY-02: a positive opening balance takes payments (020790, 020890)
-- ----------------------------------------------------------------------------
-- GAP-12: PAY-02's "same customer" for a company's opening balance: the payment's contact's company or its deal's company
-- is that company (the company part of app.money_same_customer; ids only; no grants). Mirrored inline in
-- public.money_allocation_candidates (keep in step).
create or replace function app.money_in_company(p_org uuid, p_deal uuid, p_contact uuid, p_company uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_company is not null
     and (exists (select 1 from public.contacts c where c.organization_id = p_org and c.id = p_contact and c.company_id = p_company)
          or exists (select 1 from public.deals d where d.organization_id = p_org and d.id = p_deal and d.company_id = p_company))
$$;
revoke all on function app.money_in_company(uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;

create or replace function app.payment_allocations_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_payment public.payments;
  v_doc public.accounting_documents;
  v_proforma public.accounting_documents;
  v_doc_total bigint;
begin
  -- outsider guard: RLS refuses (42501) a person who may not allocate here, before anything is revealed
  if auth.uid() is not null and not (app.can_record_payments(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    -- (the currency is held to 'ILS' by its check until DEAL-12; then it joins this list)
    if row(new.organization_id, new.payment_id, new.document_id, new.created_by, new.created_at)
       is distinct from row(old.organization_id, old.payment_id, old.document_id, old.created_by, old.created_at) then
      raise exception 'an allocation stays on its payment and document' using errcode = 'P0001', hint = 'allocation:fixed';
    end if;
    -- the server's release (the release triggers below, one level down; a person has no grant on the column): the time
    -- only, once; it locks nothing (the payment or the document is already held by the statement that released it)
    if new.released_at is distinct from old.released_at then
      if old.released_at is not null or new.released_at is null or pg_trigger_depth() < 2
         or row(new.amount_agorot, new.removed_at, new.removed_by) is distinct from row(old.amount_agorot, old.removed_at, old.removed_by) then
        raise exception 'only the server releases an allocation' using errcode = 'P0001', hint = 'allocation:closed';
      end if;
      return new;
    end if;
    if old.released_at is not null or old.removed_at is not null then
      raise exception 'a released or undone allocation does not change' using errcode = 'P0001', hint = 'allocation:closed';
    end if;
    if auth.uid() is not null and not app.is_admin(new.organization_id) then
      raise exception 'only owners and admins change an allocation' using errcode = 'P0001', hint = 'allocation:admin';
    end if;
    if new.removed_at is not null then
      -- undoing: the time and the person are the server's; the amount stays as it was
      if new.amount_agorot is distinct from old.amount_agorot then
        raise exception 'undo an allocation without changing its amount' using errcode = 'P0001', hint = 'allocation:closed';
      end if;
      new.removed_at := now();
      new.removed_by := auth.uid();
      return new;
    end if;
    new.removed_by := old.removed_by;
    if new.amount_agorot = old.amount_agorot then
      return new;
    end if;
  else
    new.released_at := null;
    new.removed_at := null;
    new.removed_by := null;
    new.created_by := coalesce(auth.uid(), new.created_by);
    if not app.org_has_feature(new.organization_id, 'payments') then
      raise exception 'payments are not in the plan' using errcode = 'P0001', hint = 'feature:payments';
    end if;
    if not app.org_has_feature(new.organization_id, 'documents') then
      raise exception 'documents are not in the plan' using errcode = 'P0001', hint = 'feature:documents';
    end if;
  end if;

  -- the lock order: the payment, then the document, then a tax invoice's proforma (a cancel locks its own row first: see the header)
  select * into v_payment from public.payments p
   where p.organization_id = new.organization_id and p.id = new.payment_id for update;
  select * into v_doc from public.accounting_documents d
   where d.organization_id = new.organization_id and d.id = new.document_id for update;
  if v_payment.id is null or v_doc.id is null then
    -- the composite foreign keys answer too
    raise exception 'the payment and the document are of this business' using errcode = 'P0001', hint = 'allocation:customer';
  end if;
  if v_doc.doc_type = 'tax_invoice' and v_doc.proforma_id is not null then
    select * into v_proforma from public.accounting_documents d
     where d.organization_id = new.organization_id and d.id = v_doc.proforma_id for update;
  end if;

  -- GAP-12: and a positive opening balance (a debt); a negative one is a credit and takes none
  if v_doc.doc_type not in ('tax_invoice', 'proforma')
     and not (v_doc.doc_type = 'opening_balance' and v_doc.amount_agorot > 0) then
    raise exception 'only a tax invoice, a proforma or an opening debt takes payments' using errcode = 'P0001', hint = 'allocation:doc_type';
  end if;
  if v_payment.status not in ('recorded', 'confirmed') then
    raise exception 'only a recorded or confirmed payment is allocated' using errcode = 'P0001', hint = 'allocation:payment_state';
  end if;
  if v_doc.status <> 'active' then
    raise exception 'a cancelled document takes no payments' using errcode = 'P0001', hint = 'allocation:document_state';
  end if;
  if v_doc.doc_type = 'proforma'
     and exists (select 1 from public.accounting_documents i
                  where i.organization_id = new.organization_id and i.proforma_id = v_doc.id and i.status = 'active') then
    raise exception 'this proforma is billed by a tax invoice; allocate to the invoice' using errcode = 'P0001', hint = 'allocation:transferred';
  end if;
  if tg_op = 'INSERT'
     -- GAP-12: coalesce: money_same_customer answers null (not false) when one side has no deal or no contact, which let a
     -- payment through to a document with no shared record
     and not coalesce(app.money_same_customer(new.organization_id, v_payment.deal_id, v_payment.contact_id, v_doc.deal_id, v_doc.contact_id), false)
     -- GAP-12: a company's opening balance takes the payments of that company's contacts and deals
     and not coalesce(app.money_in_company(new.organization_id, v_payment.deal_id, v_payment.contact_id, v_doc.company_id), false) then
    raise exception 'a payment is allocated to a document of the same customer' using errcode = 'P0001', hint = 'allocation:customer';
  end if;

  if app.allocated_on_payment(new.organization_id, v_payment.id, new.id) + new.amount_agorot > v_payment.amount_agorot then
    raise exception 'more than the payment holds' using errcode = 'P0001', hint = 'allocation:payment_over';
  end if;
  v_doc_total := app.allocated_on_document(new.organization_id, v_doc.id, new.id) + new.amount_agorot;
  if v_proforma.id is not null and v_proforma.status = 'active' then
    v_doc_total := v_doc_total + app.allocated_on_document(new.organization_id, v_proforma.id, null);
  end if;
  if v_doc_total > v_doc.amount_agorot then
    raise exception 'more than the document holds' using errcode = 'P0001', hint = 'allocation:document_over';
  end if;
  return new;
end;
$$;
revoke all on function app.payment_allocations_check() from public, anon, authenticated, service_role;

create or replace function public.money_allocation_state(p_org uuid, p_documents uuid[], p_payments uuid[])
returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  with counted as (
    select a.document_id, a.payment_id, a.amount_agorot from public.payment_allocations a
     where a.organization_id = p_org and a.released_at is null and a.removed_at is null
       and (a.document_id = any (coalesce(p_documents, '{}'))
            or a.payment_id = any (coalesce(p_payments, '{}'))
            or a.document_id in (select d.proforma_id from public.accounting_documents d
                                  where d.organization_id = p_org and d.id = any (coalesce(p_documents, '{}'))
                                    and d.proforma_id is not null))
  ),
  docs as (
    select d.id, d.doc_type, d.status, d.amount_agorot,
           coalesce((select sum(c.amount_agorot) from counted c where c.document_id = d.id), 0)
             + coalesce((select sum(c.amount_agorot) from counted c
                          join public.accounting_documents p on p.organization_id = p_org and p.id = c.document_id
                         where d.doc_type = 'tax_invoice' and c.document_id = d.proforma_id and p.status = 'active'), 0) as paid,
           (select i.number from public.accounting_documents i
             where d.doc_type = 'proforma' and i.organization_id = p_org and i.proforma_id = d.id and i.status = 'active') as invoice_number
      from public.accounting_documents d
     where d.organization_id = p_org and d.id = any (coalesce(p_documents, '{}'))
  )
  select jsonb_build_object(
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', x.id,
               'paid', x.paid,
               'balance', case when x.state in ('unpaid', 'partial') then greatest(x.amount_agorot - x.paid, 0) else 0 end,
               'state', x.state,
               'invoice_number', x.invoice_number) order by x.id)
        from (select docs.*,
                     case when docs.status <> 'active' then 'none'
                          when docs.doc_type = 'tax_invoice_receipt' then 'paid_on_issue'
                          -- GAP-12: a negative opening balance is a credit, like a credit invoice; a positive one is a debt
                          when docs.doc_type = 'opening_balance' and docs.amount_agorot <= 0 then 'none'
                          when docs.doc_type not in ('tax_invoice', 'proforma', 'opening_balance') then 'none'
                          when docs.invoice_number is not null then 'transferred'
                          when docs.paid >= docs.amount_agorot then 'paid'
                          when docs.paid > 0 then 'partial'
                          else 'unpaid' end as state
                from docs) x), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id,
               'allocated', coalesce((select sum(c.amount_agorot) from counted c where c.payment_id = p.id), 0),
               -- PAY-03: one rule for a payment's credit
               'credit', public.payment_credit(p)) order by p.id)
        from public.payments p
       where p.organization_id = p_org and p.id = any (coalesce(p_payments, '{}'))), '[]'::jsonb)
  )
$$;
revoke all on function public.money_allocation_state(uuid, uuid[], uuid[]) from public, anon;
grant execute on function public.money_allocation_state(uuid, uuid[], uuid[]) to authenticated;

create or replace function public.money_allocation_candidates(p_org uuid, p_payment uuid, p_document uuid)
returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  with origin as (
    select p.deal_id, p.contact_id from public.payments p where p.organization_id = p_org and p.id = p_payment
    union all
    select d.deal_id, d.contact_id from public.accounting_documents d where d.organization_id = p_org and d.id = p_document
  ),
  origin_companies as (
    select c.company_id from origin o join public.contacts c on c.organization_id = p_org and c.id = o.contact_id where c.company_id is not null
    union
    select d.company_id from origin o join public.deals d on d.organization_id = p_org and d.id = o.deal_id where d.company_id is not null
    union
    -- GAP-12: a company's opening balance is that company's
    select d.company_id from public.accounting_documents d
     where d.organization_id = p_org and d.id = p_document and d.company_id is not null
  ),
  same_deals as (
    select o.deal_id as id from origin o where o.deal_id is not null
    union
    select d.id from public.deals d where d.organization_id = p_org and d.company_id in (select company_id from origin_companies)
  ),
  same_contacts as (
    select o.contact_id as id from origin o where o.contact_id is not null
    union
    select c.id from public.contacts c where c.organization_id = p_org and c.company_id in (select company_id from origin_companies)
  ),
  open_docs as (
    select d.id, d.doc_type, d.number, d.doc_date, d.amount_agorot, d.proforma_id
      from public.accounting_documents d
     where d.organization_id = p_org and d.status = 'active'
       -- GAP-12: a positive opening balance takes payments like a tax invoice
       and (d.doc_type in ('tax_invoice', 'proforma') or (d.doc_type = 'opening_balance' and d.amount_agorot > 0))
       and (d.deal_id in (select id from same_deals) or d.contact_id in (select id from same_contacts)
            -- GAP-12: a company's opening balance
            or d.company_id in (select company_id from origin_companies))
       and not (d.doc_type = 'proforma'
                and exists (select 1 from public.accounting_documents i
                             where i.organization_id = p_org and i.proforma_id = d.id and i.status = 'active'))
  ),
  doc_state as (
    select (public.money_allocation_state(p_org, (select coalesce(array_agg(id), '{}') from open_docs), '{}') -> 'documents') as s
  ),
  open_payments as (
    select p.id, p.paid_on, p.method, p.amount_agorot
      from public.payments p
     where p.organization_id = p_org and p.status in ('recorded', 'confirmed')
       and (p.deal_id in (select id from same_deals) or p.contact_id in (select id from same_contacts))
  ),
  pay_state as (
    select (public.money_allocation_state(p_org, '{}', (select coalesce(array_agg(id), '{}') from open_payments)) -> 'payments') as s
  )
  select jsonb_build_object(
    'documents', case when p_payment is null then '[]'::jsonb else coalesce((
      select jsonb_agg(to_jsonb(t) order by t.doc_date, t.number)
        from (select d.id, d.doc_type, d.number, d.doc_date, d.amount_agorot as amount, (x ->> 'balance')::bigint as balance
                from open_docs d
                join lateral jsonb_array_elements((select s from doc_state)) x on (x ->> 'id')::uuid = d.id
               where (x ->> 'balance')::bigint > 0
               order by d.doc_date, d.number
               limit 100) t), '[]'::jsonb) end,
    'payments', case when p_document is null then '[]'::jsonb else coalesce((
      select jsonb_agg(to_jsonb(t) order by t.paid_on, t.id)
        from (select p.id, p.paid_on, p.method, p.amount_agorot as amount, (x ->> 'credit')::bigint as credit
                from open_payments p
                join lateral jsonb_array_elements((select s from pay_state)) x on (x ->> 'id')::uuid = p.id
               where (x ->> 'credit')::bigint > 0
               order by p.paid_on, p.id
               limit 100) t), '[]'::jsonb) end,
    'proformas', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.doc_date, t.number)
        from (select d.id, d.number, d.doc_date, d.amount_agorot as amount
                from open_docs d
               where d.doc_type = 'proforma'
                 and exists (select 1 from public.accounting_documents v
                              where v.organization_id = p_org and v.id = p_document and v.doc_type = 'tax_invoice'
                                and v.status = 'active' and v.proforma_id is null)
                 and not exists (select 1 from public.accounting_documents i
                                  where i.organization_id = p_org and i.proforma_id = d.id and i.status = 'active')
               order by d.doc_date, d.number
               limit 100) t), '[]'::jsonb)
  )
$$;
revoke all on function public.money_allocation_candidates(uuid, uuid, uuid) from public, anon;
grant execute on function public.money_allocation_candidates(uuid, uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- AUT-04: the debt_overdue scan (020805)
-- ----------------------------------------------------------------------------
create or replace function app.scheduled_debt_overdue(p_auto public.automations, p_budget integer) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_days integer := 0;
  v_zone text;
  v_local timestamp;
  v_today date;
  v_after uuid;
  v_row record;
  v_page integer;
  v_scanned integer := 0;
  v_limit integer := app.scheduled_scan_limit();
  v_page_size integer := least(200, v_limit);
  v_count integer := 0;
  v_key text;
begin
  if p_auto.entity_type not in ('deal', 'contact') or p_budget <= 0 then
    return 0;
  end if;
  if jsonb_typeof(p_auto.trigger_config -> 'days_overdue') = 'number'
     and (p_auto.trigger_config ->> 'days_overdue') ~ '^[0-9]{1,3}$'
     and (p_auto.trigger_config ->> 'days_overdue')::integer <= 365 then
    v_days := (p_auto.trigger_config ->> 'days_overdue')::integer;
  end if;
  select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = p_auto.organization_id;
  v_zone := coalesce(v_zone, 'Asia/Jerusalem');
  v_local := now() at time zone v_zone;
  if extract(hour from v_local) < app.date_trigger_hour() then
    return 0;
  end if;
  v_today := v_local::date;
  select c.after_id into v_after from app.scan_cursor_get(p_auto) c;
  <<pages>>
  loop
    v_page := 0;
    for v_row in
      select d.id, d.due_date, case when p_auto.entity_type = 'deal' then d.deal_id else d.contact_id end as record_id
        from public.accounting_documents d
       where d.organization_id = p_auto.organization_id and d.status = 'active'
         -- GAP-12: a positive opening balance is a debt like a tax invoice (a negative one has no balance and no due date)
         and d.doc_type in ('tax_invoice', 'proforma', 'opening_balance')
         and d.due_date is not null and d.due_date + v_days < v_today
         and (case when p_auto.entity_type = 'deal' then d.deal_id else d.contact_id end) is not null
         and d.id > v_after
         and not exists (select 1 from public.automation_runs r
                          where r.automation_id = p_auto.id and r.run_key = 'debt:' || d.id || ':' || d.due_date || ':' || v_days)
       order by d.id
       limit v_page_size
    loop
      v_page := v_page + 1;
      v_after := v_row.id;
      if app.document_balance(p_auto.organization_id, v_row.id) > 0 then
        v_key := 'debt:' || v_row.id || ':' || v_row.due_date || ':' || v_days;
        if app.execute_automation(p_auto, v_row.record_id, v_key) is not null then
          v_count := v_count + 1;
        end if;
        if v_count >= p_budget then
          perform app.scan_cursor_set(p_auto, '-infinity', v_after);
          exit pages;
        end if;
      end if;
    end loop;
    v_scanned := v_scanned + v_page;
    if v_page < v_page_size then
      -- the end of the list: the next pass starts again from the first document
      perform app.scan_cursor_set(p_auto, '-infinity', '00000000-0000-0000-0000-000000000000');
      exit;
    end if;
    if v_scanned >= v_limit then
      perform app.scan_cursor_set(p_auto, '-infinity', v_after);
      exit;
    end if;
  end loop;
  return v_count;
end;
$$;
revoke all on function app.scheduled_debt_overdue(public.automations, integer) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- BAL-01: the ledger (020895)
-- ----------------------------------------------------------------------------
-- GAP-12: a company's opening balance is a line of that company's ledger (and of its contacts' ledgers, PAY-02's customer);
-- the count below and the ledger take it the same way
create or replace function app.customer_money_rows(p_org uuid, p_contact uuid, p_company uuid)
returns bigint
language sql stable security definer
set search_path = ''
as $$
  with origin_companies as (
    select p_company as company_id where p_company is not null
    union
    select c.company_id from public.contacts c
     where c.organization_id = p_org and c.id = p_contact and c.company_id is not null
  ),
  same_contacts as (
    select p_contact as id where p_contact is not null
    union
    select c.id from public.contacts c where c.organization_id = p_org and c.company_id in (select company_id from origin_companies)
  ),
  same_deals as (
    select d.id from public.deals d where d.organization_id = p_org and d.company_id in (select company_id from origin_companies)
  )
  select case when app.can_record_payments(p_org) then
    (select count(*) from public.accounting_documents d
      where d.organization_id = p_org
        and (d.contact_id in (select id from same_contacts) or d.deal_id in (select id from same_deals)
             or d.company_id in (select company_id from origin_companies)))
    + (select count(*) from public.payments p
        where p.organization_id = p_org
          and (p.contact_id in (select id from same_contacts) or p.deal_id in (select id from same_deals)))
  end
$$;
revoke all on function app.customer_money_rows(uuid, uuid, uuid) from public, anon, authenticated, service_role;
-- customer_ledger is invoker, so the caller runs this
grant execute on function app.customer_money_rows(uuid, uuid, uuid) to authenticated;

create or replace function public.customer_ledger(p_org uuid, p_contact uuid, p_company uuid, p_from date, p_to date)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_out jsonb;
  v_partial boolean;
begin
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'a ledger needs a period' using errcode = '22023', hint = 'ledger:period';
  end if;
  if not app.can_record_payments(p_org)
     or not (app.org_has_feature(p_org, 'balances') and app.org_has_feature(p_org, 'documents')
             and app.org_has_feature(p_org, 'payments')) then
    return jsonb_build_object('allowed', false);
  end if;

  -- partial when the customer has a row the caller does not read (answer 3 ב): compare the full count with what RLS shows
  with origin_companies as (
    select p_company as company_id where p_company is not null
    union
    select c.company_id from public.contacts c
     where c.organization_id = p_org and c.id = p_contact and c.company_id is not null
  ),
  same_contacts as (
    select p_contact as id where p_contact is not null
    union
    select c.id from public.contacts c where c.organization_id = p_org and c.company_id in (select company_id from origin_companies)
  ),
  same_deals as (
    select d.id from public.deals d where d.organization_id = p_org and d.company_id in (select company_id from origin_companies)
  )
  select coalesce(app.customer_money_rows(p_org, p_contact, p_company), 0) >
         (select count(*) from public.accounting_documents d
           where d.organization_id = p_org
             and (d.contact_id in (select id from same_contacts) or d.deal_id in (select id from same_deals)
             or d.company_id in (select company_id from origin_companies)))
         + (select count(*) from public.payments p
             where p.organization_id = p_org
               and (p.contact_id in (select id from same_contacts) or p.deal_id in (select id from same_deals)))
    into v_partial;

  if v_partial then
    with origin_companies as (
      select p_company as company_id where p_company is not null
      union
      select c.company_id from public.contacts c
       where c.organization_id = p_org and c.id = p_contact and c.company_id is not null
    ),
    same_contacts as (
      select p_contact as id where p_contact is not null
      union
      select c.id from public.contacts c where c.organization_id = p_org and c.company_id in (select company_id from origin_companies)
    ),
    same_deals as (
      select d.id from public.deals d where d.organization_id = p_org and d.company_id in (select company_id from origin_companies)
    ),
    lines as (
      -- each line's own effect only (no balance), by the rule of the full view below; RLS decides which invoice or proforma
      -- the caller reads (an unread proforma is never netted out of an invoice, so its amount is never shown)
      select 'document'::text as kind, d.id, d.doc_date as on_date, d.created_at, d.doc_type as type, d.number as label,
             d.status, case when i.doc_date <= p_to then i.number end as invoice_number, f.number as proforma_number,
             case when d.status <> 'active' then 0
                  when d.doc_type = 'tax_invoice' then greatest(d.amount_agorot - coalesce(f.amount_agorot, 0), 0)
                  when d.doc_type = 'tax_invoice_receipt' then d.amount_agorot
                  -- GAP-12: an opening balance is a debit when positive, a credit when negative
                  when d.doc_type = 'opening_balance' then greatest(d.amount_agorot, 0)
                  -- billed by an invoice of this ledger dated before it: billed from its own date
                  when d.doc_type = 'proforma' then case when i.in_ledger and i.doc_date < d.doc_date then 0 else d.amount_agorot end
                  else 0 end::bigint as debit,
             case when d.status <> 'active' then 0
                  when d.doc_type in ('tax_invoice_receipt', 'credit_invoice') then d.amount_agorot
                  when d.doc_type = 'opening_balance' then greatest(-d.amount_agorot, 0)
                  when d.doc_type = 'tax_invoice' then greatest(coalesce(f.amount_agorot, 0) - d.amount_agorot, 0)
                  else 0 end::bigint as credit,
             d.amount_agorot as amount
        from public.accounting_documents d
        left join lateral (
          select v.number, v.doc_date,
                 (v.contact_id in (select id from same_contacts) or v.deal_id in (select id from same_deals)) is true as in_ledger
            from public.accounting_documents v
           where v.organization_id = p_org and v.proforma_id = d.id and v.status = 'active' and v.doc_type = 'tax_invoice'
             and d.doc_type = 'proforma' and d.status = 'active'
           order by v.doc_date, v.id limit 1) i on true
        left join lateral (
          -- only a proforma that is itself a line of this ledger, dated on or before the invoice
          select v.number, v.amount_agorot from public.accounting_documents v
           where v.organization_id = p_org and v.id = d.proforma_id and v.status = 'active' and v.doc_type = 'proforma'
             and v.doc_date <= d.doc_date
             and (v.contact_id in (select id from same_contacts) or v.deal_id in (select id from same_deals))
             and d.doc_type = 'tax_invoice' and d.status = 'active') f on true
       where d.organization_id = p_org
         and (d.contact_id in (select id from same_contacts) or d.deal_id in (select id from same_deals)
             or d.company_id in (select company_id from origin_companies))
      union all
      select 'payment'::text, p.id, p.paid_on, p.created_at, p.method, p.reference, p.status, null::text, null::text,
             0::bigint,
             case when p.status in ('recorded', 'confirmed') then p.amount_agorot else 0 end::bigint,
             p.amount_agorot
        from public.payments p
       where p.organization_id = p_org
         and (p.contact_id in (select id from same_contacts) or p.deal_id in (select id from same_deals))
    ),
    period as (
      select l.*, row_number() over (order by l.on_date desc, l.created_at desc, l.id desc) as from_end
        from lines l
       where l.on_date between p_from and p_to
    )
    select jsonb_build_object(
      'allowed', true,
      'partial', true,
      'from', p_from,
      'to', p_to,
      'truncated', exists (select 1 from period where from_end > 500),
      'lines', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'kind', s.kind, 'id', s.id, 'date', s.on_date, 'type', s.type, 'label', s.label, 'status', s.status,
                 'invoice_number', s.invoice_number, 'proforma_number', s.proforma_number, 'amount', s.amount, 'debit', s.debit, 'credit', s.credit)
                 order by s.on_date, s.created_at, s.id)
          from period s where s.from_end <= 500), '[]'::jsonb)
    ) into v_out;
    return v_out;
  end if;

  with origin_companies as (
    select p_company as company_id where p_company is not null
    union
    select c.company_id from public.contacts c
     where c.organization_id = p_org and c.id = p_contact and c.company_id is not null
  ),
  same_contacts as (
    select p_contact as id where p_contact is not null
    union
    select c.id from public.contacts c where c.organization_id = p_org and c.company_id in (select company_id from origin_companies)
  ),
  same_deals as (
    select d.id from public.deals d where d.organization_id = p_org and d.company_id in (select company_id from origin_companies)
  ),
  docs as (
    select d.id, d.doc_type, d.number, d.doc_date, d.created_at, d.amount_agorot, d.status, d.proforma_id
      from public.accounting_documents d
     where d.organization_id = p_org
       and (d.contact_id in (select id from same_contacts) or d.deal_id in (select id from same_deals)
             or d.company_id in (select company_id from origin_companies))
  ),
  doc_state as (
    select (x ->> 'id')::uuid as id, x ->> 'state' as state, x ->> 'invoice_number' as invoice_number,
           coalesce((x ->> 'balance')::bigint, 0) as balance
      from jsonb_array_elements(public.money_allocation_state(p_org, (select coalesce(array_agg(id), '{}') from docs), '{}')
                                 -> 'documents') x
  ),
  pays as (
    select p.id, p.method, p.reference, p.paid_on, p.created_at, p.amount_agorot, p.status, public.payment_credit(p) as credit
      from public.payments p
     where p.organization_id = p_org
       and (p.contact_id in (select id from same_contacts) or p.deal_id in (select id from same_deals))
  ),
  lines as (
    -- a proforma is a debit on its own date; the active tax invoice that bills it takes over from the invoice's date: the
    -- invoice's line carries only the difference (BAL-01, lead's decision of 26 October 2026), so a period that ends before
    -- the invoice shows the debt as it stood then, and a later one the invoice's amount once
    select 'document'::text as kind, d.id, d.doc_date as on_date, d.created_at, d.doc_type as type, d.number as label,
           d.status, case when i.doc_date <= p_to then i.number end as invoice_number, f.number as proforma_number,
           case when d.status <> 'active' then 0
                when d.doc_type = 'tax_invoice' then greatest(d.amount_agorot - coalesce(f.amount_agorot, 0), 0)
                when d.doc_type = 'tax_invoice_receipt' then d.amount_agorot
                -- GAP-12: an opening balance is a debit when positive, a credit when negative
                when d.doc_type = 'opening_balance' then greatest(d.amount_agorot, 0)
                -- billed by an invoice of this ledger dated before it: billed from its own date
                when d.doc_type = 'proforma' then case when i.in_ledger and i.doc_date < d.doc_date then 0 else d.amount_agorot end
                else 0 end::bigint as debit,
           case when d.status <> 'active' then 0
                when d.doc_type in ('tax_invoice_receipt', 'credit_invoice') then d.amount_agorot
                when d.doc_type = 'opening_balance' then greatest(-d.amount_agorot, 0)
                when d.doc_type = 'tax_invoice' then greatest(coalesce(f.amount_agorot, 0) - d.amount_agorot, 0)
                else 0 end::bigint as credit,
           d.amount_agorot as amount
      from docs d
      left join lateral (
        select v.number, v.doc_date, v.id in (select x.id from docs x) as in_ledger
          from public.accounting_documents v
         where v.organization_id = p_org and v.proforma_id = d.id and v.status = 'active' and v.doc_type = 'tax_invoice'
           and d.doc_type = 'proforma' and d.status = 'active'
         order by v.doc_date, v.id limit 1) i on true
      left join lateral (
        -- only a proforma that is itself a line of this ledger, dated on or before the invoice
        select v.number, v.amount_agorot from docs v
         where v.id = d.proforma_id and v.status = 'active' and v.doc_type = 'proforma' and v.doc_date <= d.doc_date
           and d.doc_type = 'tax_invoice' and d.status = 'active') f on true
    union all
    select 'payment'::text, p.id, p.paid_on, p.created_at, p.method, p.reference, p.status, null::text, null::text,
           0::bigint,
           case when p.status in ('recorded', 'confirmed') then p.amount_agorot else 0 end::bigint,
           p.amount_agorot
      from pays p
  ),
  opening as (
    select coalesce(sum(l.debit - l.credit), 0)::bigint as v from lines l where l.on_date < p_from
  ),
  period as (
    select l.*,
           (select v from opening) + sum(l.debit - l.credit) over (order by l.on_date, l.created_at, l.id
                                                               rows between unbounded preceding and current row) as balance,
           row_number() over (order by l.on_date desc, l.created_at desc, l.id desc) as from_end
      from lines l
     where l.on_date between p_from and p_to
  ),
  shown as (
    select * from period where from_end <= 500
  )
  select jsonb_build_object(
    'allowed', true,
    'partial', false,
    'from', p_from,
    'to', p_to,
    'opening', (select v from opening),
    'shown_opening', coalesce((select s.balance - (s.debit - s.credit) from shown s order by s.from_end desc limit 1),
                              (select v from opening)),
    'truncated', exists (select 1 from period where from_end > 500),
    'debit', coalesce((select sum(debit) from period), 0)::bigint,
    'credit', coalesce((select sum(credit) from period), 0)::bigint,
    'closing', (select v from opening) + coalesce((select sum(debit - credit) from period), 0)::bigint,
    'open_debt', coalesce((select sum(s.balance) from doc_state s), 0)::bigint,
    'credit_balance', coalesce((select sum(p.credit) from pays p), 0)::bigint,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'kind', s.kind, 'id', s.id, 'date', s.on_date, 'type', s.type, 'label', s.label, 'status', s.status,
               'invoice_number', s.invoice_number, 'proforma_number', s.proforma_number, 'amount', s.amount, 'debit', s.debit, 'credit', s.credit,
               'balance', s.balance) order by s.on_date, s.created_at, s.id)
        from shown s), '[]'::jsonb)
  ) into v_out;
  return v_out;
end;
$$;
revoke all on function public.customer_ledger(uuid, uuid, uuid, date, date) from public, anon;
grant execute on function public.customer_ledger(uuid, uuid, uuid, date, date) to authenticated;

-- ----------------------------------------------------------------------------
-- DOC-04: the timeline (020750)
-- ----------------------------------------------------------------------------
create or replace function app.document_type_label(p_type text) returns text
language sql immutable
set search_path = ''
as $$
  select case p_type
           when 'tax_invoice' then 'חשבונית מס'
           when 'tax_invoice_receipt' then 'חשבונית מס/קבלה'
           when 'receipt' then 'קבלה'
           when 'credit_invoice' then 'חשבונית זיכוי'
           when 'proforma' then 'חשבונית עסקה'
           when 'opening_balance' then 'יתרת פתיחה'
           else 'מסמך' end
$$;
revoke all on function app.document_type_label(text) from public, anon, authenticated, service_role;

create or replace function app.accounting_documents_timeline() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  -- GAP-12: an opening balance has no number; it is named by its date ("יתרת פתיחה מתאריך 01.01.2026")
  v_name text := app.document_type_label(new.doc_type) || ' '
                 || case when new.doc_type = 'opening_balance' then 'מתאריך ' || to_char(new.doc_date, 'DD.MM.YYYY')
                         else new.number end;
begin
  -- GAP-12: a company's opening balance goes on the company's timeline
  if new.deal_id is null and new.contact_id is null and new.company_id is null then
    return null;
  end if;
  if tg_op = 'INSERT' then
    insert into public.activities (organization_id, type, deal_id, contact_id, company_id, body, metadata)
    values (new.organization_id, 'system', new.deal_id, new.contact_id, new.company_id, 'נרשם מסמך: ' || v_name,
            jsonb_build_object('kind', 'document_recorded', 'document_id', new.id, 'doc_type', new.doc_type, 'number', new.number));
  elsif new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    insert into public.activities (organization_id, type, deal_id, contact_id, company_id, body, metadata)
    values (new.organization_id, 'system', new.deal_id, new.contact_id, new.company_id,
            'בוטל מסמך: ' || v_name || coalesce(' · סיבה: ' || new.cancel_reason, ''),
            jsonb_build_object('kind', 'document_cancelled', 'document_id', new.id, 'doc_type', new.doc_type, 'number', new.number));
  end if;
  return null;
end;
$$;
revoke all on function app.accounting_documents_timeline() from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- LST-09: an export's audit filters (020690)
-- ----------------------------------------------------------------------------
create or replace function app.export_choice_values() returns text[]
language sql immutable
set search_path = ''
as $$
  select array[
    -- deal status, task status
    'open', 'won', 'lost', 'done', 'cancelled',
    -- task type
    'todo', 'call', 'meeting', 'follow_up',
    -- task priority
    '1', '2', '3',
    -- company industry
    'services', 'real_estate', 'insurance_finance', 'construction', 'retail', 'health',
    'education', 'marketing', 'technology', 'tourism_events', 'nonprofit', 'other',
    -- CON-10: contact preferred language
    'he', 'ar', 'en', 'ru', 'am', 'fr', 'es',
    -- CON-10: contact preferred channel
    'phone', 'whatsapp', 'email', 'sms',
    -- LST-09: product kind, VAT kind and billing
    'product', 'service', 'subscription', 'bundle',
    'taxable', 'exempt', 'zero_rate',
    'one_time', 'monthly', 'quarterly', 'yearly',
    -- LST-09: quote status codes ('cancelled' is above)
    'draft', 'sent', 'viewed', 'accepted', 'rejected', 'expired',
    -- LST-09: accounting document types and status ('cancelled' is above)
    'tax_invoice', 'tax_invoice_receipt', 'receipt', 'credit_invoice', 'proforma', 'active',
    -- GAP-12: the opening balance
    'opening_balance',
    -- LST-09: payment methods ('other' is above) and statuses ('cancelled' is above)
    'credit', 'transfer', 'cash', 'cheque', 'bit_paybox', 'standing_order',
    'recorded', 'confirmed', 'failed', 'refunded'
  ];
$$;

revoke all on function app.export_choice_values() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Owner's answer (3) ב: recording or replacing a customer's opening balance (owners and admins; the import and the card)
-- ----------------------------------------------------------------------------
-- public.opening_balance_set(org, contact | company, amount, date, due date, import job): one call that cancels every active
-- opening balance of that customer (reason "הוחלפה בייבוא" from an import, "הוחלפה ביתרה חדשה" otherwise; the cancel and
-- the new row are audited by app.audit_row, and the cancel releases the old one's allocations as any cancel does) and records
-- the new one, in one transaction, under the customer's lock (the same lock the insert trigger takes). Definer: the caller
-- must be an owner or admin of a writable business with the `documents` key; the customer must be live in that business.
-- An import job, when named, must be the caller's own running contacts or companies job (hint document:opening_job).
-- Answers the new document's id. Answer (4) ג: no due date unless one is given.
create or replace function public.opening_balance_set(p_org uuid, p_contact uuid, p_company uuid, p_amount bigint, p_date date,
                                                      p_due date default null, p_job uuid default null)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_id uuid;
begin
  if not (app.is_admin(p_org) and app.org_writable(p_org)) then
    raise exception 'only owners and admins record an opening balance' using errcode = '42501', hint = 'document:opening_admin';
  end if;
  if not app.org_has_feature(p_org, 'documents') then
    raise exception 'documents are not in the plan' using errcode = 'P0001', hint = 'feature:documents';
  end if;
  if (p_contact is null) = (p_company is null) then
    raise exception 'an opening balance is a contact''s or a company''s' using errcode = '22023', hint = 'document:parent';
  end if;
  if p_amount is null or p_amount = 0 or abs(p_amount) > 1000000000000 or p_date is null then
    raise exception 'an opening balance is a debt or a credit, on a day' using errcode = '22023', hint = 'document:opening_amount';
  end if;
  if (p_contact is not null and not exists (select 1 from public.contacts c
                                             where c.organization_id = p_org and c.id = p_contact and c.deleted_at is null))
     or (p_company is not null and not exists (select 1 from public.companies co
                                                where co.organization_id = p_org and co.id = p_company and co.deleted_at is null)) then
    raise exception 'the customer is not in this business' using errcode = 'P0001', hint = 'document:parent';
  end if;
  if p_job is not null and not exists (
       select 1 from public.import_jobs j
        where j.organization_id = p_org and j.id = p_job and j.created_by = auth.uid() and j.status = 'running'
          and j.entity_type = case when p_contact is not null then 'contact' else 'company' end) then
    raise exception 'not your running import of this kind' using errcode = 'P0001', hint = 'document:opening_job';
  end if;
  v_reason := case when p_job is not null then 'הוחלפה בייבוא' else 'הוחלפה ביתרה חדשה' end;

  perform pg_advisory_xact_lock(hashtextextended('opening_balance:' || p_org::text || ':' || coalesce(p_contact, p_company)::text, 0));
  update public.accounting_documents a
     set status = 'cancelled', cancel_reason = v_reason
   where a.organization_id = p_org and a.doc_type = 'opening_balance' and a.status = 'active'
     and ((p_contact is not null and a.contact_id = p_contact) or (p_company is not null and a.company_id = p_company));
  insert into public.accounting_documents (organization_id, contact_id, company_id, doc_type, number, doc_date, amount_agorot, due_date,
                                           import_job_id)
  values (p_org, p_contact, p_company, 'opening_balance', null, p_date, p_amount, p_due, p_job)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.opening_balance_set(uuid, uuid, uuid, bigint, date, date, uuid) from public, anon;
grant execute on function public.opening_balance_set(uuid, uuid, uuid, bigint, date, date, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- A company merge moves the duplicate company's opening balances to the kept company, through the `merged` timeline entry
-- (as DOC-01 did for contacts until app.merge_move_links took it over; merge_move_links is shared ground and is not
-- changed here). The kept company may then hold two active ones; both count, and the next replace cancels both.
-- ----------------------------------------------------------------------------
create or replace function app.merge_company_opening_balances() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_merged uuid;
  v_server text;
begin
  if (new.metadata ->> 'merged_id') !~ '^[0-9a-fA-F-]{36}$' then
    return null;
  end if;
  v_merged := (new.metadata ->> 'merged_id')::uuid;
  if new.company_id is not null and v_merged <> new.company_id
     and exists (select 1 from public.companies c where c.organization_id = new.organization_id and c.id = new.company_id) then
    v_server := current_setting('app.document_server', true);
    perform set_config('app.document_server', 'on', true);
    update public.accounting_documents a set company_id = new.company_id
     where a.organization_id = new.organization_id and a.company_id = v_merged;
    perform set_config('app.document_server', coalesce(v_server, ''), true);
  end if;
  return null;
end;
$$;
revoke all on function app.merge_company_opening_balances() from public, anon, authenticated, service_role;

create or replace trigger activities_merge_company_opening_balances after insert on public.activities
  for each row
  when (new.type = 'system' and new.company_id is not null and new.metadata ? 'merged_id')
  execute function app.merge_company_opening_balances();

-- ----------------------------------------------------------------------------
-- Privacy erasure of a company reaches its opening balances. SHARED GROUND: app.audit_erase_core is copied exactly from its
-- latest body (021030, consent_blocklist_note) with ONE change, marked GAP-12: the DOC-01 block runs for 'companies' too
-- (it finds the documents through their audit entries by company_id, neutralises a cancel reason and erases the entries).
-- ----------------------------------------------------------------------------
create or replace function app.audit_erase_core(p_org uuid, p_type text, p_id uuid, p_actor uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $$
declare
  v_col text := case p_type when 'leads' then 'lead_id' when 'contacts' then 'contact_id'
                            when 'companies' then 'company_id' when 'deals' then 'deal_id' end;
  v_exists boolean;
  v_row jsonb;
  v_child record;
  v_children text[] := '{}';
  v_count integer;
  v_more integer;
  -- RVW-45: the deals that were the contact's when it was purged
  v_deals uuid[] := '{}';
  v_payments uuid[] := '{}';
  -- CNS-06 answer 4: blocklist notes emptied
  v_notes integer := 0;
begin
  if v_col is null then
    raise exception 'unknown record type' using errcode = '22023';
  end if;
  execute format('select exists (select 1 from public.%I where organization_id = $1 and id = $2)', p_type)
    into v_exists using p_org, p_id;
  if v_exists then
    raise exception 'delete the record permanently first' using errcode = 'P0001', hint = 'erase:exists';
  end if;

  -- the deleted row, for the form submissions below (before it is erased)
  select a.changes into v_row from public.audit_log a
   where a.organization_id = p_org and a.entity_type = p_type and a.entity_id = p_id and a.action = 'delete'
   order by a.id desc limit 1;

  -- CNS-06 answer 4: the notes of blocklist entries of the person's addresses are emptied, while the record's audit
  -- entries still hold its addresses (they are erased below)
  if p_type in ('leads', 'contacts') then
    v_notes := app.consent_blocklist_erase_notes(p_org, p_type, p_id, v_row);
  end if;

  -- tasks, files, notes and deal lines (DLI-01) that were linked to it and no longer exist: by the
  -- ids in their entries, and for notes by every record they were ever linked to
  for v_child in
    select distinct a.entity_type, a.entity_id from public.audit_log a
     where a.organization_id = p_org and a.entity_type in ('tasks', 'files', 'activities', 'deal_lines', 'quotes', 'orders', 'accounting_documents', 'payments', 'customer_holds') and a.entity_id is not null
       and (a.changes ->> v_col = p_id::text or a.changes -> v_col ->> 'old' = p_id::text or a.changes -> v_col ->> 'new' = p_id::text)
    union
    select 'activities', l.activity_id from app.activity_audit_links l
     where l.organization_id = p_org and l.record_id = p_id
  loop
    execute format('select exists (select 1 from public.%I where organization_id = $1 and id = $2)', v_child.entity_type)
      into v_exists using p_org, v_child.entity_id;
    if not v_exists then
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end if;
  end loop;

  -- QUO-01: the lines of those quotes (their entries carry quote_id, not the record's id); GAP-09: and their payment schedule
  for v_child in
    select distinct a.entity_type, a.entity_id from public.audit_log a
     where a.organization_id = p_org and a.entity_type in ('quote_lines', 'quote_payment_steps') and a.entity_id is not null
       and coalesce(a.changes ->> 'quote_id', a.changes -> 'quote_id' ->> 'old') = any (
             select substr(c, length('quotes:') + 1) from unnest(v_children) c where c like 'quotes:%')
  loop
    execute format('select exists (select 1 from public.%I where organization_id = $1 and id = $2)', v_child.entity_type)
      into v_exists using p_org, v_child.entity_id;
    if not v_exists then
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end if;
  end loop;

  -- QUO-07: a sent quote that was detached from the record keeps its number, date and amounts; its
  -- personal details are emptied, and its own entries are erased below with the rest. A draft that
  -- only named the record (a deal's quote naming a purged contact) is the deal's and is left alone.
  if p_type in ('contacts', 'deals') then
    for v_child in
      update public.quotes q
         set customer_name = null, customer_contact_name = null, notes = null, title = 'הצעת מחיר',
             -- QUO-11: the reason staff wrote when cancelling an accepted quote may name the customer
             cancel_reason = null
       where q.organization_id = p_org and q.status <> 'draft'
         and ((p_type = 'contacts' and q.former_contact_id = p_id) or (p_type = 'deals' and q.former_deal_id = p_id))
      returning 'quotes'::text as entity_type, q.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    -- owner, 18 October 2026 (QUO-07): the free text of those quotes' lines goes too: quantity, price and amounts stay;
    -- a free line and a group heading get a neutral name; every description is emptied. Owner, 19 October 2026: a
    -- product line's name that was edited by hand goes too. "Edited by hand" in the data = the stored name differs
    -- (trimmed) from the product's current catalog name; such a line takes the catalog name (not personal), and a
    -- product that is gone leaves the neutral name. A product line still named as in the catalog keeps it. Payment
    -- steps, milestones and terms stay (owner). These lines' entries (the old text included) are erased below.
    for v_child in
      update public.quote_lines l
         set description = null,
             name = case
                      when l.kind = 'group' then 'קבוצה'
                      when l.product_id is null then 'שורה'
                      else coalesce((select p.name from public.products p
                                      where p.organization_id = l.organization_id and p.id = l.product_id), 'שורה')
                    end
       where l.organization_id = p_org
         and l.quote_id = any (select substr(c, length('quotes:') + 1)::uuid from unnest(v_children) c where c like 'quotes:%')
         and exists (select 1 from public.quotes q where q.organization_id = p_org and q.id = l.quote_id and q.status <> 'draft')
      returning 'quote_lines'::text as entity_type, l.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    -- QUO-11: the cancel entry of those quotes on the timeline loses its " · סיבה: …" part (the rest is number and author);
    -- the entries' audit history (the old body included) is erased below with the rest
    for v_child in
      update public.activities ac
         set body = regexp_replace(ac.body, ' · סיבה: .*$', '')
       where ac.organization_id = p_org and ac.metadata ->> 'kind' = 'quote_cancelled'
         and ac.metadata ->> 'quote_id' = any (select substr(c, length('quotes:') + 1) from unnest(v_children) c where c like 'quotes:%')
         and ac.body like '% · סיבה: %'
      returning 'activities'::text as entity_type, ac.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    -- QUO-09 (owner, 18 October 2026): the customer's decision on those quotes keeps what, when and the fingerprint of the
    -- version; the signer's name, ID, signature, IP, browser and reason go (the table is not audited)
    update public.quote_decisions d
       set signer_name = null, signer_id_number = null, signature_image = null, ip = null, user_agent = null,
           decline_reason = null, erased_at = coalesce(d.erased_at, now())
     where d.organization_id = p_org
       and d.quote_id = any (select substr(c, length('quotes:') + 1)::uuid from unnest(v_children) c where c like 'quotes:%');
    -- RVW-42: the notices about those quotes: the title (it may name the customer) becomes "הצעת מחיר" after the notice's own
    -- words, the cancel reason leaves the body, and a "viewed" notice's body (the quote's title) is emptied
    update public.notifications n
       set title = case when n.type = 'quote' and n.title like '%: %'
                        then left(n.title, strpos(n.title, ': ') + 1) || 'הצעת מחיר' else n.title end,
           body = case when n.type = 'quote_viewed' then null
                       else nullif(regexp_replace(n.body, '( · )?סיבה: .*$', ''), '') end
     where n.organization_id = p_org and n.entity_type = 'quote'
       and n.entity_id = any (select substr(c, length('quotes:') + 1)::uuid from unnest(v_children) c where c like 'quotes:%')
       and (n.type = 'quote_viewed' or (n.type = 'quote' and (n.title like '%: %' or n.body like '%סיבה: %')));
    -- QUO-06 (review H1, lead's choice until the owner answers): the stored PDF of those quotes holds the customer's name,
    -- details, notes and line texts, so it goes; its object follows through the orphan cleanup (app.orphan_files)
    perform app.quote_pdf_drop(p_org, array(select substr(c, length('quotes:') + 1)::uuid from unnest(v_children) c where c like 'quotes:%'));
  end if;

  -- ORD-01: an order that was detached from the record keeps its number, date, lines' amounts and totals; the customer's
  -- name, the shipping address and the notes go, and its lines' free text goes as for quotes (a product line takes the
  -- catalog name, a free line and a heading a neutral one, every description is emptied). A draft only loses the
  -- shipping address and the name it may have copied from the record. Its entries are erased below with the rest.
  if p_type in ('contacts', 'companies', 'deals') then
    perform set_config('app.order_server', 'on', true);
    for v_child in
      update public.orders o
         set customer_name = case when o.status <> 'draft' then null else o.customer_name end,
             shipping_address = null,
             notes = case when o.status <> 'draft' then null else o.notes end
       where o.organization_id = p_org
         and ((p_type = 'contacts' and o.former_contact_id = p_id) or (p_type = 'deals' and o.former_deal_id = p_id)
              or (p_type = 'companies' and o.former_company_id = p_id))
      returning 'orders'::text as entity_type, o.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    -- ORD-05: the customer's answer on those orders keeps what, when and the fingerprint of what was shown; the signer's
    -- name, ID, signature, IP, browser and reason go (the table is not audited), as for quotes (QUO-09)
    update public.order_decisions d
       set signer_name = null, signer_id_number = null, signature_image = null, ip = null, user_agent = null,
           decline_reason = null, erased_at = coalesce(d.erased_at, now())
     where d.organization_id = p_org
       and d.order_id = any (select substr(c, length('orders:') + 1)::uuid from unnest(v_children) c where c like 'orders:%');
    -- ORD-05b: the customer's decline reason goes from the timeline entry (its audit history is erased below) and from the notices
    for v_child in
      update public.activities ac
         set body = regexp_replace(ac.body, ' · סיבה: .*$', '')
       where ac.organization_id = p_org and ac.metadata ->> 'kind' = 'order_answer_rejected'
         and ac.metadata ->> 'order_id' = any (select substr(c, length('orders:') + 1) from unnest(v_children) c where c like 'orders:%')
         and ac.body like '% · סיבה: %'
      returning 'activities'::text as entity_type, ac.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    update public.notifications n
       set body = nullif(regexp_replace(n.body, '( · )?סיבה: .*$', ''), '')
     where n.organization_id = p_org and n.entity_type = 'order'
       and n.entity_id = any (select substr(c, length('orders:') + 1)::uuid from unnest(v_children) c where c like 'orders:%')
       and n.body like '%סיבה: %';
    for v_child in
      update public.order_lines l
         set description = null,
             name = case
                      when l.kind = 'group' then 'קבוצה'
                      when l.product_id is null then 'שורה'
                      else coalesce((select p.name from public.products p
                                      where p.organization_id = l.organization_id and p.id = l.product_id), 'שורה')
                    end
       where l.organization_id = p_org
         and l.order_id = any (select substr(c, length('orders:') + 1)::uuid from unnest(v_children) c where c like 'orders:%')
         and exists (select 1 from public.orders o where o.organization_id = p_org and o.id = l.order_id and o.status <> 'draft')
      returning 'order_lines'::text as entity_type, l.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    perform set_config('app.order_server', '', true);
  end if;
  -- DOC-01: a document that was ever on the record (by its entries, within the business) keeps its type, number, date, amount
  -- and state; a cancel reason (staff may have named the customer) becomes a neutral text; its entries are erased below
  -- RVW-45: a contact's deals at its purge, by the FK set-null entry on each deal (contact_id {old: <contact>, new: null})
  if p_type = 'contacts' then
    select coalesce(array_agg(distinct a.entity_id), '{}') into v_deals
      from public.audit_log a
     where a.organization_id = p_org and a.entity_type = 'deals' and a.action = 'update' and a.entity_id is not null
       and a.changes -> 'contact_id' ->> 'old' = p_id::text and a.changes -> 'contact_id' ->> 'new' is null;
  end if;
  -- GAP-12: and a company's opening balances (the only document a company carries)
  if p_type in ('contacts', 'deals', 'companies') then
    for v_child in
      select 'accounting_documents'::text as entity_type, d.id as entity_id
        from public.accounting_documents d
       where d.organization_id = p_org
         and d.id in (select a.entity_id from public.audit_log a
                       where a.organization_id = p_org and a.entity_type = 'accounting_documents' and a.entity_id is not null
                         and (a.changes ->> v_col = p_id::text or a.changes -> v_col ->> 'old' = p_id::text
                              or a.changes -> v_col ->> 'new' = p_id::text))
       union
       -- RVW-45: recorded on such a deal without a contact
       select 'accounting_documents'::text, d.id
         from public.accounting_documents d
        where d.organization_id = p_org and d.contact_id is null and d.deal_id = any (v_deals)
          -- recorded while the deal was still the contact's: not after an unlink of the contact from that deal
          and exists (select 1 from public.audit_log u
                        where u.organization_id = p_org and u.entity_type = 'deals' and u.entity_id = d.deal_id
                          and u.action = 'update' and u.changes -> 'contact_id' ->> 'old' = p_id::text
                          and u.changes -> 'contact_id' ->> 'new' is null and u.created_at >= d.created_at)
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    perform set_config('app.document_server', 'erase', true);
    update public.accounting_documents d
       set cancel_reason = 'הסיבה נמחקה (מחיקת פרטיות)'
     where d.organization_id = p_org and d.status = 'cancelled'
       and d.cancel_reason is distinct from 'הסיבה נמחקה (מחיקת פרטיות)'
       and ('accounting_documents:' || d.id) = any (v_children);
    perform set_config('app.document_server', '', true);
  end if;
  -- PAY-01: a payment that was ever on the record (by its entries, within the business) keeps its amount, date, method and
  -- status; its reference and note go, a cancel reason becomes the neutral text, and its entries are erased below.
  if p_type in ('contacts', 'deals') then
    perform set_config('app.payment_server', 'erase', true);
    select coalesce(array_agg(pm.id), '{}') into v_payments
      from public.payments pm
     where pm.organization_id = p_org
       and pm.id in (select a.entity_id from public.audit_log a
                        where a.organization_id = p_org and a.entity_type = 'payments' and a.entity_id is not null
                          and (a.changes ->> v_col = p_id::text or a.changes -> v_col ->> 'old' = p_id::text
                               or a.changes -> v_col ->> 'new' = p_id::text)
                         union
                         -- RVW-45: recorded on such a deal without a contact
                         select p2.id from public.payments p2
                          where p2.organization_id = p_org and p2.contact_id is null and p2.deal_id = any (v_deals)
                            -- recorded while the deal was still the contact's (as for documents above)
                            and exists (select 1 from public.audit_log u
                                         where u.organization_id = p_org and u.entity_type = 'deals' and u.entity_id = p2.deal_id
                                           and u.action = 'update' and u.changes -> 'contact_id' ->> 'old' = p_id::text
                                           and u.changes -> 'contact_id' ->> 'new' is null and u.created_at >= p2.created_at));
    -- PAY-04: the cheque's due-date reminders lose its number (matched by the stored text, before the number is emptied)
    update public.notifications n
       set body = 'צ''ק · ' || app.payment_amount_text(pm.amount_agorot)
      from public.payments pm
     where pm.organization_id = p_org and pm.id = any (v_payments) and pm.cheque_number is not null
       and n.organization_id = p_org and n.type = 'payment' and n.title = 'צ''ק לפירעון היום'
       and ((n.entity_type = 'deal' and n.entity_id = pm.deal_id) or (n.entity_type = 'contact' and n.entity_id = pm.contact_id))
       and n.body = 'צ''ק ' || pm.cheque_number || ' · ' || app.payment_amount_text(pm.amount_agorot);
    for v_child in
      update public.payments pm
         set reference = null, note = null,
             -- PAY-04: the cheque's number, a foreign bank's name and the unbounce reason go too
             cheque_number = null, cheque_bank_name = null, cheque_unbounce_reason = null,
             cancel_reason = case when pm.status = 'cancelled' then 'הסיבה נמחקה (מחיקת פרטיות)' end
       where pm.organization_id = p_org and pm.id = any (v_payments)
      returning 'payments'::text as entity_type, pm.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    perform set_config('app.payment_server', '', true);
  end if;
  -- DOC-04: the cancel reason goes from the timeline entries of those documents and payments (their audit history is erased
  -- below with the rest)
  for v_child in
    update public.activities ac
       set body = regexp_replace(ac.body, ' · סיבה: .*$', '')
     where ac.organization_id = p_org and ac.type = 'system'
       and ((ac.metadata ->> 'kind' = 'document_cancelled'
             and ('accounting_documents:' || (ac.metadata ->> 'document_id')) = any (v_children))
            or (ac.metadata ->> 'kind' = 'payment_cancelled'
             and ('payments:' || (ac.metadata ->> 'payment_id')) = any (v_children)))
       and ac.body like '% · סיבה: %'
    returning 'activities'::text as entity_type, ac.id as entity_id
  loop
    v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
  end loop;
  -- the lines of those orders (kept or gone) that are gone themselves: their entries carry order_id; ORD-04: and their
  -- payment steps, as for quotes (the steps of a kept order stay, like a quote's)
  for v_child in
    select distinct a.entity_type, a.entity_id from public.audit_log a
     where a.organization_id = p_org and a.entity_type in ('order_lines', 'order_payment_steps') and a.entity_id is not null
       and coalesce(a.changes ->> 'order_id', a.changes -> 'order_id' ->> 'old') = any (
             select substr(c, length('orders:') + 1) from unnest(v_children) c where c like 'orders:%')
  loop
    execute format('select exists (select 1 from public.%I where organization_id = $1 and id = $2)', v_child.entity_type)
      into v_exists using p_org, v_child.entity_id;
    if not v_exists then
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end if;
  end loop;

  -- the files of those documents and payments, kept or gone: a file's name may carry the customer's name. The file and its
  -- object stay with the document or payment (a business record); every entry of it is erased. A kept file is found by its
  -- row; a removed one by its delete entry, which holds the row (an insert's entry holds no values)
  for v_child in
    select f.id as entity_id from public.files f
     where f.organization_id = p_org
       and (f.accounting_document_id::text = any (
              select substr(c, length('accounting_documents:') + 1) from unnest(v_children) c where c like 'accounting_documents:%')
            or f.payment_id::text = any (
              select substr(c, length('payments:') + 1) from unnest(v_children) c where c like 'payments:%'))
    union
    select a.entity_id from public.audit_log a
     where a.organization_id = p_org and a.entity_type = 'files' and a.entity_id is not null
       and (coalesce(a.changes ->> 'accounting_document_id', a.changes -> 'accounting_document_id' ->> 'old') = any (
              select substr(c, length('accounting_documents:') + 1) from unnest(v_children) c where c like 'accounting_documents:%')
            or coalesce(a.changes ->> 'payment_id', a.changes -> 'payment_id' ->> 'old') = any (
              select substr(c, length('payments:') + 1) from unnest(v_children) c where c like 'payments:%'))
  loop
    v_children := v_children || ('files:' || v_child.entity_id);
  end loop;
  -- their names too (review of 020640, low 2): a name such as "חשבונית מיכל לוי.pdf" becomes "מסמך <number>.pdf" or
  -- "תשלום <date>.pdf". The file and its object stay (a tax document); the extension is kept, the name was never a fact
  update public.files f
     set name = case when f.accounting_document_id is not null
                     then 'מסמך ' || coalesce((select d.number from public.accounting_documents d
                                                where d.organization_id = f.organization_id and d.id = f.accounting_document_id), '')
                     else 'תשלום ' || coalesce((select to_char(pm.paid_on, 'YYYY-MM-DD') from public.payments pm
                                                 where pm.organization_id = f.organization_id and pm.id = f.payment_id), '')
                end || coalesce(lower(substring(f.name from '(\.[A-Za-z0-9]{1,8})$')), '')
   where f.organization_id = p_org
     and ('files:' || f.id) = any (v_children)
     and (f.accounting_document_id is not null or f.payment_id is not null);

  update public.audit_log a set changes = '{"erased": true}'::jsonb
   where a.organization_id = p_org
     and ((a.entity_type = p_type and a.entity_id = p_id) or (a.entity_type || ':' || a.entity_id) = any (v_children))
     and a.action <> 'erase'
     and a.changes is distinct from '{"erased": true}'::jsonb;
  get diagnostics v_count = row_count;

  -- the copy kept by a merge, on the record it was merged into
  update public.activities ac
     set metadata = ac.metadata - 'merged', body = 'מוזג עם רשומה כפולה (הפרטים נמחקו)'
   where ac.organization_id = p_org and ac.metadata ->> 'merged_id' = p_id::text and ac.metadata ? 'merged';
  get diagnostics v_more = row_count;
  v_count := v_count + v_more;

  v_count := v_count + app.erase_submissions(p_org, v_row);

  -- CNS-02: its consent history keeps only the hash, the state and the time
  if p_type in ('leads', 'contacts') then
    update public.consents c set method = null, wording = null, recorded_by = null, lift_note = null
     where c.organization_id = p_org
       and c.subject_type = case p_type when 'leads' then 'lead' else 'contact' end
       and c.subject_id = p_id
       and (c.method is not null or c.wording is not null or c.recorded_by is not null or c.lift_note is not null);
    get diagnostics v_more = row_count;
    v_count := v_count + v_more;
    -- an entry still waiting for its hash (written without the key): with the key there,
    -- it gets its hash first, so the opt-out keeps working; then the stored address is
    -- blanked. Without the key it stays unmatchable and keeps app.consent_suppressed() at
    -- "cannot check" for its channel (fail closed).
    if app.consent_key_present() then
      update public.consents c set address_hash = app.consent_pending_hash(c.id)
       where c.organization_id = p_org
         and c.subject_type = case p_type when 'leads' then 'lead' else 'contact' end
         and c.subject_id = p_id and c.address_hash is null and c.hash_version = 1
         and app.consent_pending_hash(c.id) is not null;
    end if;
    update app.consent_pending_address p set value = null
      from public.consents c
     where c.id = p.consent_id and c.organization_id = p_org
       and c.subject_type = case p_type when 'leads' then 'lead' else 'contact' end
       and c.subject_id = p_id and p.value is not null;
  end if;

  v_count := v_count + v_notes;
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, p_actor, 'erase', p_type, p_id, jsonb_build_object('entries', v_count));
  return v_count;
end;
$$;
revoke all on function app.audit_erase_core(uuid, text, uuid, uuid) from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- The documents list's customer column (LST-09, 020690): a company's opening balance has neither contact nor deal, so the
-- sort field falls back to the company's name. Body of 20261006020690 with one change, marked GAP-12; same shape (sql,
-- stable, security invoker, the same SET), so RLS still decides which names are read. Mirrored by customerNames().
create or replace function public.sort_customer(public.accounting_documents) returns text
language sql stable security invoker
set search_path = ''
as $$
  select coalesce(
    (select c.full_name from public.contacts c where c.organization_id = $1.organization_id and c.id = $1.contact_id),
    (select d.name from public.deals d where d.organization_id = $1.organization_id and d.id = $1.deal_id),
    -- GAP-12: a company's opening balance
    (select co.name from public.companies co where co.organization_id = $1.organization_id and co.id = $1.company_id)
  );
$$;
revoke all on function public.sort_customer(public.accounting_documents) from public, anon;
grant execute on function public.sort_customer(public.accounting_documents) to authenticated;
