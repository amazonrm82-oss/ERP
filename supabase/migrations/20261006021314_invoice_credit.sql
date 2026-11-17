-- =============================================================================
-- DOC-14: a credit invoice through the invoice provider, full or partial, only for the authorized, always with a reason
-- =============================================================================
-- Spec: "זיכוי מלא או חלקי, רק למורשים ותמיד עם סיבה. מפנה למסמך המקורי".
--
-- Who credits (lead's choice, owner question): app.can_issue_credits(org) = owners and admins by role, or the PRM-01 key
-- `issue_credits` ("זיכוי"), which is now built (app.member_permission_built_keys: 021296's list plus the key), in a writable
-- business with the `documents` key and a connected provider. Issuing (`issue_documents`) alone does not credit.
--
-- What is credited: one of OUR documents that the provider issued (accounting_documents.provider = the business's provider,
-- provider_document_id set), a tax invoice or a tax invoice-receipt, still active. Never more than what is left of it:
--   left = its amount - the active credit invoices that refer to it (any, also recorded by hand) - the credit requests of it
--          not yet recorded that may exist at the provider (every one but `failed`, and but an `unrecorded` one someone
--          closed as checked).
-- Judged under a lock per original (app.invoice_credit_room_of), so two credits never pass together.
-- Full = all that is left; partial = 1..left agorot. The VAT of a partial credit is the original's share (half up); the one
-- that leaves nothing takes the VAT left, so the credits never add up to more VAT than the original. A full credit of an
-- original credited for the first time copies its lines when they give back exactly its stored totals (net prices, else gross
-- prices); otherwise one line names the original. The reason is 1..500 characters, no control characters, sent to the
-- provider and kept on the request.
--
-- The path is DOC-07's (no new job kind, no new service-key function): public.invoice_credit_begin (INVOKER: the original is
-- read under the caller's RLS) hands over to app.invoice_credit_open (definer), which keeps one request per idempotency key in
-- app.invoice_issue_requests (payload doc_type 'credit_invoice', original_document_id, original_provider_document_id, the
-- original's number, reason, lines, totals) and queues the same `invoice.issue` job ({request_id}). The worker's claim
-- (021313's body) also refuses a credit whose original is no longer active or no longer the provider's
-- (invoice_credit:original); the worker calls the provider's creditDocument with the request id as its idempotency key; the
-- record (021313's body) inserts the credit invoice with original_document_id (DOC-02's rule judges it again: an active tax
-- invoice of the same customer). Every other rule of DOC-07/DOC-09/DOC-10/DOC-13 holds unchanged (retries, late lookups,
-- notices, the stale sweep, erasure, merge).
-- public.invoice_credit_room(org, document): what the credit page shows (INVOKER: the caller's RLS reads the original).
-- Privacy: app.invoice_issue_payload_erased (021297's body) also empties a credit's reason when the request is erased.
-- Safe to run twice. No drops, no row removal, no escaped code points.

-- 021296's list, plus `issue_credits` (DOC-14)
create or replace function app.member_permission_built_keys() returns text[]
language sql immutable
set search_path = ''
as $$
  select array['export', 'import', 'edit_catalog', 'manage_automations', 'view_costs', 'documents', 'record_payments', 'issue_documents',
               'issue_credits']::text[]
$$;
revoke all on function app.member_permission_built_keys() from public, anon;
grant execute on function app.member_permission_built_keys() to authenticated, service_role;

create or replace function app.can_issue_credits(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce(app.role_in(p_org)::text in ('owner', 'admin'), false) or app.has_grant(p_org, 'issue_credits');
$$;
revoke all on function app.can_issue_credits(uuid) from public, anon;
grant execute on function app.can_issue_credits(uuid) to authenticated, service_role;

-- one person who may credit here now, or 42501 / feature:documents
create or replace function app.invoice_credit_check(p_org uuid) returns void
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not (app.can_issue_credits(p_org) and app.org_writable(p_org)) then
    raise exception 'only owners, admins and holders of the credit permission credit documents' using errcode = '42501';
  end if;
  if not app.org_has_feature(p_org, 'documents') then
    raise exception 'the plan has no documents' using errcode = 'P0001', hint = 'feature:documents';
  end if;
end;
$$;
revoke all on function app.invoice_credit_check(uuid) from public, anon;
grant execute on function app.invoice_credit_check(uuid) to authenticated;

-- What is left to credit of one original, and the VAT left. Definer, members only: called with an id the caller's own RLS
-- read (the INVOKER wrappers below); schema app is not in the API.
create or replace function app.invoice_credit_room_of(p_org uuid, p_document uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_doc public.accounting_documents;
  v_credited bigint;
  v_credited_vat bigint;
  v_flight bigint;
  v_flight_vat bigint;
  v_provider text;
  v_code text;
begin
  if not app.is_member(p_org) then
    raise exception 'only members read a document' using errcode = '42501';
  end if;
  select * into v_doc from public.accounting_documents d where d.organization_id = p_org and d.id = p_document;
  if v_doc.id is null then
    raise exception 'the document is not found' using errcode = 'P0001', hint = 'invoice_credit:original';
  end if;
  v_provider := app.invoice_provider_of(p_org);
  select coalesce(sum(d.amount_agorot), 0), coalesce(sum(coalesce(d.vat_agorot, 0)), 0) into v_credited, v_credited_vat
    from public.accounting_documents d
   where d.organization_id = p_org and d.original_document_id = p_document and d.doc_type = 'credit_invoice'
     and d.status = 'active';
  select coalesce(sum((r.payload -> 'totals' ->> 'total_agorot')::bigint), 0),
         coalesce(sum((r.payload -> 'totals' ->> 'vat_agorot')::bigint), 0)
    into v_flight, v_flight_vat
    from app.invoice_issue_requests r
   where r.organization_id = p_org and r.payload ->> 'doc_type' = 'credit_invoice'
     and r.payload ->> 'original_document_id' = p_document::text
     and r.document_id is null and r.status <> 'failed'
     and not (r.status = 'unrecorded' and r.error_code = 'checked');
  v_code := case
    when v_doc.doc_type not in ('tax_invoice', 'tax_invoice_receipt') then 'type'
    when v_doc.status <> 'active' then 'cancelled'
    when v_doc.provider is null or v_doc.provider_document_id is null then 'not_issued_here'
    when v_provider is null or v_doc.provider is distinct from v_provider then 'provider'
    when v_doc.net_agorot is null or v_doc.vat_agorot is null or v_doc.vat_rate_bp is null then 'not_issued_here'
    when v_doc.amount_agorot - v_credited - v_flight <= 0 then 'nothing_left'
  end;
  return jsonb_build_object(
    'creditable', v_code is null, 'code', v_code,
    'doc_type', v_doc.doc_type, 'number', v_doc.number, 'doc_date', v_doc.doc_date,
    'amount_agorot', v_doc.amount_agorot, 'net_agorot', v_doc.net_agorot, 'vat_agorot', v_doc.vat_agorot,
    'vat_rate_bp', v_doc.vat_rate_bp,
    'credited_agorot', v_credited, 'pending_agorot', v_flight,
    'left_agorot', greatest(v_doc.amount_agorot - v_credited - v_flight, 0),
    'vat_left_agorot', greatest(coalesce(v_doc.vat_agorot, 0) - v_credited_vat - v_flight_vat, 0));
end;
$$;
revoke all on function app.invoice_credit_room_of(uuid, uuid) from public, anon;
grant execute on function app.invoice_credit_room_of(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The credit page: what is left (the caller reads the original under RLS first)
-- ----------------------------------------------------------------------------
create or replace function public.invoice_credit_room(p_org uuid, p_document uuid) returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
begin
  perform app.invoice_credit_check(p_org);
  if not exists (select 1 from public.accounting_documents d where d.organization_id = p_org and d.id = p_document) then
    raise exception 'the document is not found' using errcode = 'P0001', hint = 'invoice_credit:original';
  end if;
  return app.invoice_credit_room_of(p_org, p_document);
end;
$$;
revoke all on function public.invoice_credit_room(uuid, uuid) from public, anon;
grant execute on function public.invoice_credit_room(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Begin a credit: one request per idempotency key
-- ----------------------------------------------------------------------------
-- p_credit: {reason, amount_agorot?} (no amount, or null = all that is left)
create or replace function app.invoice_credit_open(p_org uuid, p_key uuid, p_document uuid, p_credit jsonb) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_provider text;
  v_known app.invoice_issue_requests;
  v_settings public.invoice_provider_settings;
  v_doc public.accounting_documents;
  v_room jsonb;
  v_reason text;
  v_left bigint;
  v_vat_left bigint;
  v_amount bigint;
  v_vat bigint;
  v_lines jsonb;
  v_gross boolean := false;
  v_try boolean;
  v_totals jsonb;
  v_today date;
  v_company uuid;
  v_source jsonb;
  v_payload jsonb;
  v_id uuid;
begin
  perform app.invoice_credit_check(p_org);
  if p_key is null or p_document is null then
    raise exception 'a credit needs its key and its original' using errcode = '22023';
  end if;

  -- DOC-09: one request per key; the same key again answers the first request, whatever else was sent
  perform pg_advisory_xact_lock(hashtextextended('invoice_issue:' || p_org::text || ':' || p_key::text, 0));
  select * into v_known from app.invoice_issue_requests r where r.organization_id = p_org and r.idempotency_key = p_key;
  if found then
    if v_known.requested_by is distinct from auth.uid() then
      raise exception 'this request is someone else''s' using errcode = 'P0001', hint = 'invoice:request';
    end if;
    return jsonb_build_object('status', v_known.status, 'request_id', v_known.id, 'provider', v_known.provider,
                              'document_id', v_known.document_id, 'number', v_known.number, 'code', v_known.error_code,
                              'request', v_known.payload);
  end if;

  v_provider := app.invoice_provider_of(p_org);
  if v_provider is null then
    raise exception 'the business has no connected invoice provider' using errcode = 'P0001', hint = 'invoice:not_connected';
  end if;
  if not app.invoice_provider_usable(v_provider) then
    raise exception 'this provider is not offered' using errcode = 'P0001', hint = 'invoice:provider';
  end if;
  select * into v_settings from public.invoice_provider_settings s where s.organization_id = p_org;

  if p_credit is null or jsonb_typeof(p_credit) <> 'object' then
    raise exception 'a credit is an object with its reason' using errcode = '22023';
  end if;
  v_reason := btrim(coalesce(p_credit ->> 'reason', ''));
  if v_reason = '' or char_length(v_reason) > 500 or v_reason ~ '[[:cntrl:]]' then
    raise exception 'a credit needs its reason, up to 500 characters' using errcode = 'P0001', hint = 'invoice_credit:reason';
  end if;

  -- one credit of an original at a time: what is left is judged under this lock
  perform pg_advisory_xact_lock(hashtextextended('invoice_credit:' || p_org::text || ':' || p_document::text, 0));
  select * into v_doc from public.accounting_documents d where d.organization_id = p_org and d.id = p_document for share;
  v_room := app.invoice_credit_room_of(p_org, p_document);
  if (v_room ->> 'code') = 'nothing_left' then
    raise exception 'nothing is left to credit on this document' using errcode = 'P0001', hint = 'invoice_credit:nothing_left';
  end if;
  if not (v_room ->> 'creditable')::boolean then
    raise exception 'this document is not credited through the provider' using errcode = 'P0001', hint = 'invoice_credit:original';
  end if;
  v_left := (v_room ->> 'left_agorot')::bigint;
  v_vat_left := (v_room ->> 'vat_left_agorot')::bigint;

  if p_credit -> 'amount_agorot' is null or jsonb_typeof(p_credit -> 'amount_agorot') = 'null' then
    v_amount := v_left;
  else
    begin
      v_amount := (p_credit ->> 'amount_agorot')::bigint;
    exception when others then
      raise exception 'the credit''s amount is whole agorot' using errcode = 'P0001', hint = 'invoice_credit:amount';
    end;
    if v_amount is null or v_amount < 1 or v_amount > v_left then
      raise exception 'a credit is above zero and never more than what is left' using errcode = 'P0001', hint = 'invoice_credit:amount';
    end if;
  end if;

  -- VAT: the original's share, half up; the credit that leaves nothing takes the VAT left
  if v_amount = v_left then
    v_vat := least(v_vat_left, v_amount);
  else
    v_vat := floor((2 * v_amount::numeric * v_doc.vat_agorot + v_doc.amount_agorot) / (2 * v_doc.amount_agorot))::bigint;
    v_vat := least(v_vat, v_vat_left, v_amount);
  end if;

  -- a full first credit copies the original's lines when they give back exactly its stored totals
  if v_amount = v_doc.amount_agorot then
    select coalesce(jsonb_agg(jsonb_build_object(
             'description', l.description, 'quantity', l.quantity, 'unit_price_agorot', l.unit_price_agorot,
             'discount_agorot', l.discount_agorot, 'vat_exempt', l.vat_exempt) order by l.position), '[]'::jsonb)
      into v_lines
      from public.accounting_document_lines l where l.organization_id = p_org and l.document_id = p_document;
    if jsonb_array_length(v_lines) > 0 then
      foreach v_try in array array[false, true] loop
        begin
          v_totals := app.document_totals(v_lines, v_doc.vat_rate_bp, v_try);
        exception when others then
          v_totals := null;
        end;
        if v_totals is not null and (v_totals ->> 'net_total_agorot')::bigint = v_doc.net_agorot
           and (v_totals ->> 'vat_agorot')::bigint = v_doc.vat_agorot and (v_totals ->> 'total_agorot')::bigint = v_doc.amount_agorot then
          v_gross := v_try;
          exit;
        end if;
        v_totals := null;
      end loop;
    end if;
    if v_totals is null then
      v_lines := null;
    end if;
  end if;
  if v_lines is null or v_totals is null then
    v_gross := false;
    v_lines := jsonb_build_array(jsonb_build_object(
      'description', left(case when v_amount = v_doc.amount_agorot then 'זיכוי ל' else 'זיכוי חלקי ל' end
                          || app.document_type_label(v_doc.doc_type) || ' ' || v_doc.number, 500),
      'quantity', 1, 'unit_price_agorot', v_amount - v_vat, 'discount_agorot', 0, 'vat_exempt', v_vat = 0));
  end if;

  -- the customer of the original: its deal, else its contact (the request's source, for erasure and merge)
  if v_doc.deal_id is null and v_doc.contact_id is null then
    raise exception 'a document belongs to a deal or a contact' using errcode = 'P0001', hint = 'invoice:parent';
  end if;
  if v_doc.contact_id is not null then
    select c.company_id into v_company from public.contacts c where c.organization_id = p_org and c.id = v_doc.contact_id;
  end if;
  if v_company is null and v_doc.deal_id is not null then
    select d.company_id into v_company from public.deals d where d.organization_id = p_org and d.id = v_doc.deal_id;
  end if;
  v_source := jsonb_build_object(
    'kind', case when v_doc.deal_id is not null then 'deal' else 'contact' end,
    'id', coalesce(v_doc.deal_id, v_doc.contact_id), 'deal_id', v_doc.deal_id, 'contact_id', v_doc.contact_id,
    'company_id', v_company, 'order_id', v_doc.order_id, 'quote_id', v_doc.quote_id, 'original_document_id', v_doc.id);

  v_today := (now() at time zone coalesce((select o.timezone from public.organizations o where o.id = p_org), 'Asia/Jerusalem'))::date;
  v_payload := jsonb_build_object(
    'doc_type', 'credit_invoice', 'doc_date', v_today, 'due_date', null,
    'locale', v_settings.locale, 'send_email', v_settings.provider_sends_email,
    'original_document_id', v_doc.id, 'original_provider_document_id', v_doc.provider_document_id,
    'original_number', v_doc.number, 'reason', v_reason, 'lines', v_lines,
    'totals', jsonb_build_object('net_agorot', v_amount - v_vat, 'vat_agorot', v_vat, 'total_agorot', v_amount,
                                 'rate_bp', v_doc.vat_rate_bp, 'prices_include_vat', v_gross));
  insert into app.invoice_issue_requests (organization_id, idempotency_key, requested_by, provider, source, payload)
  values (p_org, p_key, auth.uid(), v_provider, v_source, v_payload)
  returning id into v_id;
  update app.invoice_issue_requests r
     set job_id = app.enqueue_job(p_org, 'invoice.issue', jsonb_build_object('request_id', v_id::text), now())
   where r.id = v_id;
  return jsonb_build_object('status', 'pending', 'request_id', v_id, 'provider', v_provider, 'request', v_payload);
end;
$$;
revoke all on function app.invoice_credit_open(uuid, uuid, uuid, jsonb) from public, anon;
grant execute on function app.invoice_credit_open(uuid, uuid, uuid, jsonb) to authenticated;

create or replace function public.invoice_credit_begin(p_org uuid, p_key uuid, p_document uuid, p_credit jsonb) returns jsonb
language plpgsql volatile security invoker
set search_path = ''
as $$
begin
  perform app.invoice_credit_check(p_org);
  -- the original is one the caller reads (RLS), else it is not found
  if not exists (select 1 from public.accounting_documents d where d.organization_id = p_org and d.id = p_document) then
    raise exception 'the document is not found' using errcode = 'P0001', hint = 'invoice_credit:original';
  end if;
  return app.invoice_credit_open(p_org, p_key, p_document, p_credit);
end;
$$;
revoke all on function public.invoice_credit_begin(uuid, uuid, uuid, jsonb) from public, anon;
grant execute on function public.invoice_credit_begin(uuid, uuid, uuid, jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- The stored request without the customer: 021297's body, plus a credit's reason
-- ----------------------------------------------------------------------------
create or replace function app.invoice_issue_payload_erased(p_payload jsonb) returns jsonb
language sql immutable
set search_path = ''
as $$
  select case when p_payload is null or jsonb_typeof(p_payload) <> 'object' then p_payload
    else jsonb_set(
           jsonb_set(p_payload, '{customer}', '{"erased": true}'::jsonb),
           '{lines}',
           coalesce((select jsonb_agg(case when jsonb_typeof(x) = 'object'
                                           then jsonb_set(x, '{description}', to_jsonb('הפריט נמחק (מחיקת פרטיות)'::text))
                                           else x end order by n)
                       from jsonb_array_elements(case when jsonb_typeof(p_payload -> 'lines') = 'array' then p_payload -> 'lines'
                                                      else '[]'::jsonb end) with ordinality as l(x, n)), '[]'::jsonb))
         -- DOC-14: a credit's reason may name the person
         || case when p_payload ? 'reason' then jsonb_build_object('reason', 'הסיבה נמחקה (מחיקת פרטיות)') else '{}'::jsonb end
  end
$$;
revoke all on function app.invoice_issue_payload_erased(jsonb) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The worker's claim: 021313's body, plus a credit's original judged again (DOC-14)
-- ----------------------------------------------------------------------------
create or replace function public.invoice_issue_claim(p_job uuid, p_lease uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs;
  v_req app.invoice_issue_requests;
  v_code text;
  v_late boolean;
begin
  select * into v_job from app.jobs j where j.id = p_job for update;
  if v_job.id is null or v_job.kind <> 'invoice.issue' or v_job.status <> 'running' or v_job.lease_id is distinct from p_lease
     or v_job.locked_until is null or v_job.locked_until < now() then
    return jsonb_build_object('refused', 'stale');
  end if;
  if not app.job_payload_ok('invoice.issue', v_job.payload) then
    return jsonb_build_object('refused', 'invalid');
  end if;
  select * into v_req from app.invoice_issue_requests r
   where r.organization_id = v_job.organization_id and r.id = (v_job.payload ->> 'request_id')::uuid and r.job_id = v_job.id
   for update;
  if v_req.id is null then
    return jsonb_build_object('refused', 'invalid');
  end if;
  v_late := v_req.status in ('unrecorded', 'stale') and v_req.error_code in ('closed', 'stale')
            and v_req.provider_document_id is null and v_req.document_id is null and v_job.attempts > 1;
  if v_req.status <> 'pending' and not v_late then
    return jsonb_build_object('refused', 'finished', 'status', v_req.status);
  end if;
  if v_late then
    -- the worker only LOOKS UP what an earlier try may have issued with this key (never issues); nothing is looked up
    -- while the business could not record it anyway
    v_code := case
      when v_req.customer_erased_at is not null then 'customer_erased'
      when not app.invoice_provider_usable(v_req.provider) then 'invoice:provider'
      when app.invoice_provider_of(v_req.organization_id) is distinct from v_req.provider then 'invoice:not_connected'
      when not app.org_writable(v_req.organization_id) then 'org_not_writable'
      when not app.org_has_feature(v_req.organization_id, 'documents') then 'feature:documents'
    end;
    if v_code is not null then
      -- the lookup cannot be made: an earlier try may have issued it, so the people are told to check at the provider (the
      -- request leaves the late state, final, and is listed until someone closes it)
      update app.invoice_issue_requests r set status = 'unrecorded', error_code = 'check_provider', finished_at = now()
       where r.id = v_req.id;
      perform app.invoice_issue_late_notice(v_req, null, 'check_provider');
      return jsonb_build_object('refused', v_code);
    end if;
    return jsonb_build_object('request_id', v_req.id, 'provider', v_req.provider, 'request', v_req.payload, 'late', true);
  end if;
  v_code := case
    when v_req.customer_erased_at is not null then 'customer_erased'
    when not exists (select 1 from public.memberships m
                      where m.organization_id = v_req.organization_id and m.user_id = v_req.requested_by and m.status = 'active')
      then 'requester_gone'
    -- an order cancelled after begin is billed by nothing (the rule of app.invoice_source)
    when v_req.source ->> 'order_id' is not null
         and exists (select 1 from public.orders o
                      where o.organization_id = v_req.organization_id and o.id = (v_req.source ->> 'order_id')::uuid
                        and o.status = 'cancelled') then 'invoice:order_cancelled'
    -- DOC-14: a credit goes against its original only while that is still active and the provider's own document
    when v_req.payload ->> 'doc_type' = 'credit_invoice'
         and not exists (select 1 from public.accounting_documents d
                          where d.organization_id = v_req.organization_id
                            and d.id::text = v_req.payload ->> 'original_document_id'
                            and d.status = 'active' and d.doc_type in ('tax_invoice', 'tax_invoice_receipt')
                            and d.provider = v_req.provider
                            and d.provider_document_id = v_req.payload ->> 'original_provider_document_id')
      then 'invoice_credit:original'
    when not app.invoice_provider_usable(v_req.provider) then 'invoice:provider'
    when app.invoice_provider_of(v_req.organization_id) is distinct from v_req.provider then 'invoice:not_connected'
    when not app.org_writable(v_req.organization_id) then 'org_not_writable'
    when not app.org_has_feature(v_req.organization_id, 'documents') then 'feature:documents'
  end;
  if v_code is not null then
    -- the first try cannot have reached the provider; a later one may have
    update app.invoice_issue_requests r
       set status = case when v_job.attempts > 1 then 'unrecorded' else 'failed' end, error_code = v_code, finished_at = now()
     where r.id = v_req.id;
    if v_job.attempts > 1 then
      perform app.invoice_issue_late_notice(v_req, null, 'check_provider');
    end if;
    return jsonb_build_object('refused', v_code);
  end if;
  -- DOC-13: the provider's customer id kept for this customer, and whether the details it was made with are the ones sent now
  return jsonb_build_object('request_id', v_req.id, 'provider', v_req.provider, 'request', v_req.payload,
                            'provider_customer', app.invoice_provider_customer_of(v_req));
end;
$$;
revoke all on function public.invoice_issue_claim(uuid, uuid) from public, anon, authenticated;
grant execute on function public.invoice_issue_claim(uuid, uuid) to service_role;

-- ----------------------------------------------------------------------------
-- The worker's record: 021313's body, plus a credit invoice's original_document_id (DOC-14)
-- ----------------------------------------------------------------------------
create or replace function public.invoice_issue_record(p_job uuid, p_lease uuid, p_result jsonb) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs;
  v_req app.invoice_issue_requests;
  v_doc_id text;
  v_number text;
  v_allocation text;
  v_failure text;
  v_alloc jsonb;
  v_payload jsonb;
  v_totals jsonb;
  v_source jsonb;
  v_type text;
  v_id uuid;
  v_claims text;
  v_sub text;
  v_state text;
  v_hint text;
  v_code text;
  v_receipt boolean;
  v_late boolean;
begin
  select * into v_job from app.jobs j where j.id = p_job for update;
  if v_job.id is null or v_job.kind <> 'invoice.issue' or v_job.status <> 'running' or v_job.lease_id is distinct from p_lease
     or v_job.locked_until is null or v_job.locked_until < now() then
    return jsonb_build_object('status', 'stale');
  end if;
  select * into v_req from app.invoice_issue_requests r
   where r.organization_id = v_job.organization_id and r.id = (v_job.payload ->> 'request_id')::uuid and r.job_id = v_job.id
   for update;
  if v_req.id is null then
    return jsonb_build_object('status', 'stale');
  end if;
  if p_result is null or jsonb_typeof(p_result) <> 'object' or jsonb_typeof(p_result -> 'ok') is distinct from 'boolean' then
    raise exception 'the provider''s answer is ok or a failure' using errcode = '22023';
  end if;
  -- DOC-13: the provider's customer id the worker got (made or updated at the provider), kept with the details it was sent
  -- (whatever the provider answered about the document next; never raises)
  if jsonb_typeof(p_result -> 'provider_customer_id') = 'string' then
    perform app.invoice_provider_customer_keep(v_req, p_result ->> 'provider_customer_id');
  end if;
  -- a request closed by hand or marked stale after an earlier try (its late call is a LOOKUP only, never a new issue): what
  -- the provider holds is still kept (recorded when the business can record), never lost; any other ended request answers
  -- what it holds
  v_late := v_req.status in ('unrecorded', 'stale') and v_req.error_code in ('closed', 'stale')
            and v_req.document_id is null and v_req.provider_document_id is null;
  if v_req.status <> 'pending' and not v_late then
    return jsonb_build_object('status', v_req.status, 'document_id', v_req.document_id, 'number', v_req.number,
                              'code', v_req.error_code);
  end if;

  if not (p_result ->> 'ok')::boolean then
    v_code := coalesce(substring(coalesce(p_result ->> 'code', '') from '^[A-Za-z0-9_.:-]{1,64}$'), 'provider_error');
    if v_late then
      -- the lookup found nothing (not_at_provider): the closed request stays as it is, final, no notice
      if jsonb_typeof(p_result -> 'final') = 'boolean' and (p_result ->> 'final')::boolean then
        if v_code = 'not_at_provider' then
          return jsonb_build_object('status', v_req.status, 'code', v_req.error_code);
        end if;
        -- any other final refusal of the lookup (a refused key, a changed provider): nobody knows, so the people are told
        update app.invoice_issue_requests r set status = 'unrecorded', error_code = 'check_provider', finished_at = now()
         where r.id = v_req.id;
        perform app.invoice_issue_late_notice(v_req, null, 'check_provider');
        return jsonb_build_object('status', 'unrecorded', 'code', 'check_provider');
      end if;
      -- the lookup did not get an answer: tried again with the same key; on the queue's last try the people are told
      if v_job.attempts >= app.job_max_attempts() then
        update app.invoice_issue_requests r set status = 'unrecorded', error_code = 'check_provider', finished_at = now()
         where r.id = v_req.id;
        perform app.invoice_issue_late_notice(v_req, null, 'check_provider');
        return jsonb_build_object('status', 'unrecorded', 'code', 'check_provider');
      end if;
      return jsonb_build_object('status', 'pending', 'code', v_code);
    end if;
    if jsonb_typeof(p_result -> 'final') = 'boolean' and (p_result ->> 'final')::boolean then
      -- after an earlier try (the claim's rule) a refusal now does not prove the earlier one issued nothing: kept
      -- unrecorded with its code, told, and listed until someone closes it
      if v_job.attempts > 1 then
        update app.invoice_issue_requests r set status = 'unrecorded', error_code = v_code, finished_at = now()
         where r.id = v_req.id;
        perform app.invoice_issue_late_notice(v_req, null, 'check_provider');
        return jsonb_build_object('status', 'unrecorded', 'code', v_code);
      end if;
      update app.invoice_issue_requests r set status = 'failed', error_code = v_code, finished_at = now() where r.id = v_req.id;
      return jsonb_build_object('status', 'failed', 'code', v_code);
    end if;
    -- nothing is known to have happened at the provider: the queue tries again with the same key, until its last try
    if v_job.attempts >= app.job_max_attempts() then
      update app.invoice_issue_requests r set status = 'unrecorded', error_code = 'retries_spent', finished_at = now()
       where r.id = v_req.id;
      -- a timeout or an unreachable provider may still have issued it
      perform app.invoice_issue_late_notice(v_req, null, 'check_provider');
      return jsonb_build_object('status', 'unrecorded', 'code', 'retries_spent');
    end if;
    update app.invoice_issue_requests r set error_code = v_code where r.id = v_req.id;
    return jsonb_build_object('status', 'pending', 'code', v_code);
  end if;

  v_doc_id := btrim(coalesce(p_result ->> 'provider_document_id', ''));
  v_number := btrim(coalesce(p_result ->> 'number', ''));
  -- DOC-10: the provider's allocation outcome (a number, a failure with a code from the closed list, or not needed); a
  -- worker built before DOC-10 sends allocation_number / allocation_failure (the provider's words, kept as 'other')
  v_alloc := p_result -> 'allocation';
  if v_alloc is not null and jsonb_typeof(v_alloc) <> 'null' then
    -- an outcome that cannot be read is never refused (the provider already issued the document): marked 'other'
    if jsonb_typeof(v_alloc) <> 'object' or coalesce(v_alloc ->> 'status', '') not in ('allocated', 'failed', 'not_needed')
       or (v_alloc ->> 'status' = 'allocated' and jsonb_typeof(v_alloc -> 'number') is distinct from 'string')
       or (v_alloc ->> 'status' = 'failed' and jsonb_typeof(v_alloc -> 'code') is distinct from 'string') then
      v_allocation := null;
      v_failure := 'other';
    else
      v_allocation := case when v_alloc ->> 'status' = 'allocated' then btrim(v_alloc ->> 'number') end;
      v_failure := case when v_alloc ->> 'status' = 'failed' then v_alloc ->> 'code' end;
    end if;
  else
    v_allocation := nullif(btrim(coalesce(p_result ->> 'allocation_number', '')), '');
    v_failure := nullif(btrim(coalesce(p_result ->> 'allocation_failure', '')), '');
  end if;
  if v_failure is not null and not (v_failure = any (app.allocation_failure_codes())) then
    v_failure := 'other';
  end if;
  if char_length(v_doc_id) not between 1 and 200 or char_length(v_number) not between 1 and 40
     or v_doc_id ~ '[[:cntrl:]]' or v_number ~ '[[:cntrl:]]' then
    raise exception 'the provider''s answer is an id and a number' using errcode = '22023';
  end if;
  v_payload := v_req.payload;
  v_totals := v_payload -> 'totals';
  v_source := v_req.source;
  v_type := v_payload ->> 'doc_type';
  v_receipt := v_type = 'receipt';
  -- only a tax invoice or a tax invoice-receipt carries an allocation number or its failure (the provider decided whether one
  -- was needed: nothing here compares the amount with a threshold); a number that is not digits is marked, never kept
  if v_type not in ('tax_invoice', 'tax_invoice_receipt') then
    v_allocation := null;
    v_failure := null;
  elsif v_allocation is not null and v_allocation !~ '^[0-9]{1,20}$' then
    v_allocation := null;
    v_failure := 'invalid_number';
  elsif v_allocation is not null then
    v_failure := null;
  end if;

  -- the provider issued it; a business that can no longer record keeps it on the request, and nothing is ever recorded in
  -- the name of someone who is no longer an active member
  v_code := case when not app.org_writable(v_req.organization_id) then 'org_not_writable'
                 when not app.org_has_feature(v_req.organization_id, 'documents') then 'feature:documents'
                 when not exists (select 1 from public.memberships m
                                   where m.organization_id = v_req.organization_id and m.user_id = v_req.requested_by
                                     and m.status = 'active') then 'requester_gone' end;
  if v_code is not null then
    if v_late then
      v_code := 'issued_after_close';
      perform app.invoice_issue_late_notice(v_req, v_number, 'after_close');
    elsif v_code = 'requester_gone' then
      perform app.invoice_issue_late_notice(v_req, v_number, 'not_recorded');
    else
      perform app.invoice_issue_late_notice(v_req, v_number, 'cannot_record');
    end if;
    update app.invoice_issue_requests r
       set status = 'unrecorded', provider_document_id = v_doc_id, number = v_number, allocation_number = v_allocation,
           allocation_failure = v_failure, finished_at = now(), error_code = v_code
     where r.id = v_req.id;
    return jsonb_build_object('status', 'unrecorded', 'number', v_number, 'code', v_code);
  end if;

  v_claims := current_setting('request.jwt.claims', true);
  v_sub := current_setting('request.jwt.claim.sub', true);
  begin
    -- DOC-02's triggers see the server: no person's claims during the insert (a failure below rolls the setting back)
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    insert into public.accounting_documents
      (organization_id, deal_id, contact_id, order_id, quote_id, original_document_id, doc_type, number, doc_date,
       amount_agorot, due_date, allocation_number, allocation_failed_at, allocation_error_code, net_agorot, vat_agorot,
       vat_rate_bp, provider, provider_document_id, created_by)
    values
      (v_req.organization_id, (v_source ->> 'deal_id')::uuid, (v_source ->> 'contact_id')::uuid, (v_source ->> 'order_id')::uuid,
       (v_source ->> 'quote_id')::uuid,
       -- DOC-14: a credit invoice refers to its original (null on every other type)
       case when v_type = 'credit_invoice' then (v_payload ->> 'original_document_id')::uuid end,
       v_type, v_number, (v_payload ->> 'doc_date')::date,
       (v_totals ->> 'total_agorot')::bigint, (v_payload ->> 'due_date')::date, v_allocation,
       case when v_failure is not null then now() end, v_failure,
       -- a receipt is the money received: no VAT split (TAX-01)
       case when v_receipt then null else (v_totals ->> 'net_agorot')::bigint end,
       case when v_receipt then null else (v_totals ->> 'vat_agorot')::bigint end,
       case when v_receipt then null else (v_totals ->> 'rate_bp')::integer end,
       v_req.provider, v_doc_id, v_req.requested_by)
    returning id into v_id;
    insert into public.accounting_document_lines
      (organization_id, document_id, position, description, quantity, unit_price_agorot, discount_agorot, vat_exempt, created_by)
    select v_req.organization_id, v_id, x.n::integer, x.line ->> 'description', (x.line ->> 'quantity')::numeric,
           (x.line ->> 'unit_price_agorot')::bigint, (x.line ->> 'discount_agorot')::bigint,
           (x.line ->> 'vat_exempt')::boolean, v_req.requested_by
      from jsonb_array_elements(v_payload -> 'lines') with ordinality as x(line, n);
    -- the audit names who issued: the entries this transaction wrote for the document and its lines, without an actor
    update public.audit_log a
       set actor_id = v_req.requested_by
     where a.organization_id = v_req.organization_id and a.actor_id is null and a.created_at = now()
       and ((a.entity_type = 'accounting_documents' and a.entity_id = v_id)
            or (a.entity_type = 'accounting_document_lines'
                and a.entity_id in (select l.id from public.accounting_document_lines l
                                     where l.organization_id = v_req.organization_id and l.document_id = v_id)));
    if v_claims is not null then
      perform set_config('request.jwt.claims', v_claims, true);
    end if;
    if v_sub is not null then
      perform set_config('request.jwt.claim.sub', v_sub, true);
    end if;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    -- a deadlock, a serialization failure or a lock not taken: the queue tries again (same key, nothing lost)
    if v_state in ('40P01', '40001', '55P03') then
      raise;
    end if;
    perform app.invoice_issue_late_notice(v_req, v_number, case when v_late then 'after_close' else 'cannot_record' end);
    v_code := left(coalesce(nullif(v_hint, ''), v_state), 64);
    update app.invoice_issue_requests r
       set status = 'unrecorded', provider_document_id = v_doc_id, number = v_number, allocation_number = v_allocation,
           allocation_failure = v_failure, finished_at = now(), error_code = v_code
     where r.id = v_req.id;
    return jsonb_build_object('status', 'unrecorded', 'number', v_number, 'code', v_code);
  end;

  update app.invoice_issue_requests r
     set status = 'issued', document_id = v_id, provider_document_id = v_doc_id, number = v_number,
         allocation_number = v_allocation, allocation_failure = v_failure, finished_at = now(), error_code = null
   where r.id = v_req.id;
  return jsonb_build_object('status', 'issued', 'document_id', v_id, 'number', v_number);
end;
$$;
revoke all on function public.invoice_issue_record(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.invoice_issue_record(uuid, uuid, jsonb) to service_role;
