-- =============================================================================
-- DOC-10: the allocation number, and a provider's failure to get one
-- =============================================================================
-- Spec: "מספר הקצאה מוצג על המסמך. כשהספק מחזיר כישלון בקבלת מספר, המסמך מסומן והסיבה מוצגת. המערכת לא מחשבת את הסף
-- בעצמה; הספק אחראי לכך."
--
-- The provider contract (src/features/invoicing/providers/types.ts) answers, with every issued document, one allocation
-- outcome: {status: 'allocated', number}, {status: 'failed', code} with a code from a CLOSED list, or {status: 'not_needed'}.
-- Whether a document needs a number (the Tax Authority's threshold) is the provider's call only: nothing here compares an
-- amount with anything. The system only keeps what the provider said:
--   * accounting_documents.allocation_failed_at / allocation_error_code: server only (no client grant; a person's insert or
--     change through any path is refused, trigger accounting_documents_allocation_failure); both or neither; only on a tax
--     invoice or a tax invoice-receipt without an allocation number; the code from app.allocation_failure_codes() =
--     ALLOCATION_FAILURE_CODES (unit test reads this file). Frozen once written, for every writer: a number the provider
--     gets later (DOC-11's sync) is a follow-up, and needs its own rule here.
--   * public.invoice_issue_record (021297's body; DOC-07's every rule kept) reads the new `allocation` object of the worker's
--     answer, or, from a worker built before DOC-10, the old allocation_number / allocation_failure keys (free words become
--     'other'); an outcome it cannot read (an unknown status, a missing or bad field) never refuses the answer, since the
--     provider has already issued the document: it marks it 'other'; a provider that says "allocated" with a number that is
--     not digits marks the document 'invalid_number'; a
--     receipt or a proforma keeps neither. The request row keeps the code in allocation_failure. Re-pinned in test 381.
-- Safe to run twice.

create or replace function app.allocation_failure_codes() returns text[]
language sql immutable
set search_path = ''
as $$
  select array['tax_authority_refused', 'tax_authority_unavailable', 'customer_tax_id', 'business_not_authorized',
               'invalid_number', 'other']::text[]
$$;
revoke all on function app.allocation_failure_codes() from public, anon, authenticated, service_role;

alter table public.accounting_documents add column if not exists allocation_failed_at timestamptz;
alter table public.accounting_documents add column if not exists allocation_error_code text;

alter table public.accounting_documents drop constraint if exists accounting_documents_allocation_failure_shape;
alter table public.accounting_documents add constraint accounting_documents_allocation_failure_shape check (
  (allocation_failed_at is null) = (allocation_error_code is null)
  and (allocation_error_code is null
       or (doc_type in ('tax_invoice', 'tax_invoice_receipt') and allocation_number is null
           and allocation_error_code in ('tax_authority_refused', 'tax_authority_unavailable', 'customer_tax_id',
                                         'business_not_authorized', 'invalid_number', 'other')))) not valid;
alter table public.accounting_documents validate constraint accounting_documents_allocation_failure_shape;

-- the mark is the provider layer's (no session) and is written with the document only: a person never writes it, and
-- nobody changes it afterwards
create or replace function app.accounting_documents_allocation_failure() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null and (new.allocation_failed_at is not null or new.allocation_error_code is not null) then
      raise exception 'only the provider layer marks an allocation failure' using errcode = 'P0001', hint = 'document:provider';
    end if;
  elsif row(new.allocation_failed_at, new.allocation_error_code) is distinct from row(old.allocation_failed_at, old.allocation_error_code) then
    raise exception 'a recorded document does not change; cancel it instead' using errcode = 'P0001', hint = 'document:frozen';
  end if;
  return new;
end;
$$;
revoke all on function app.accounting_documents_allocation_failure() from public, anon, authenticated;

create or replace trigger accounting_documents_allocation_failure
  before insert or update of allocation_failed_at, allocation_error_code on public.accounting_documents
  for each row execute function app.accounting_documents_allocation_failure();

-- ----------------------------------------------------------------------------
-- The worker's record of the provider's answer: 021297's body, with DOC-10's allocation outcome
-- ----------------------------------------------------------------------------
-- p_result is {ok: true, provider_document_id, number, allocation?: {status: allocated|failed|not_needed, number?, code?}}
-- (or, from a worker built before DOC-10, allocation_number? / allocation_failure?) or {ok: false, code, final}.
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
      (organization_id, deal_id, contact_id, order_id, quote_id, doc_type, number, doc_date, amount_agorot, due_date,
       allocation_number, allocation_failed_at, allocation_error_code, net_agorot, vat_agorot, vat_rate_bp, provider,
       provider_document_id, created_by)
    values
      (v_req.organization_id, (v_source ->> 'deal_id')::uuid, (v_source ->> 'contact_id')::uuid, (v_source ->> 'order_id')::uuid,
       (v_source ->> 'quote_id')::uuid, v_type, v_number, (v_payload ->> 'doc_date')::date,
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
