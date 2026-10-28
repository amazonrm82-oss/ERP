-- =============================================================================
-- DOC-02: the accounting document as the system keeps it (spec 6.5: provider, the provider's id, type, number, date,
-- customer, lines, amounts, VAT, status, PDF link, allocation number and the source document)
-- =============================================================================
-- What DOC-01 already holds: type, number, date, customer (deal / contact / company), amount and currency, status (active /
-- cancelled), the PDF (one current `files` row per document, 020640/020645), the order it came from (order_id, 020740) and the
-- proforma a tax invoice bills (proforma_id, 020790). This file adds the rest, all nullable, so every document recorded so far
-- stays as it is:
-- * provider, provider_document_id: who issued it and its id there (wave 3, DOC-05/DOC-06; no provider is chosen and nothing
--   writes them yet). null = recorded by hand ("נרשם ידנית", DOC-01). A provider is a code (a-z, digits, underscore; 2..40),
--   not a closed list: the list is the owner's choice of providers (spec 6.6) and comes with the adapter. Both or neither;
--   one row per provider id in a business (unique index). Server only: no client grant, and a person's insert naming them is
--   refused (hint document:provider). The server (no session) may fill them once on a document that has none (DOC-11 matching).
-- * allocation_number: the Tax Authority's allocation number ("מספר הקצאה"), digits only (1..20; the owner is asked whether to
--   hold it to exactly 9), only on a tax invoice or a tax invoice-receipt (spec 6.4). A person types it on insert; the server
--   may fill it once later (DOC-10, from the provider).
-- * net_agorot, vat_agorot, vat_rate_bp: the VAT split as printed on the document. Both amounts or neither; then
--   net + vat = amount_agorot exactly (constraint accounting_documents_vat_shape); the rate (0..10000 basis points) only with
--   them. Not on an opening balance. The system computes nothing here: the provider (or the paper) is the source.
-- * quote_id: the accepted quote the document came from ("מסמך המקור", beside order_id). Composite FK, set null of the column;
--   an accepted quote of the same customer (app.money_same_customer, PAY-02's rule: same deal, contact, or company), hint
--   document:source. One source: a quote or an order, never both (constraint). Not on an opening balance.
-- * original_document_id: a credit invoice's original document (spec 6.4: "תמיד מפנה למסמך המקורי"; optional here, because a
--   credit recorded by hand may not have its original in the system): an ACTIVE tax invoice or tax invoice-receipt of the
--   same customer, hint document:original. Composite FK to the same table, set null of the column.
-- Every new column is insert-only for a person (insert grants only) and frozen for every writer by the INVOKER trigger
-- app.accounting_documents_source (outsider guard first; the source and the original read under the caller's RLS; it runs after accounting_documents_check and
-- accounting_documents_order by name, as ORD-06 part two added order_id: the frozen list of accounting_documents_check is
-- unchanged and this trigger holds the new columns), but for a foreign key's own set-null one trigger level down and the
-- server's one-time fill above. Audited with the row (app.audit_row). None of them is personal data.
--
-- * public.accounting_document_lines: the document's lines (position, an optional product, description, quantity, unit price,
--   line discount, VAT-exempt flag, currency ('ILS' only, as every money table), and the line total = round(quantity x unit price) - discount, set by the trigger, never
--   below 0). Rights follow the document: select = the document is readable; insert = a recorder of a writable business with
--   the `documents` key, on a readable active document that is not an opening balance. Lines are written WITH their document:
--   only in the transaction that inserted it, by the user who inserted it (public.accounting_document_record does both in one
--   call), so a recorded document's lines never change (no update or delete grant; hint document_line:frozen). At most 200 per
--   document (hint document_lines:max). Product FK with no on delete action (a used product is archived, test 98). The lines
--   are informational: their sum is not held to the document's amount (document discounts, VAT, rounding are the issuer's).
--   Audited. A privacy erasure (app.audit_erase_core, copied from 021100 with one change marked DOC-02) replaces the text of
--   every line of the documents it reaches with the neutral "הפריט נמחק (מחיקת פרטיות)" (staff may have typed the customer's
--   name) and erases the lines' audit entries with the rest; numbers and totals stay.
-- * public.accounting_document_record(org, document, lines): records a document and its lines in one transaction, with the
--   caller's rights (security invoker: the table policies, grants and triggers decide).
-- Merge, sample data and import undo: lines link only to a document and a product, never to a lead, contact, company or deal,
-- so app.merge_move_links, app.sample_untouched and app.import_record_worked need nothing (a document already counts).
-- Full export: the new table (EXPORT_TABLES).
-- Every statement is safe to run twice. No drops of objects, no row removal.

-- ----------------------------------------------------------------------------
-- The new columns of accounting_documents
-- ----------------------------------------------------------------------------
alter table public.accounting_documents add column if not exists provider text;
alter table public.accounting_documents add column if not exists provider_document_id text;
alter table public.accounting_documents add column if not exists allocation_number text;
alter table public.accounting_documents add column if not exists net_agorot bigint;
alter table public.accounting_documents add column if not exists vat_agorot bigint;
alter table public.accounting_documents add column if not exists vat_rate_bp integer;
alter table public.accounting_documents add column if not exists quote_id uuid;
alter table public.accounting_documents add column if not exists original_document_id uuid;

alter table public.accounting_documents drop constraint if exists accounting_documents_provider_shape;
alter table public.accounting_documents add constraint accounting_documents_provider_shape check (
  (provider is null) = (provider_document_id is null)
  and (provider is null or provider ~ '^[a-z][a-z0-9_]{1,39}$')
  and (provider_document_id is null
       or (char_length(provider_document_id) between 1 and 200 and provider_document_id = btrim(provider_document_id))));
create unique index if not exists accounting_documents_provider_once
  on public.accounting_documents (organization_id, provider, provider_document_id) where provider is not null;

alter table public.accounting_documents drop constraint if exists accounting_documents_allocation_shape;
alter table public.accounting_documents add constraint accounting_documents_allocation_shape check (
  allocation_number is null
  or (doc_type in ('tax_invoice', 'tax_invoice_receipt') and allocation_number ~ '^[0-9]{1,20}$'));

alter table public.accounting_documents drop constraint if exists accounting_documents_vat_shape;
alter table public.accounting_documents add constraint accounting_documents_vat_shape check (
  (net_agorot is null) = (vat_agorot is null)
  and (net_agorot is null
       or (doc_type <> 'opening_balance' and net_agorot >= 0 and vat_agorot >= 0 and net_agorot + vat_agorot = amount_agorot))
  and (vat_rate_bp is null or (net_agorot is not null and vat_rate_bp between 0 and 10000)));

alter table public.accounting_documents drop constraint if exists accounting_documents_quote_fk;
alter table public.accounting_documents add constraint accounting_documents_quote_fk foreign key (organization_id, quote_id)
  references public.quotes (organization_id, id) on delete set null (quote_id);
create index if not exists accounting_documents_quote_idx on public.accounting_documents (organization_id, quote_id);

alter table public.accounting_documents drop constraint if exists accounting_documents_original_fk;
alter table public.accounting_documents add constraint accounting_documents_original_fk foreign key (organization_id, original_document_id)
  references public.accounting_documents (organization_id, id) on delete set null (original_document_id);
create index if not exists accounting_documents_original_idx on public.accounting_documents (organization_id, original_document_id);

alter table public.accounting_documents drop constraint if exists accounting_documents_source_shape;
alter table public.accounting_documents add constraint accounting_documents_source_shape check (
  (quote_id is null or order_id is null)
  and (quote_id is null or doc_type <> 'opening_balance')
  and (original_document_id is null or (doc_type = 'credit_invoice' and original_document_id <> id)));

-- a person types these on insert only; provider and provider_document_id are the server's
grant insert (allocation_number, net_agorot, vat_agorot, vat_rate_bp, quote_id, original_document_id)
  on public.accounting_documents to authenticated;

-- ----------------------------------------------------------------------------
-- The rule for the new columns (every writer)
-- ----------------------------------------------------------------------------
-- Security INVOKER (review of DOC-02): the source quote and the original document are read under the caller's RLS, so a
-- quote or document the caller cannot read answers exactly like one that does not exist or does not fit (one hint each),
-- and nothing about another customer's rows is revealed. The same-customer rule is PAY-02's (app.money_same_customer: same
-- deal, same contact, or a company shared through a contact or a deal), written inline over the rows the caller reads.
create or replace function app.accounting_documents_source() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_source record;
  v_same boolean;
begin
  -- outsider guard: RLS refuses (42501) a person who may not record documents here, before anything is revealed
  if auth.uid() is not null and not (app.can_record_documents(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- the provider's fields are written by the server only (the provider layer, wave 3)
    if auth.uid() is not null and (new.provider is not null or new.provider_document_id is not null) then
      raise exception 'only the provider layer names a provider' using errcode = 'P0001', hint = 'document:provider';
    end if;
    if new.quote_id is not null then
      select q.status, q.deal_id, q.contact_id into v_source
        from public.quotes q where q.organization_id = new.organization_id and q.id = new.quote_id;
      v_same := found and v_source.status = 'accepted';
      if v_same then
        v_same := coalesce(new.deal_id = v_source.deal_id, false) or coalesce(new.contact_id = v_source.contact_id, false)
          or exists (select 1
                       from (select c.company_id from public.contacts c where c.organization_id = new.organization_id and c.id = new.contact_id
                             union all
                             select d.company_id from public.deals d where d.organization_id = new.organization_id and d.id = new.deal_id) a
                       join (select c.company_id from public.contacts c where c.organization_id = new.organization_id and c.id = v_source.contact_id
                             union all
                             select d.company_id from public.deals d where d.organization_id = new.organization_id and d.id = v_source.deal_id) b
                         on a.company_id = b.company_id);
      end if;
      if not v_same then
        raise exception 'the source quote is an accepted quote of the same customer' using errcode = 'P0001', hint = 'document:source';
      end if;
    end if;
    if new.original_document_id is not null then
      -- an ACTIVE tax invoice or tax invoice-receipt
      select d.doc_type, d.status, d.deal_id, d.contact_id into v_source
        from public.accounting_documents d where d.organization_id = new.organization_id and d.id = new.original_document_id;
      v_same := found and v_source.status = 'active' and v_source.doc_type in ('tax_invoice', 'tax_invoice_receipt');
      if v_same then
        v_same := coalesce(new.deal_id = v_source.deal_id, false) or coalesce(new.contact_id = v_source.contact_id, false)
          or exists (select 1
                       from (select c.company_id from public.contacts c where c.organization_id = new.organization_id and c.id = new.contact_id
                             union all
                             select d.company_id from public.deals d where d.organization_id = new.organization_id and d.id = new.deal_id) a
                       join (select c.company_id from public.contacts c where c.organization_id = new.organization_id and c.id = v_source.contact_id
                             union all
                             select d.company_id from public.deals d where d.organization_id = new.organization_id and d.id = v_source.deal_id) b
                         on a.company_id = b.company_id);
      end if;
      if not v_same then
        raise exception 'a credit invoice refers to an active tax invoice of the same customer' using errcode = 'P0001', hint = 'document:original';
      end if;
    end if;
    return new;
  end if;

  -- UPDATE. The server (no session) may fill the provider's fields and the allocation number once, on a document without them
  if auth.uid() is null and old.provider is null and old.provider_document_id is null
     and new.provider is not null and new.provider_document_id is not null then
    null;
  elsif row(new.provider, new.provider_document_id) is distinct from row(old.provider, old.provider_document_id) then
    raise exception 'a recorded document does not change; cancel it instead' using errcode = 'P0001', hint = 'document:frozen';
  end if;
  if new.allocation_number is distinct from old.allocation_number
     and not (auth.uid() is null and old.allocation_number is null) then
    raise exception 'a recorded document does not change; cancel it instead' using errcode = 'P0001', hint = 'document:frozen';
  end if;
  if row(new.net_agorot, new.vat_agorot, new.vat_rate_bp) is distinct from row(old.net_agorot, old.vat_agorot, old.vat_rate_bp) then
    raise exception 'a recorded document does not change; cancel it instead' using errcode = 'P0001', hint = 'document:frozen';
  end if;
  -- the source links never change, but for the foreign key's own set-null (a nested trigger)
  if new.quote_id is distinct from old.quote_id and not (new.quote_id is null and pg_trigger_depth() > 1) then
    raise exception 'a recorded document does not change; cancel it instead' using errcode = 'P0001', hint = 'document:frozen';
  end if;
  if new.original_document_id is distinct from old.original_document_id
     and not (new.original_document_id is null and pg_trigger_depth() > 1) then
    raise exception 'a recorded document does not change; cancel it instead' using errcode = 'P0001', hint = 'document:frozen';
  end if;
  return new;
end;
$$;
revoke all on function app.accounting_documents_source() from public, anon, authenticated;

create or replace trigger accounting_documents_source before insert or update on public.accounting_documents
  for each row execute function app.accounting_documents_source();

-- ----------------------------------------------------------------------------
-- The lines
-- ----------------------------------------------------------------------------
create table if not exists public.accounting_document_lines (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  document_id        uuid not null,
  position           integer not null check (position between 1 and 200),
  product_id         uuid,
  description        text not null check (char_length(description) between 1 and 500 and description = btrim(description)),
  quantity           numeric(14, 3) not null default 1 check (quantity > 0 and quantity <= 1000000),
  unit_price_agorot  bigint not null default 0 check (unit_price_agorot between 0 and 1000000000000),
  discount_agorot    bigint not null default 0 check (discount_agorot between 0 and 1000000000000),
  vat_exempt         boolean not null default false,
  total_agorot       bigint not null default 0 check (total_agorot between 0 and 1000000000000000),
  currency           text not null default 'ILS' check (currency = 'ILS'),
  created_by         uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (organization_id, id),
  constraint accounting_document_lines_position_once unique (organization_id, document_id, position),
  constraint accounting_document_lines_document_fk foreign key (organization_id, document_id)
    references public.accounting_documents (organization_id, id) on delete cascade,
  -- no on delete action: a product on a line is archived, never removed (test 98)
  constraint accounting_document_lines_product_fk foreign key (organization_id, product_id)
    references public.products (organization_id, id)
);

create index if not exists accounting_document_lines_document_idx on public.accounting_document_lines (organization_id, document_id);
create index if not exists accounting_document_lines_product_idx on public.accounting_document_lines (organization_id, product_id);

alter table public.accounting_document_lines enable row level security;

revoke all on public.accounting_document_lines from anon, authenticated;
grant select on public.accounting_document_lines to authenticated;
-- product_id is the server's for now (review of DOC-02): no screen picks a product on a recorded document yet, and a person's
-- product line would need the `products` flag and an offerable product; the provider layer may set it later
grant insert (organization_id, document_id, position, description, quantity, unit_price_agorot, discount_agorot, vat_exempt)
  on public.accounting_document_lines to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'accounting_document_lines'
                  and policyname = 'accounting_document_lines_select') then
    -- the document's read rule (its own RLS, read under the caller's rights)
    create policy accounting_document_lines_select on public.accounting_document_lines for select to authenticated
      using (exists (select 1 from public.accounting_documents d
                      where d.organization_id = accounting_document_lines.organization_id
                        and d.id = accounting_document_lines.document_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'accounting_document_lines'
                  and policyname = 'accounting_document_lines_insert') then
    create policy accounting_document_lines_insert on public.accounting_document_lines for insert to authenticated
      with check (app.can_record_documents(organization_id) and app.org_writable(organization_id)
                  and app.org_has_feature(organization_id, 'documents')
                  and exists (select 1 from public.accounting_documents d
                               where d.organization_id = accounting_document_lines.organization_id
                                 and d.id = accounting_document_lines.document_id
                                 and d.status = 'active' and d.doc_type <> 'opening_balance'));
  end if;
end;
$$;

-- every writer: written with the document, in its transaction; the total is the server's; frozen after.
-- Security INVOKER (review of DOC-02): the document is read under the caller's RLS, so a document the caller cannot read
-- answers like one that does not exist (one neutral hint, document_line:frozen), revealing nothing about it.
create or replace function app.accounting_document_lines_check() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_doc record;
  v_count integer;
  v_total numeric;
begin
  -- outsider guard: RLS refuses (42501) a person who may not record documents here, before anything is revealed
  if auth.uid() is not null and not (app.can_record_documents(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    -- a privacy erasure replaces a line's text with the neutral one (app.audit_erase_core sets the flag for its update only)
    if current_setting('app.document_server', true) = 'erase'
       and new.description = 'הפריט נמחק (מחיקת פרטיות)'
       and row(new.organization_id, new.document_id, new.position, new.product_id, new.quantity, new.unit_price_agorot,
               new.discount_agorot, new.vat_exempt, new.total_agorot, new.created_by, new.created_at)
           is not distinct from
           row(old.organization_id, old.document_id, old.position, old.product_id, old.quantity, old.unit_price_agorot,
               old.discount_agorot, old.vat_exempt, old.total_agorot, old.created_by, old.created_at) then
      return new;
    end if;
    -- the currency is held to 'ILS' by its check until DEAL-12 (that check answers for it, 23514)
    if row(new.organization_id, new.document_id, new.position, new.product_id, new.description, new.quantity,
           new.unit_price_agorot, new.discount_agorot, new.vat_exempt, new.total_agorot, new.created_by, new.created_at)
       is not distinct from
       row(old.organization_id, old.document_id, old.position, old.product_id, old.description, old.quantity,
           old.unit_price_agorot, old.discount_agorot, old.vat_exempt, old.total_agorot, old.created_by, old.created_at) then
      return new;
    end if;
    raise exception 'the lines of a recorded document do not change' using errcode = 'P0001', hint = 'document_line:frozen';
  end if;

  -- INSERT: one writer of a document's lines at a time, so the count below holds
  perform pg_advisory_xact_lock(hashtextextended('accounting_document_lines:' || new.organization_id::text || ':' || coalesce(new.document_id::text, ''), 0));
  select d.doc_type, d.status, d.created_at, d.created_by into v_doc
    from public.accounting_documents d
   where d.organization_id = new.organization_id and d.id = new.document_id;
  if not found then
    -- unknown, of another business, or not readable by the caller: one answer
    raise exception 'lines are recorded together with their document' using errcode = 'P0001', hint = 'document_line:frozen';
  end if;
  if v_doc.doc_type = 'opening_balance' then
    raise exception 'an opening balance has no lines' using errcode = 'P0001', hint = 'document_line:opening';
  end if;
  -- lines are written with their document: in the transaction that recorded it, by the same person
  if v_doc.status <> 'active' or v_doc.created_at <> now()
     or (auth.uid() is not null and v_doc.created_by is distinct from auth.uid()) then
    raise exception 'lines are recorded together with their document' using errcode = 'P0001', hint = 'document_line:frozen';
  end if;
  select count(*), coalesce(max(l.position), 0) into v_count, v_total
    from public.accounting_document_lines l
   where l.organization_id = new.organization_id and l.document_id = new.document_id;
  if v_count >= 200 then
    raise exception 'a document has at most 200 lines' using errcode = 'P0001', hint = 'document_lines:max';
  end if;
  if new.position is null then
    new.position := v_total::integer + 1;
  end if;

  new.created_by := coalesce(auth.uid(), new.created_by);
  new.description := btrim(coalesce(new.description, ''));
  if new.description = '' and new.product_id is not null then
    select btrim(p.name) into new.description
      from public.products p where p.organization_id = new.organization_id and p.id = new.product_id;
    new.description := coalesce(new.description, '');
  end if;
  if new.description = '' then
    raise exception 'a line needs a description' using errcode = 'P0001', hint = 'document_line:description';
  end if;
  new.description := left(new.description, 500);
  -- half up (the amounts are never negative)
  v_total := round(new.quantity * new.unit_price_agorot) - new.discount_agorot;
  if v_total < 0 then
    raise exception 'the line discount is larger than the line' using errcode = 'P0001', hint = 'document_line:total';
  end if;
  new.total_agorot := v_total::bigint;
  return new;
end;
$$;
revoke all on function app.accounting_document_lines_check() from public, anon, authenticated;

create or replace trigger accounting_document_lines_check before insert or update on public.accounting_document_lines
  for each row execute function app.accounting_document_lines_check();
create or replace trigger accounting_document_lines_touch before insert or update on public.accounting_document_lines
  for each row execute function app.touch_row();
create or replace trigger accounting_document_lines_audit after insert or update or delete on public.accounting_document_lines
  for each row execute function app.audit_row();

-- ----------------------------------------------------------------------------
-- One call: the document and its lines, in one transaction, with the caller's rights
-- ----------------------------------------------------------------------------
create or replace function public.accounting_document_record(p_org uuid, p_document jsonb, p_lines jsonb)
returns uuid
language plpgsql volatile security invoker
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_document is null or jsonb_typeof(p_document) <> 'object'
     or (p_lines is not null and jsonb_typeof(p_lines) <> 'array') then
    raise exception 'a document is an object and its lines an array' using errcode = '22023';
  end if;
  if coalesce(jsonb_array_length(p_lines), 0) > 200 then
    raise exception 'a document has at most 200 lines' using errcode = 'P0001', hint = 'document_lines:max';
  end if;
  insert into public.accounting_documents
    (organization_id, deal_id, contact_id, order_id, quote_id, original_document_id, doc_type, number, doc_date,
     amount_agorot, due_date, allocation_number, net_agorot, vat_agorot, vat_rate_bp)
  values
    (p_org,
     (p_document ->> 'deal_id')::uuid,
     (p_document ->> 'contact_id')::uuid,
     (p_document ->> 'order_id')::uuid,
     (p_document ->> 'quote_id')::uuid,
     (p_document ->> 'original_document_id')::uuid,
     p_document ->> 'doc_type',
     p_document ->> 'number',
     coalesce((p_document ->> 'doc_date')::date,
              (now() at time zone coalesce((select o.timezone from public.organizations o where o.id = p_org), 'Asia/Jerusalem'))::date),
     (p_document ->> 'amount_agorot')::bigint,
     (p_document ->> 'due_date')::date,
     p_document ->> 'allocation_number',
     (p_document ->> 'net_agorot')::bigint,
     (p_document ->> 'vat_agorot')::bigint,
     (p_document ->> 'vat_rate_bp')::integer)
  returning id into v_id;
  insert into public.accounting_document_lines
    (organization_id, document_id, position, description, quantity, unit_price_agorot, discount_agorot, vat_exempt)
  select p_org, v_id, x.n::integer,
         coalesce(x.line ->> 'description', ''),
         coalesce((x.line ->> 'quantity')::numeric, 1),
         coalesce((x.line ->> 'unit_price_agorot')::bigint, 0),
         coalesce((x.line ->> 'discount_agorot')::bigint, 0),
         coalesce((x.line ->> 'vat_exempt')::boolean, false)
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) with ordinality as x(line, n)
   order by x.n;
  return v_id;
end;
$$;
revoke all on function public.accounting_document_record(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.accounting_document_record(uuid, jsonb, jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- Privacy erasure: app.audit_erase_core copied exactly from its latest body (021100, payment_promise_erasure) with ONE change,
-- marked DOC-02 (inside the DOC-01 block, while app.document_server = 'erase'): the lines of the documents the block found
-- get the neutral text and their audit entries join v_children (erased by the existing final step).
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
    -- DOC-02: the lines of those documents keep their numbers; a line's text (staff may have typed the customer's name)
    -- becomes the neutral text, and every entry of the lines (their insert and this update) is erased below with the rest
    for v_child in
      select 'accounting_document_lines'::text as entity_type, l.id as entity_id from public.accounting_document_lines l
       where l.organization_id = p_org
         and l.document_id = any (array(select substr(c, 22)::uuid from unnest(v_children) c where c like 'accounting_documents:%'))
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    update public.accounting_document_lines l set description = 'הפריט נמחק (מחיקת פרטיות)'
     where l.organization_id = p_org and l.description is distinct from 'הפריט נמחק (מחיקת פרטיות)'
       and l.document_id = any (array(select substr(c, 22)::uuid from unnest(v_children) c where c like 'accounting_documents:%'));
    perform set_config('app.document_server', '', true);
    -- COL-03: the payment promises of those documents keep their date; the collection note (staff may have named the customer)
    -- is emptied, and every entry of them (a removed one's too, by its delete entry) is erased below with the rest
    for v_child in
      select 'payment_promises'::text as entity_type, pp.id as entity_id from public.payment_promises pp
       where pp.organization_id = p_org and ('accounting_documents:' || pp.document_id) = any (v_children)
      union
      select 'payment_promises', a.entity_id from public.audit_log a
       where a.organization_id = p_org and a.entity_type = 'payment_promises' and a.entity_id is not null
         and ('accounting_documents:' || coalesce(a.changes ->> 'document_id', a.changes -> 'document_id' ->> 'old')) = any (v_children)
      union
      -- a customer promise of the erased contact or company (gone with it by cascade at the purge): its entries
      select 'payment_promises', a.entity_id from public.audit_log a
       where p_type in ('contacts', 'companies')
         and a.organization_id = p_org and a.entity_type = 'payment_promises' and a.entity_id is not null
         and coalesce(a.changes ->> v_col, a.changes -> v_col ->> 'old') = p_id::text
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    update public.payment_promises pp set note = null
     where pp.organization_id = p_org and pp.note is not null and ('accounting_documents:' || pp.document_id) = any (v_children);
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
