-- =============================================================================
-- DOC-13: the customer at the invoice provider, made when needed, its id kept here; Mexuz is the source of the details
-- =============================================================================
-- Spec: "לקוח ומוצר נוצרים אצל הספק בעת הצורך, והמזהה שלהם נשמר אצלנו. Mexuz היא המקור לפרטי הלקוח".
--
-- * app.invoice_provider_customers (schema app: RLS on, no grants): one row per business, provider and customer (a contact,
--   or a company: the request's customer.external_ref, "contact:<id>" | "company:<id>"), holding the provider's customer id
--   and the SHA-256 of the customer block it was last sent with (app.invoice_customer_details_hash). Composite foreign keys
--   cascade with the contact or company, so a purge (and a merge's removal of the duplicate) takes the row; it holds ids and a
--   hash only, nothing personal.
-- * public.invoice_issue_claim (021297's body) also answers `provider_customer`: null when nothing is kept for this customer and
--   provider (or the request has no customer of ours), else {id, current} where current = the kept hash equals the hash of the
--   customer block this request sends (app.invoice_provider_customer_of). The worker (issue-handler.ts) calls the provider's
--   upsertCustomer with our details whenever there is no id or current is false, so our details always win and are re-sent
--   when they changed; with a current id it sends the document on that customer without asking again.
-- * public.invoice_issue_record (021310's body) keeps `provider_customer_id` from the worker's answer (ok or not: an upsert
--   that worked is kept even when the document then failed) through app.invoice_provider_customer_keep, which never raises
--   and skips an erased request, a customer that is gone, or an id that is not a provider code.
-- Products: the provider contract (src/features/invoicing/providers/types.ts) has no product call, so no product is made at
-- the provider; documents go with their lines' texts and prices (a follow-up once a real provider's contract needs it).
-- The queue still holds the request id only; no new job kind, no new service-key function. Safe to run twice.

create table if not exists app.invoice_provider_customers (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations (id) on delete cascade,
  provider              text not null check (provider ~ '^[a-z][a-z0-9_]{1,39}$'),
  contact_id            uuid,
  company_id            uuid,
  provider_customer_id  text not null check (provider_customer_id ~ '^[A-Za-z0-9_.:-]{1,200}$'),
  details_sha256        text not null check (details_sha256 ~ '^[0-9a-f]{64}$'),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (organization_id, id),
  constraint invoice_provider_customers_one check ((contact_id is null) <> (company_id is null)),
  constraint invoice_provider_customers_contact_fk foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id) on delete cascade,
  constraint invoice_provider_customers_company_fk foreign key (organization_id, company_id)
    references public.companies (organization_id, id) on delete cascade
);
create unique index if not exists invoice_provider_customers_contact_once
  on app.invoice_provider_customers (organization_id, provider, contact_id) where contact_id is not null;
create unique index if not exists invoice_provider_customers_company_once
  on app.invoice_provider_customers (organization_id, provider, company_id) where company_id is not null;
create index if not exists invoice_provider_customers_contact_idx
  on app.invoice_provider_customers (organization_id, contact_id) where contact_id is not null;
create index if not exists invoice_provider_customers_company_idx
  on app.invoice_provider_customers (organization_id, company_id) where company_id is not null;
alter table app.invoice_provider_customers enable row level security;
revoke all on app.invoice_provider_customers from public, anon, authenticated, service_role;

-- The customer block as the request sends it (jsonb's own text form: keys in a fixed order), hashed
create or replace function app.invoice_customer_details_hash(p_customer jsonb) returns text
language sql immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(coalesce(p_customer, 'null'::jsonb)::text, 'UTF8')), 'hex')
$$;
revoke all on function app.invoice_customer_details_hash(jsonb) from public, anon, authenticated, service_role;

-- {id, current} for the request's customer at its provider, or null
create or replace function app.invoice_provider_customer_of(p_req app.invoice_issue_requests) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_ref text := p_req.payload -> 'customer' ->> 'external_ref';
  v_row app.invoice_provider_customers;
begin
  if p_req.customer_erased_at is not null or v_ref is null
     or v_ref !~ '^(contact|company):[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return null;
  end if;
  if split_part(v_ref, ':', 1) = 'contact' then
    select * into v_row from app.invoice_provider_customers c
     where c.organization_id = p_req.organization_id and c.provider = p_req.provider
       and c.contact_id = split_part(v_ref, ':', 2)::uuid;
  else
    select * into v_row from app.invoice_provider_customers c
     where c.organization_id = p_req.organization_id and c.provider = p_req.provider
       and c.company_id = split_part(v_ref, ':', 2)::uuid;
  end if;
  if v_row.id is null then
    return null;
  end if;
  return jsonb_build_object('id', v_row.provider_customer_id,
                            'current', v_row.details_sha256 = app.invoice_customer_details_hash(p_req.payload -> 'customer'));
end;
$$;
revoke all on function app.invoice_provider_customer_of(app.invoice_issue_requests) from public, anon, authenticated, service_role;

-- Keeps the provider's customer id for the request's customer, with the hash of the details sent; never raises
create or replace function app.invoice_provider_customer_keep(p_req app.invoice_issue_requests, p_id text) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_ref text := p_req.payload -> 'customer' ->> 'external_ref';
  v_target uuid;
  v_hash text;
begin
  if p_id is null or p_id !~ '^[A-Za-z0-9_.:-]{1,200}$' or p_req.customer_erased_at is not null or v_ref is null
     or v_ref !~ '^(contact|company):[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return;
  end if;
  v_target := split_part(v_ref, ':', 2)::uuid;
  v_hash := app.invoice_customer_details_hash(p_req.payload -> 'customer');
  begin
    if split_part(v_ref, ':', 1) = 'contact' then
      insert into app.invoice_provider_customers (organization_id, provider, contact_id, provider_customer_id, details_sha256)
      select p_req.organization_id, p_req.provider, v_target, p_id, v_hash
       where exists (select 1 from public.contacts c where c.organization_id = p_req.organization_id and c.id = v_target)
      on conflict (organization_id, provider, contact_id) where contact_id is not null
      do update set provider_customer_id = excluded.provider_customer_id, details_sha256 = excluded.details_sha256,
                    updated_at = now();
    else
      insert into app.invoice_provider_customers (organization_id, provider, company_id, provider_customer_id, details_sha256)
      select p_req.organization_id, p_req.provider, v_target, p_id, v_hash
       where exists (select 1 from public.companies co where co.organization_id = p_req.organization_id and co.id = v_target)
      on conflict (organization_id, provider, company_id) where company_id is not null
      do update set provider_customer_id = excluded.provider_customer_id, details_sha256 = excluded.details_sha256,
                    updated_at = now();
    end if;
  exception when others then
    -- a deadlock or a serialization failure is the queue's to retry; anything else only loses the kept id (the next
    -- request asks the provider again)
    if sqlstate in ('40P01', '40001') then
      raise;
    end if;
  end;
end;
$$;
revoke all on function app.invoice_provider_customer_keep(app.invoice_issue_requests, text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The worker's claim: 021297's body, plus `provider_customer` (DOC-13)
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
-- The worker's record: 021310's body, plus the provider's customer id kept (DOC-13)
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
