-- QUO-07 (the part that needs no customer page): a quote is marked as sent, which gives it its running
-- number (QUO-03) and locks it; and the owner's retention rule for a sent quote whose record is purged
-- (15 October 2026): drafts go with their deal or contact; a quote that is no longer a draft stays,
-- detached, with the customer's name as it was sent, marked "הלקוח נמחק"; a privacy erasure empties its
-- personal details and keeps its number, date and amounts. The public link, the WhatsApp button and
-- "copy link" need the customer page (QUO-08) and are left for it.
--
-- public.quotes, new server-only columns (no client grant):
--   number, number_display      from app.next_document_number(org, 'quote') when sent; never reused
--   sent_at                     when it was marked sent
--   customer_name               the customer as the quote names it when sent (CON-08: the contact's name for
--   customer_contact_name       invoices, else its company's, else the company, else the contact) and the person
--   former_deal_id              the deal / contact it was detached from by a purge (ids only, no FK), so an
--   former_contact_id           erasure of that record finds it
--   customer_deleted_at         set when a purge left it with neither deal nor contact ("הלקוח נמחק")
-- quotes_has_parent now holds for drafts only. Purging a deal or a contact first detaches the quotes that
-- are no longer drafts (definer triggers deals_quotes_detach, contacts_quotes_detach, skipped while the
-- business itself is deleted); the cascade then removes the drafts. A detached quote is read by owners and
-- admins (quotes_select); its lines follow it. Nobody edits it: it is no longer a draft.
--
-- public.quote_send(org, quote) (definer): whoever may edit the draft (app.quote_editable), in a business
-- with the 'quotes' flag; refuses an empty quote (hint quote:empty) and a quote whose VAT is unknown (hint
-- quote:vat_unknown); takes the number, stamps sent_at and the customer names, sets status 'sent'. The
-- totals are worked out a last time by app.quotes_check on that update and then stay.
--
-- Redefined: app.quotes_check (020105; only the deal may now be detached by the server),
-- app.quotes_detach_contact (020105), app.audit_erase_core (latest body 020105; only the QUO-07 block added).
--
-- Every statement is safe to run twice. No drops, no row removal.

alter table public.quotes add column if not exists number bigint;
alter table public.quotes add column if not exists number_display text;
alter table public.quotes add column if not exists sent_at timestamptz;
alter table public.quotes add column if not exists customer_name text;
alter table public.quotes add column if not exists customer_contact_name text;
alter table public.quotes add column if not exists former_deal_id uuid;
alter table public.quotes add column if not exists former_contact_id uuid;
alter table public.quotes add column if not exists customer_deleted_at timestamptz;

-- a draft needs its deal or contact; a quote that was sent may outlive them
alter table public.quotes drop constraint if exists quotes_has_parent;
alter table public.quotes add constraint quotes_has_parent
  check (deal_id is not null or contact_id is not null or status <> 'draft');
alter table public.quotes drop constraint if exists quotes_number_once;
alter table public.quotes add constraint quotes_number_once unique (organization_id, number);

create index if not exists quotes_former_deal_idx on public.quotes (organization_id, former_deal_id) where former_deal_id is not null;
create index if not exists quotes_former_contact_idx on public.quotes (organization_id, former_contact_id) where former_contact_id is not null;

-- a quote detached from both its deal and its contact: owners and admins read it
alter policy quotes_select on public.quotes
  using (case when quotes.deal_id is not null
              then exists (select 1 from public.deals d where d.organization_id = quotes.organization_id and d.id = quotes.deal_id)
              when quotes.contact_id is not null
              then exists (select 1 from public.contacts c where c.organization_id = quotes.organization_id and c.id = quotes.contact_id)
              else app.is_admin(quotes.organization_id)
         end);

-- ----------------------------------------------------------------------------
-- Redefined from 020105: the server may detach the deal.
-- ----------------------------------------------------------------------------
create or replace function app.quotes_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_zone text;
  v_deal_contact uuid;
  v_deal_company uuid;
  v_rate integer;
  v_lines jsonb;
  v_totals jsonb;
begin
  -- outsider guard: a person who may not edit the quote's parent is refused by RLS (42501)
  if auth.uid() is not null and not app.quote_editable(new.organization_id, new.deal_id, new.contact_id) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if auth.uid() is not null and not app.org_has_feature(new.organization_id, 'quotes') then
      raise exception 'quotes are not in this plan' using errcode = 'P0001', hint = 'feature:quotes';
    end if;
    select o.timezone into v_zone from public.organizations o where o.id = new.organization_id;
    new.quote_date := (now() at time zone coalesce(v_zone, 'Asia/Jerusalem'))::date;
    if auth.uid() is not null then
      new.status := 'draft';
      new.owner_id := auth.uid();
      new.prices_include_vat := coalesce((select s.prices_include_vat from public.org_document_settings s
                                           where s.organization_id = new.organization_id), false)
                                and new.no_vat_reason is null;
    end if;
    -- the customer of the deal, else the contact's company
    if new.deal_id is not null then
      select d.contact_id, d.company_id into v_deal_contact, v_deal_company
        from public.deals d where d.organization_id = new.organization_id and d.id = new.deal_id;
      new.contact_id := coalesce(new.contact_id, v_deal_contact);
      new.company_id := coalesce(new.company_id, v_deal_company);
    end if;
    if new.company_id is null and new.contact_id is not null then
      new.company_id := (select c.company_id from public.contacts c
                          where c.organization_id = new.organization_id and c.id = new.contact_id);
    end if;
  else
    new.organization_id := old.organization_id;
    -- the deal stays fixed (no client grant); the server may only detach it (QUO-07, a purged deal)
    new.deal_id := case when new.deal_id is null then null else old.deal_id end;
    new.quote_date := old.quote_date;
    new.owner_id := old.owner_id;
    new.created_by := old.created_by;
    -- a quote that is no longer a draft keeps the inputs its amounts were worked out from, for
    -- every writer (the amounts themselves are kept below), so they never disagree
    if old.status <> 'draft'
       and (new.discount_bp is distinct from old.discount_bp
            or new.discount_agorot is distinct from old.discount_agorot
            or new.prices_include_vat is distinct from old.prices_include_vat
            or new.no_vat_reason is distinct from old.no_vat_reason) then
      raise exception 'the prices of a quote that is no longer a draft cannot change' using errcode = 'P0001', hint = 'quote:frozen';
    end if;
    if new.prices_include_vat is distinct from old.prices_include_vat
       and exists (select 1 from public.quote_lines l
                    where l.organization_id = new.organization_id and l.quote_id = new.id and l.kind = 'item') then
      raise exception 'the VAT mode of a quote with lines cannot change' using errcode = 'P0001', hint = 'quote:vat_locked';
    end if;
  end if;

  if (new.discount_bp is not null or new.discount_agorot is not null)
     and (tg_op = 'INSERT' or new.discount_bp is distinct from old.discount_bp
          or new.discount_agorot is distinct from old.discount_agorot)
     and auth.uid() is not null
     and not app.org_has_feature(new.organization_id, 'discounts') then
    raise exception 'discounts are not in this plan' using errcode = 'P0001', hint = 'feature:discounts';
  end if;

  -- a quote that is no longer a draft keeps the amounts and rate it was sent with; a later
  -- change of the business's VAT, or a server update such as detaching a purged contact,
  -- never rewrites them. Drafts (and the update that sends one) are worked out again.
  if tg_op = 'UPDATE' and old.status <> 'draft' then
    new.vat_rate_bp := old.vat_rate_bp;
    new.subtotal_agorot := old.subtotal_agorot;
    new.discount_total_agorot := old.discount_total_agorot;
    new.net_total_agorot := old.net_total_agorot;
    new.vat_agorot := old.vat_agorot;
    new.total_agorot := old.total_agorot;
    return new;
  end if;

  -- totals by the one totals rule (TAX-05)
  v_rate := case when new.no_vat_reason is not null then 0
                 else app.org_document_vat_rate(new.organization_id, new.quote_date) end;
  if tg_op = 'INSERT' then
    v_lines := '[]'::jsonb;
  else
    select coalesce(jsonb_agg(jsonb_build_object(
             'quantity', l.quantity,
             'unit_price_agorot', l.unit_price_agorot,
             'discount_bp', l.discount_bp,
             'discount_agorot', l.discount_agorot,
             'vat_exempt', l.vat_exempt) order by l.position, l.id), '[]'::jsonb)
      into v_lines
      from public.quote_lines l
     where l.organization_id = new.organization_id and l.quote_id = new.id
       and l.kind = 'item' and (not l.is_optional or l.optional_selected);
  end if;
  v_totals := app.document_totals(v_lines, coalesce(v_rate, 0), new.prices_include_vat, new.discount_bp, new.discount_agorot);
  new.vat_rate_bp := v_rate;
  new.subtotal_agorot := (v_totals ->> 'subtotal_agorot')::bigint;
  new.discount_total_agorot := (v_totals ->> 'document_discount_agorot')::bigint;
  new.net_total_agorot := (v_totals ->> 'net_total_agorot')::bigint;
  new.vat_agorot := (v_totals ->> 'vat_agorot')::bigint;
  new.total_agorot := (v_totals ->> 'total_agorot')::bigint;
  return new;
end;
$$;
revoke all on function app.quotes_check() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Purges: a quote that is no longer a draft is detached first; drafts go by the cascade.
-- ----------------------------------------------------------------------------
create or replace function app.quotes_detach_contact() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- the whole business is being deleted: its quotes go with it, and an audit entry for a
  -- business that no longer exists would break the audit log's foreign key
  if not app.org_exists(old.organization_id) then
    return old;
  end if;
  -- a deal's quote that names the contact stays with the deal; a sent contact quote stays on its own
  update public.quotes q
     set contact_id = null,
         former_contact_id = old.id,
         customer_deleted_at = case when q.deal_id is null then now() else q.customer_deleted_at end
   where q.organization_id = old.organization_id and q.contact_id = old.id
     and (q.deal_id is not null or q.status <> 'draft');
  return old;
end;
$$;
revoke all on function app.quotes_detach_contact() from public, anon, authenticated;

create or replace function app.quotes_detach_deal() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if not app.org_exists(old.organization_id) then
    return old;
  end if;
  -- a sent deal quote stays: with its contact when it has one, else on its own
  update public.quotes q
     set deal_id = null,
         former_deal_id = old.id,
         customer_deleted_at = case when q.contact_id is null then now() else q.customer_deleted_at end
   where q.organization_id = old.organization_id and q.deal_id = old.id and q.status <> 'draft';
  return old;
end;
$$;
revoke all on function app.quotes_detach_deal() from public, anon, authenticated;

create or replace trigger deals_quotes_detach before delete on public.deals
  for each row execute function app.quotes_detach_deal();

-- ----------------------------------------------------------------------------
-- Marking a draft as sent
-- ----------------------------------------------------------------------------
create or replace function public.quote_send(p_org uuid, p_quote uuid) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_quote public.quotes;
  v_contact record;
  v_company_name text;
  v_name text;
  v_number bigint;
  v_display text;
begin
  select * into v_quote from public.quotes q where q.organization_id = p_org and q.id = p_quote for update;
  if not found or not app.quote_editable(p_org, v_quote.deal_id, v_quote.contact_id) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_quote.status <> 'draft' then
    raise exception 'the quote was already sent' using errcode = 'P0001', hint = 'quote:frozen';
  end if;
  if not app.org_has_feature(p_org, 'quotes') then
    raise exception 'quotes are not in this plan' using errcode = 'P0001', hint = 'feature:quotes';
  end if;
  if not exists (select 1 from public.quote_lines l where l.organization_id = p_org and l.quote_id = p_quote and l.kind = 'item') then
    raise exception 'a quote needs a line' using errcode = 'P0001', hint = 'quote:empty';
  end if;
  if v_quote.no_vat_reason is null and app.org_document_vat_rate(p_org, v_quote.quote_date) is null then
    raise exception 'the VAT status of the business is not set' using errcode = 'P0001', hint = 'quote:vat_unknown';
  end if;

  -- the customer as the quote names it (CON-08 order)
  select c.full_name, c.billing_name, co.name as company_name, co.billing_name as company_billing_name into v_contact
    from public.contacts c left join public.companies co on co.organization_id = c.organization_id and co.id = c.company_id
   where c.organization_id = p_org and c.id = v_quote.contact_id;
  select co.name into v_company_name from public.companies co where co.organization_id = p_org and co.id = v_quote.company_id;
  v_name := coalesce(v_contact.billing_name, v_contact.company_billing_name, v_contact.company_name, v_company_name, v_contact.full_name);

  select n.o_number, n.o_display into v_number, v_display from app.next_document_number(p_org, 'quote') n;

  update public.quotes q
     set status = 'sent', sent_at = now(), number = v_number, number_display = v_display,
         customer_name = v_name,
         customer_contact_name = case when v_contact.full_name is distinct from v_name then v_contact.full_name end
   where q.organization_id = p_org and q.id = p_quote;
  return jsonb_build_object('number', v_display);
end;
$$;
revoke all on function public.quote_send(uuid, uuid) from public, anon;
grant execute on function public.quote_send(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Privacy erasure. Redefined from its latest body (020105); only the QUO-07 block is added.
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

  -- tasks, files, notes and deal lines (DLI-01) that were linked to it and no longer exist: by the
  -- ids in their entries, and for notes by every record they were ever linked to
  for v_child in
    select distinct a.entity_type, a.entity_id from public.audit_log a
     where a.organization_id = p_org and a.entity_type in ('tasks', 'files', 'activities', 'deal_lines', 'quotes') and a.entity_id is not null
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

  -- QUO-01: the lines of those quotes (their entries carry quote_id, not the record's id)
  for v_child in
    select distinct a.entity_type, a.entity_id from public.audit_log a
     where a.organization_id = p_org and a.entity_type = 'quote_lines' and a.entity_id is not null
       and coalesce(a.changes ->> 'quote_id', a.changes -> 'quote_id' ->> 'old') = any (
             select substr(c, length('quotes:') + 1) from unnest(v_children) c where c like 'quotes:%')
  loop
    execute 'select exists (select 1 from public.quote_lines where organization_id = $1 and id = $2)'
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
         set customer_name = null, customer_contact_name = null, notes = null, title = 'הצעת מחיר'
       where q.organization_id = p_org and q.status <> 'draft'
         and ((p_type = 'contacts' and q.former_contact_id = p_id) or (p_type = 'deals' and q.former_deal_id = p_id))
      returning 'quotes'::text as entity_type, q.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
  end if;

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

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, p_actor, 'erase', p_type, p_id, jsonb_build_object('entries', v_count));
  return v_count;
end;
$$;
revoke all on function app.audit_erase_core(uuid, text, uuid, uuid) from public, anon, authenticated;
