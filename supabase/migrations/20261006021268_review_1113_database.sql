-- =============================================================================
-- Weekly review of 13 November 2026 (docs/reviews/2026-11-13.md), the low database findings
-- =============================================================================
-- * RVW-90 (LIB-02): a converted lead's library links follow it to its contact (trigger leads_library_links_convert,
--   app.convert_library_links, the pattern of leads_review_requests_convert), so the contact's card shows the views and
--   "turn off the link", and the first-opening notice goes by the contact. The public link keeps working while the contact
--   is live (app.library_record_live). Links of leads converted before this migration stay on the lead (no backfill: a bulk
--   rewrite of rows needs the owner's go-ahead). A lead merge sends the duplicate's links to the kept lead's contact when
--   the kept lead is converted (app.merge_library_links, 021229's body plus that branch).
-- * RVW-91: app.import_record_worked (021260's body) also counts a library link on any record, and a message or a prefill
--   link on a lead or contact, as work, like app.sample_untouched (021266).
-- * RVW-92 (SUB): a cycle that holds a document is not moved back to 'due' by a status change alone (hint
--   recurring_cycle:due_document); clearing the document still moves a documented cycle back (021256's first branch).
--   app.recurring_billing_cycles_check is 021256's body plus that line.
-- * RVW-93 (SUB): app.recurring_billing_rep takes the first USABLE of the deal's owner, the contact's owner and the
--   company's owner (active, full seat, not a viewer), then the business's owner, else its oldest admin.
-- * RVW-95 (PRV-01): app.lead_retention_candidates (021212's body) also keeps a lead that opened a library link or sent
--   back a prefill form since the cutoff (system entries library_viewed / prefill_submitted). A review request sent to the
--   lead keeps nothing: only the lead's own action does (owner (371) ב, 13 November 2026).
--
-- Safe to run twice. No drop statement, no delete.

-- ----------------------------------------------------------------------------
-- RVW-90: library links follow a converted lead
-- ----------------------------------------------------------------------------
create or replace function app.convert_library_links() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.converted_at is null or new.converted_contact_id is null then
    return null;
  end if;
  update public.library_links l set contact_id = new.converted_contact_id, lead_id = null
   where l.organization_id = new.organization_id and l.lead_id = new.id;
  return null;
end;
$$;
revoke all on function app.convert_library_links() from public, anon, authenticated, service_role;

create or replace trigger leads_library_links_convert
  after update of converted_at, converted_contact_id on public.leads
  for each row
  when (new.converted_at is not null and new.converted_contact_id is not null)
  execute function app.convert_library_links();

-- A lead merge (review of this fix): merge_records copies a converted duplicate's conversion onto the kept lead (the trigger
-- above then moves the kept lead's own links), and the `merged` entry moves the duplicate's links; a kept lead that is
-- converted sends them on to its contact, as app.merge_review_requests does (021240). 021229's body plus that lead branch.
create or replace function app.merge_library_links() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_merged uuid;
  v_contact uuid;
begin
  if (new.metadata ->> 'merged_id') !~ '^[0-9a-fA-F-]{36}$' then
    return null;
  end if;
  v_merged := (new.metadata ->> 'merged_id')::uuid;
  if new.lead_id is not null and v_merged <> new.lead_id then
    select l.converted_contact_id into v_contact
      from public.leads l
     where l.organization_id = new.organization_id and l.id = new.lead_id and l.converted_at is not null;
    if v_contact is not null then
      update public.library_links l set contact_id = v_contact, lead_id = null
       where l.organization_id = new.organization_id and l.lead_id = v_merged;
    else
      update public.library_links l set lead_id = new.lead_id
       where l.organization_id = new.organization_id and l.lead_id = v_merged;
    end if;
  elsif new.contact_id is not null and v_merged <> new.contact_id then
    update public.library_links l set contact_id = new.contact_id
     where l.organization_id = new.organization_id and l.contact_id = v_merged;
  elsif new.company_id is not null and v_merged <> new.company_id then
    update public.library_links l set company_id = new.company_id
     where l.organization_id = new.organization_id and l.company_id = v_merged;
  end if;
  return null;
end;
$$;
revoke all on function app.merge_library_links() from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- RVW-91: app.import_record_worked: 021260's body plus library links, messages and prefill links
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.import_record_worked(p_org uuid, p_type text, p_id uuid, p_since timestamp with time zone, p_job uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_col text := case p_type when 'lead' then 'lead_id' when 'contact' then 'contact_id'
                            when 'company' then 'company_id' when 'deal' then 'deal_id' end;
  v_found boolean;
begin
  -- RVW-36: an imported task is worked on when a checklist step was added after the import or any step is done
  if p_type = 'task' then
    return exists (select 1 from public.task_checklist_items x
                    where x.organization_id = p_org and x.task_id = p_id
                      and (x.created_at > p_since or x.done_at is not null))
        -- TASK-06 part B: a sub-task added under it (an import makes none)
        or exists (select 1 from public.tasks c where c.organization_id = p_org and c.parent_task_id = p_id);
  end if;
  -- no other records are linked to an imported task; its own row and its steps are the whole story
  if v_col is null then
    return false;
  end if;
  execute format(
    'select exists (select 1 from public.activities x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3
                                          and not (x.type = ''import_note'' and coalesce(x.metadata ->> ''import_job_id'' = $4::text, false))
                                          -- GAP-12: the timeline entries of the opening balances of this import
                                          -- (null-safe like the line above: a system entry without a kind stays work)
                                          and not coalesce(x.type = ''system'' and x.metadata ->> ''kind'' in (''document_recorded'', ''document_cancelled'')
                                                   and exists (select 1 from public.accounting_documents ad
                                                                where ad.organization_id = $1 and ad.id::text = x.metadata ->> ''document_id''
                                                                  and ad.import_job_id = $4), false))
         or exists (select 1 from public.tasks x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3
                                          -- COL-04: the reminder task of a document of this import (an opening balance)
                                          and not coalesce(exists (select 1 from public.accounting_documents ad
                                                                    where ad.organization_id = $1 and ad.id = x.collection_document_id
                                                                      and ad.import_job_id = $4), false))
         or exists (select 1 from public.meetings x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.files x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.record_followers x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         -- RVW-91 (LIB-02): a library link sent to it (an import makes none; undoing would kill the link sent to the customer)
         or exists (select 1 from public.library_links x where x.organization_id = $1 and x.%1$I = $2)',
    v_col)
    into v_found using p_org, p_id, p_since, p_job;
  if v_found then
    return true;
  end if;
  if p_type = 'lead' then
    -- CNS-05: the import's own consents are part of the import, not work on the record
    return exists (select 1 from public.consents x where x.organization_id = p_org and x.lead_id = p_id and x.created_at > p_since
                    and x.import_job_id is distinct from p_job)
        -- CON-06: a referral by the lead, made after the import
        or exists (select 1 from public.contact_relations x where x.organization_id = p_org and x.lead_id = p_id and x.created_at > p_since)
        -- SEG-01: put in a static segment after the import
        or exists (select 1 from public.segment_members x where x.organization_id = p_org and x.lead_id = p_id and x.created_at > p_since)
        -- RVW-91: a message sent or received (MSG-03), or a prefill link made for it (BIZ-05), as app.sample_untouched
        or exists (select 1 from public.messages x where x.organization_id = p_org and x.lead_id = p_id)
        or exists (select 1 from app.prefill_links x where x.organization_id = p_org and x.lead_id = p_id);
  elsif p_type = 'contact' then
    return exists (select 1 from public.quotes x where x.organization_id = p_org and x.contact_id = p_id)
        -- ORD-01: an order is always made after the import
        or exists (select 1 from public.orders x where x.organization_id = p_org and p_id in (x.contact_id, x.delivery_contact_id))
        -- DOC-01: a document is always recorded after the import
        or exists (select 1 from public.accounting_documents x where x.organization_id = p_org and x.contact_id = p_id
                     -- GAP-12: the job's own opening balance is part of the import
                     and x.import_job_id is distinct from p_job)
        -- PAY-01: a payment is always recorded after the import
        or exists (select 1 from public.payments x where x.organization_id = p_org and x.contact_id = p_id)
        -- COL-05: a hold is always set after the import
        or exists (select 1 from public.customer_holds x where x.organization_id = p_org and x.contact_id = p_id)
        -- RVW-64 (COL-03): a payment promise is always recorded after the import: on the customer, or on one of its
        -- documents (the job's own opening balance included, which the document line above leaves out)
        or exists (select 1 from public.payment_promises x where x.organization_id = p_org and x.contact_id = p_id)
        or exists (select 1 from public.payment_promises x
                     join public.accounting_documents ad on ad.organization_id = x.organization_id and ad.id = x.document_id
                    where x.organization_id = p_org and ad.contact_id = p_id)
        or exists (select 1 from public.consents x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since
                     and x.import_job_id is distinct from p_job)
        or exists (select 1 from public.contact_channels x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since)
        -- put on a deal later, or a deal from outside this import points at it
        or exists (select 1 from public.deal_contacts x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since)
        or exists (select 1 from public.deals x where x.organization_id = p_org and x.contact_id = p_id
                     and x.import_job_id is distinct from p_job)
        -- CON-05: a company linked, or a role changed, after the import
        or exists (select 1 from public.contact_companies x where x.organization_id = p_org and x.contact_id = p_id
                     and greatest(x.created_at, x.updated_at) > p_since)
        -- CON-06: a relation made after the import, on either side
        or exists (select 1 from public.contact_relations x where x.organization_id = p_org
                     and p_id in (x.contact_id, x.related_contact_id) and x.created_at > p_since)
        -- SEG-01: put in a static segment after the import
        or exists (select 1 from public.segment_members x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since)
        -- PKG-01 (review finding 7): a punch card opened for it (the card would go with the contact)
        or exists (select 1 from public.punch_cards x where x.organization_id = p_org and x.contact_id = p_id)
        -- PKG-06: named as the service recipient of a line, or the payer of a card
        or exists (select 1 from public.quote_lines x where x.organization_id = p_org and x.recipient_contact_id = p_id)
        or exists (select 1 from public.order_lines x where x.organization_id = p_org and x.recipient_contact_id = p_id)
        or exists (select 1 from public.punch_cards x where x.organization_id = p_org and x.payer_contact_id = p_id)
        -- SUB-01: a recurring billing of the contact
        or exists (select 1 from public.recurring_billings x where x.organization_id = p_org and x.contact_id = p_id)
        -- RVW-91: a message sent or received (MSG-03), or a prefill link made for it (BIZ-05), as app.sample_untouched
        or exists (select 1 from public.messages x where x.organization_id = p_org and x.contact_id = p_id)
        or exists (select 1 from app.prefill_links x where x.organization_id = p_org and x.contact_id = p_id);
  elsif p_type = 'company' then
    -- a contact, deal or company from outside this import points at it (made later, or moved onto it later)
    return exists (select 1 from public.quotes x where x.organization_id = p_org and x.company_id = p_id)
        or exists (select 1 from public.orders x where x.organization_id = p_org and x.company_id = p_id)
        or exists (select 1 from public.customer_holds x where x.organization_id = p_org and x.company_id = p_id)
        -- RVW-64 (COL-03): a payment promise on the company, or on one of its documents (its opening balance included)
        or exists (select 1 from public.payment_promises x where x.organization_id = p_org and x.company_id = p_id)
        or exists (select 1 from public.payment_promises x
                     join public.accounting_documents ad on ad.organization_id = x.organization_id and ad.id = x.document_id
                    where x.organization_id = p_org and ad.company_id = p_id)
        -- GAP-12: a company's opening balance recorded outside this import
        or exists (select 1 from public.accounting_documents x where x.organization_id = p_org and x.company_id = p_id
                     and x.import_job_id is distinct from p_job)
        or exists (select 1 from public.contacts x where x.organization_id = p_org and x.company_id = p_id
                     and x.import_job_id is distinct from p_job)
        or exists (select 1 from public.deals x where x.organization_id = p_org and x.company_id = p_id
                     and x.import_job_id is distinct from p_job)
        or exists (select 1 from public.companies x where x.organization_id = p_org and x.parent_company_id = p_id
                     and x.import_job_id is distinct from p_job)
        -- CON-05: someone linked to it, or given a role there, after the import; links of this import's own contacts
        -- (written in a later chunk of it) are not work
        or exists (select 1 from public.contact_companies x where x.organization_id = p_org and x.company_id = p_id
                     and greatest(x.created_at, x.updated_at) > p_since
                     and not exists (select 1 from public.contacts k
                                      where k.organization_id = p_org and k.id = x.contact_id and k.import_job_id = p_job))
        -- SUB-01: a recurring billing of the company
        or exists (select 1 from public.recurring_billings x where x.organization_id = p_org and x.company_id = p_id);
  elsif p_type = 'deal' then
    return exists (select 1 from public.quotes x where x.organization_id = p_org and x.deal_id = p_id)
        or exists (select 1 from public.orders x where x.organization_id = p_org and x.deal_id = p_id)
        or exists (select 1 from public.accounting_documents x where x.organization_id = p_org and x.deal_id = p_id)
        or exists (select 1 from public.payments x where x.organization_id = p_org and x.deal_id = p_id)
        or exists (select 1 from public.deal_lines x where x.organization_id = p_org and x.deal_id = p_id and x.created_at > p_since)
        or exists (select 1 from public.deal_contacts x where x.organization_id = p_org and x.deal_id = p_id and x.created_at > p_since)
        -- a follow-up deal from outside this import points at it (DEAL-11)
        or exists (select 1 from public.deals x where x.organization_id = p_org and x.previous_deal_id = p_id
                     and x.import_job_id is distinct from p_job)
        -- SUB-03: a recurring billing made from the deal
        or exists (select 1 from public.recurring_billings x where x.organization_id = p_org and x.deal_id = p_id);
  end if;
  return false;
end;
$function$
;
revoke all on function app.import_record_worked(uuid, text, uuid, timestamptz, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- RVW-92: a cycle with a document does not go back to 'due' by its status alone (021256's body plus that line)
-- ----------------------------------------------------------------------------
create or replace function app.recurring_billing_cycles_check() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_billing record;
  v_doc record;
begin
  if auth.uid() is null then
    return new;
  end if;
  if not (app.can_record_payments(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;
  if row(new.organization_id, new.billing_id, new.cycle_on, new.period_end, new.net_agorot, new.vat_agorot, new.total_agorot,
         new.vat_rate_bp, new.task_id, new.order_id, new.created_at)
     is distinct from row(old.organization_id, old.billing_id, old.cycle_on, old.period_end, old.net_agorot, old.vat_agorot,
         old.total_agorot, old.vat_rate_bp, old.task_id, old.order_id, old.created_at)
     and not (pg_trigger_depth() > 1 and ((old.task_id is not null and new.task_id is null) or (old.order_id is not null and new.order_id is null))) then
    raise exception 'a cycle keeps its date and amounts' using errcode = 'P0001', hint = 'recurring_cycle:fixed';
  end if;
  if new.accounting_document_id is distinct from old.accounting_document_id then
    if new.accounting_document_id is not null then
      select b.contact_id, b.company_id, b.deal_id into v_billing
        from public.recurring_billings b where b.organization_id = new.organization_id and b.id = new.billing_id;
      select d.contact_id, d.company_id, d.deal_id, d.status, d.doc_type,
             (select c.company_id from public.contacts c where c.organization_id = d.organization_id and c.id = d.contact_id) as contact_company
        into v_doc
        from public.accounting_documents d where d.organization_id = new.organization_id and d.id = new.accounting_document_id;
      if not found or v_doc.status <> 'active' or v_doc.doc_type not in ('tax_invoice', 'tax_invoice_receipt', 'receipt', 'proforma')
         -- review L4: the billing's own customer (a contact's own document; a company's, or one of its contacts'), not merely
         -- the same deal
         or not ((v_billing.contact_id is not null and v_doc.contact_id = v_billing.contact_id)
                 or (v_billing.company_id is not null and (v_doc.company_id = v_billing.company_id or v_doc.contact_company = v_billing.company_id))) then
        raise exception 'an active invoice or receipt of the same customer' using errcode = 'P0001', hint = 'recurring_cycle:document';
      end if;
      -- one document is the record of one cycle (the unique index holds it under races)
      if exists (select 1 from public.recurring_billing_cycles c
                  where c.organization_id = new.organization_id and c.accounting_document_id = new.accounting_document_id and c.id <> new.id) then
        raise exception 'the document is already the record of another cycle' using errcode = 'P0001', hint = 'recurring_cycle:document_used';
      end if;
      new.status := 'documented';
      new.documented_at := now();
    else
      new.documented_at := null;
      if new.status = 'documented' then
        new.status := 'due';
      end if;
    end if;
  elsif new.status is distinct from old.status then
    if new.status = 'documented' or (new.status = 'skipped' and new.accounting_document_id is not null) then
      raise exception 'a documented cycle names its document' using errcode = 'P0001', hint = 'recurring_cycle:status';
    end if;
    -- RVW-92: back to waiting only by clearing the document (the branch above), never with the document still linked
    if new.status = 'due' and new.accounting_document_id is not null then
      raise exception 'a cycle with a document goes back to waiting only when its document is removed' using errcode = 'P0001', hint = 'recurring_cycle:due_document';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.recurring_billing_cycles_check() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- RVW-93: the rep is the first usable of the deal's, the contact's and the company's owner
-- ----------------------------------------------------------------------------
-- the rep of a billing: MNY-01's owner rule (the deal's owner, else the customer's), the first of them that is an active
-- full-seat non-viewer; else the business's owner, else its oldest admin
create or replace function app.recurring_billing_rep(p_org uuid, p_billing uuid) returns uuid
language sql stable security definer
set search_path = ''
as $$
  with o as (
    select dl.owner_id as deal_owner, ct.owner_id as contact_owner, co.owner_id as company_owner
      from public.recurring_billings b
      left join public.deals dl on dl.organization_id = b.organization_id and dl.id = b.deal_id and dl.deleted_at is null
      left join public.contacts ct on ct.organization_id = b.organization_id and ct.id = b.contact_id
      left join public.companies co on co.organization_id = b.organization_id and co.id = b.company_id
     where b.organization_id = p_org and b.id = p_billing
  )
  select coalesce(
    (select m.user_id
       from o
       cross join lateral (values (1, o.deal_owner), (2, o.contact_owner), (3, o.company_owner)) as c(pos, user_id)
       join public.memberships m on m.organization_id = p_org and m.user_id = c.user_id
        and m.status = 'active' and m.role <> 'viewer' and m.seat_type = 'full'
      order by c.pos
      limit 1),
    (select m.user_id from public.memberships m
      where m.organization_id = p_org and m.status = 'active' and m.role in ('owner', 'admin')
      order by (m.role = 'owner') desc, m.created_at, m.user_id
      limit 1))
$$;
revoke all on function app.recurring_billing_rep(uuid, uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- RVW-95: the retention policy keeps a lead the customer engaged with since the cutoff (021212's body plus two lines)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.lead_retention_candidates(p_org uuid, p_cutoff timestamp with time zone, p_lead uuid DEFAULT NULL::uuid)
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select l.id
    from public.leads l
   where l.organization_id = p_org
     and (p_lead is null or l.id = p_lead)
     and l.deleted_at is null
     and l.converted_at is null
     and l.created_at < p_cutoff
     and (l.last_contacted_at is null or l.last_contacted_at < p_cutoff)
     -- sample data (USR-04) is removed by its own button, never by the policy
     and not exists (select 1 from app.sample_records s where s.organization_id = p_org and s.lead_id = l.id)
     -- contact of any author (call, message, note, meeting; private notes too) and the customer's own inquiries
     and not exists (select 1 from public.activities a
                      where a.organization_id = p_org and a.lead_id = l.id
                        and (a.type = any (app.contact_types()) or a.type = 'inquiry')
                        and (a.occurred_at >= p_cutoff or a.created_at >= p_cutoff))
     and not exists (select 1 from public.tasks t
                      where t.organization_id = p_org and t.lead_id = l.id
                        and t.deleted_at is null and t.status = 'open')
     -- a planned meeting still ahead, or any meeting that was not cancelled within the window
     and not exists (select 1 from public.meetings m
                      where m.organization_id = p_org and m.lead_id = l.id
                        and ((m.status = 'planned' and m.ends_at > now())
                             or (m.status <> 'cancelled' and m.starts_at >= p_cutoff)))
     and not exists (select 1 from app.lead_retention_keeps k
                      where k.organization_id = p_org and k.lead_id = l.id and k.kept_at >= p_cutoff)
     -- RVW-57: a restore from the bin since the cutoff counts as a keep, whoever binned and restored it
     and not exists (select 1 from public.audit_log al
                      where al.organization_id = p_org and al.entity_type = 'leads' and al.entity_id = l.id
                        and al.action = 'restore' and al.created_at >= p_cutoff)
     -- SGN-02 review 2: a lead that holds a signed document (its own, or one that names it) is kept
     and not exists (select 1 from public.signature_documents sd
                      where sd.organization_id = p_org and sd.status = 'signed'
                        and (sd.lead_id = l.id or l.id = any (sd.people)))
     -- RVW-95: the customer's own engagement since the cutoff: a library link opened (LIB-02) or a prefill form sent back
     -- (BIZ-05), both server `system` entries; contact_types() above does not hold them
     and not exists (select 1 from public.activities a
                      where a.organization_id = p_org and a.lead_id = l.id and a.type = 'system'
                        and coalesce(a.metadata ->> 'kind', '') in ('library_viewed', 'prefill_submitted')
                        and a.created_at >= p_cutoff);
$function$;
revoke all on function app.lead_retention_candidates(uuid, timestamptz, uuid) from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';
