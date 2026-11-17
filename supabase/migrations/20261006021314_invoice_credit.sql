-- =============================================================================
-- DOC-14: a credit invoice through the invoice provider, full or partial, only for the authorized, always with a reason
-- =============================================================================
-- Spec: "זיכוי מלא או חלקי, רק למורשים ותמיד עם סיבה. מפנה למסמך המקורי".
--
-- Who credits (owner (408) ד): app.can_issue_credits(org) = owners and admins by role; anyone else needs BOTH PRM-01 keys
-- `issue_documents` and `issue_credits` ("זיכוי", now built: app.member_permission_built_keys, 021296's list plus the key),
-- in a writable business with the `documents` key and a connected provider.
-- The reason (owner (409) ב) is also kept on the recorded credit invoice: accounting_documents.credit_reason (server only,
-- credit invoices only, frozen; trigger accounting_documents_credit_reason, hint document:provider|frozen), replaced by the
-- neutral text when a privacy erasure neutralises the document's lines (trigger accounting_document_lines_credit_reason_erase,
-- under app.audit_erase_core's app.document_server = 'erase'); the document's audit entries are erased with the rest.
-- Mixed originals (owner (411) ב): when the original's lines mix exempt and taxable ones, a partial credit is made of chosen
-- lines (p_credit.lines [{line_id, amount_agorot?}], each 1..what is left of that line, in the original's price mode); the
-- credit's lines are those lines (accounting_document_lines.credited_line_id names the original line), so the VAT follows them
-- and app.document_totals over them is the recorded totals. What is left of a line = its total - the lines of active credit
-- invoices that name it - the lines of reserving requests that name it. A credit that names no line (recorded by hand, or a
-- rest made by amount) counts only against the whole document (what is left and the VAT left), never against a line. A full
-- credit of a mixed original takes every line's remaining part when that is exactly what is left, else the amount lines below.
-- A non-mixed original is credited by amount.
--
-- What is credited: one of OUR documents that the provider issued (accounting_documents.provider = the business's provider,
-- provider_document_id set), a tax invoice or a tax invoice-receipt, still active. Never more than what is left of it:
--   left = its amount - the active credit invoices that refer to it (any, also recorded by hand) - the credit requests of it
--          that RESERVE their amount (app.invoice_credit_reserves).
-- A credit request reserves its amount only while it may still exist at the provider and is not recorded: pending; or ended
-- after a try may have reached the provider (unrecorded / stale with any code, the worker's late lookup still possible).
-- It stops reserving when it is known never issued (failed; closed or marked stale before any try of its job was claimed,
-- whose claim then answers `finished`; a late lookup that answered not_at_provider, stamped provider_absent_at by the
-- record), when it is recorded (document_id, or the same provider document recorded by hand: an active credit invoice of the
-- same original with the provider's number), or when an owner/admin releases it after checking at the provider
-- (public.invoice_credit_release, credit_released_at). Only owners and admins mark a credit request `checked`
-- (public.invoice_issue_close, hint invoice_credit:check_admin); issue requests keep 021297's rule.
-- Judged under a lock per original, taken by app.invoice_credit_open and by trigger accounting_documents_credit_lock on every
-- insert of a credit invoice that names an original (by hand too), so a credit is never judged beside a racing one.
-- VAT: a recorded credit without a VAT split (recorded by hand) counts the original's VAT share of its amount (half up).
-- Full = all that is left; partial = 1..left agorot. The VAT aimed at is the original's share of the amount (half up), the
-- VAT left for the credit that leaves nothing, never above the VAT left. A full credit of an original credited for the first
-- time copies its lines when they give back exactly its stored totals (net prices, else gross prices); otherwise
-- app.invoice_credit_lines builds one taxable line and one exempt line so that app.document_totals over them gives exactly
-- the request's net, VAT and total (the VAT lowered by the fewest agorot when the amount cannot carry the aimed VAT at the
-- original's rate: never more VAT than aimed). The reason is 1..500 characters on one line (runs of white space fold into one
-- space), sent to the provider and kept on the request.
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

alter table app.invoice_issue_requests add column if not exists provider_absent_at timestamptz;
alter table app.invoice_issue_requests add column if not exists credit_released_at timestamptz;

-- owner (409) ב: the credit's reason, kept on the recorded credit invoice (server only: no client insert or update grant;
-- frozen; a privacy erasure replaces it with the neutral text)
alter table public.accounting_documents add column if not exists credit_reason text;
alter table public.accounting_documents drop constraint if exists accounting_documents_credit_reason_shape;
alter table public.accounting_documents add constraint accounting_documents_credit_reason_shape check (
  credit_reason is null or (doc_type = 'credit_invoice' and char_length(credit_reason) between 1 and 500)) not valid;
alter table public.accounting_documents validate constraint accounting_documents_credit_reason_shape;

create or replace function app.accounting_documents_credit_reason() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null and new.credit_reason is not null then
      raise exception 'only the provider layer writes a credit''s reason' using errcode = 'P0001', hint = 'document:provider';
    end if;
  elsif new.credit_reason is distinct from old.credit_reason
        and not (current_setting('app.document_server', true) = 'erase' and new.credit_reason = 'הסיבה נמחקה (מחיקת פרטיות)') then
    raise exception 'a recorded document does not change; cancel it instead' using errcode = 'P0001', hint = 'document:frozen';
  end if;
  return new;
end;
$$;
revoke all on function app.accounting_documents_credit_reason() from public, anon, authenticated;

create or replace trigger accounting_documents_credit_reason
  before insert or update of credit_reason on public.accounting_documents
  for each row execute function app.accounting_documents_credit_reason();

-- A privacy erasure reaches a credit's reason with its lines: app.audit_erase_core neutralises the lines of every document it
-- reaches under app.document_server = 'erase' (a document recorded through the provider always has lines), and every audit
-- entry of those documents is erased with the rest
create or replace function app.accounting_document_lines_credit_reason_erase() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if current_setting('app.document_server', true) = 'erase' then
    update public.accounting_documents d
       set credit_reason = 'הסיבה נמחקה (מחיקת פרטיות)'
     where d.organization_id = new.organization_id and d.id = new.document_id and d.credit_reason is not null
       and d.credit_reason <> 'הסיבה נמחקה (מחיקת פרטיות)';
  end if;
  return null;
end;
$$;
revoke all on function app.accounting_document_lines_credit_reason_erase() from public, anon, authenticated, service_role;

create or replace trigger accounting_document_lines_credit_reason_erase
  after update of description on public.accounting_document_lines
  for each row when (new.description = 'הפריט נמחק (מחיקת פרטיות)' and old.description is distinct from new.description)
  execute function app.accounting_document_lines_credit_reason_erase();

-- owner (411) ב: a credit invoice's line names the original's line it credits (server only, set by the worker's record)
alter table public.accounting_document_lines add column if not exists credited_line_id uuid;
alter table public.accounting_document_lines drop constraint if exists accounting_document_lines_credited_line_fk;
alter table public.accounting_document_lines add constraint accounting_document_lines_credited_line_fk
  foreign key (organization_id, credited_line_id) references public.accounting_document_lines (organization_id, id)
  on delete set null (credited_line_id);
create index if not exists accounting_document_lines_credited_idx
  on public.accounting_document_lines (organization_id, credited_line_id);

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
  -- owner (408) ד: owners and admins by role; anyone else needs both keys, issuing and crediting
  select coalesce(app.role_in(p_org)::text in ('owner', 'admin'), false)
      or (app.has_grant(p_org, 'issue_documents') and app.has_grant(p_org, 'issue_credits'));
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

-- Whether a credit request still reserves its amount (see the header); p_attempts = its job's attempts (null = no job)
create or replace function app.invoice_credit_reserves(p_req app.invoice_issue_requests, p_attempts integer) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_req.payload ->> 'doc_type' = 'credit_invoice'
     and p_req.document_id is null and p_req.credit_released_at is null and p_req.provider_absent_at is null
     and case
       when p_req.status = 'pending' then true
       when p_req.status in ('failed', 'issued') then false
       -- the provider's document recorded by hand: an active credit invoice of the same original with its number
       when p_req.provider_document_id is not null then not exists (
         select 1 from public.accounting_documents d
          where d.organization_id = p_req.organization_id and d.doc_type = 'credit_invoice' and d.status = 'active'
            and d.original_document_id::text = p_req.payload ->> 'original_document_id'
            and (d.provider_document_id = p_req.provider_document_id or d.number = p_req.number))
       -- closed or marked stale before any try of its job was claimed: its claim answers `finished`, nothing is sent
       when p_req.error_code in ('closed', 'stale') and coalesce(p_attempts, 0) = 0 then false
       -- someone (an owner or admin, for a credit) checked at the provider
       when p_req.status = 'unrecorded' and p_req.error_code = 'checked' then false
       else true
     end
$$;
revoke all on function app.invoice_credit_reserves(app.invoice_issue_requests, integer) from public, anon, authenticated, service_role;

-- The credit's lines: one taxable line and one exempt line whose app.document_totals (net prices) is exactly the amount, with
-- the aimed VAT, else the nearest lower VAT the amount can carry at the rate. Answers {lines, totals}.
create or replace function app.invoice_credit_lines(p_amount bigint, p_vat bigint, p_rate integer, p_label text) returns jsonb
language plpgsql immutable
set search_path = ''
as $$
declare
  v_rate integer := coalesce(p_rate, 0);
  v_vat bigint;
  v_taxable bigint;
  v_exempt bigint;
  v_lines jsonb := '[]'::jsonb;
  v_totals jsonb;
begin
  if p_amount is null or p_amount < 1 then
    raise exception 'a credit is above zero' using errcode = 'P0001', hint = 'invoice_credit:amount';
  end if;
  if v_rate <= 0 then
    v_vat := 0;
    v_taxable := p_amount;
  else
    v_vat := greatest(least(coalesce(p_vat, 0), p_amount), 0);
    loop
      -- the largest taxable amount whose VAT (half up, as app.document_totals) is v_vat, within the amount
      v_taxable := least(ceil((2 * v_vat + 1) * 5000::numeric / v_rate)::bigint - 1, p_amount - v_vat);
      exit when v_taxable >= 0 and div(2 * v_taxable::numeric * v_rate + 10000, 20000) = v_vat;
      v_vat := v_vat - 1;
    end loop;
  end if;
  -- no VAT at all on a rate above zero: the credit is exempt (never a tiny taxable line)
  if v_rate > 0 and v_vat = 0 then
    v_taxable := 0;
  end if;
  v_exempt := p_amount - v_vat - v_taxable;
  if v_taxable > 0 or v_exempt = 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'description', left(p_label, 500), 'quantity', 1, 'unit_price_agorot', v_taxable, 'discount_agorot', 0, 'vat_exempt', false));
  end if;
  if v_exempt > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'description', left(p_label || ' (פטור ממע"מ)', 500), 'quantity', 1, 'unit_price_agorot', v_exempt, 'discount_agorot', 0,
      'vat_exempt', true));
  end if;
  v_totals := app.document_totals(v_lines, v_rate, false);
  if (v_totals ->> 'total_agorot')::bigint <> p_amount or (v_totals ->> 'vat_agorot')::bigint <> v_vat then
    raise exception 'the credit lines do not add up' using errcode = 'XX000';
  end if;
  return jsonb_build_object('lines', v_lines, 'totals', jsonb_build_object(
    'net_agorot', (v_totals ->> 'net_total_agorot')::bigint, 'vat_agorot', v_vat, 'total_agorot', p_amount,
    'rate_bp', v_rate, 'prices_include_vat', false));
end;
$$;
revoke all on function app.invoice_credit_lines(bigint, bigint, integer, text) from public, anon, authenticated, service_role;

-- One credit of an original at a time: the lock app.invoice_credit_open judges what is left under, taken by every insert of a
-- credit invoice that names an original (by hand, or the worker's record)
create or replace function app.accounting_documents_credit_lock() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('invoice_credit:' || new.organization_id::text || ':' || new.original_document_id::text, 0));
  return new;
end;
$$;
revoke all on function app.accounting_documents_credit_lock() from public, anon, authenticated, service_role;

create or replace trigger accounting_documents_credit_lock before insert on public.accounting_documents
  for each row when (new.doc_type = 'credit_invoice' and new.original_document_id is not null)
  execute function app.accounting_documents_credit_lock();

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
  v_lines jsonb;
  v_orig_lines jsonb;
  v_gross boolean;
  v_try boolean;
  v_totals jsonb;
begin
  if not app.is_member(p_org) then
    raise exception 'only members read a document' using errcode = '42501';
  end if;
  select * into v_doc from public.accounting_documents d where d.organization_id = p_org and d.id = p_document;
  if v_doc.id is null then
    raise exception 'the document is not found' using errcode = 'P0001', hint = 'invoice_credit:original';
  end if;
  v_provider := app.invoice_provider_of(p_org);
  -- a credit recorded without a VAT split (by hand) counts the original's VAT share of its amount
  select coalesce(sum(d.amount_agorot), 0),
         coalesce(sum(coalesce(d.vat_agorot,
                               case when coalesce(v_doc.amount_agorot, 0) > 0
                                    then floor((2 * d.amount_agorot::numeric * coalesce(v_doc.vat_agorot, 0) + v_doc.amount_agorot)
                                               / (2 * v_doc.amount_agorot))::bigint
                                    else 0 end)), 0)
    into v_credited, v_credited_vat
    from public.accounting_documents d
   where d.organization_id = p_org and d.original_document_id = p_document and d.doc_type = 'credit_invoice'
     and d.status = 'active';
  select coalesce(sum((r.payload -> 'totals' ->> 'total_agorot')::bigint), 0),
         coalesce(sum((r.payload -> 'totals' ->> 'vat_agorot')::bigint), 0)
    into v_flight, v_flight_vat
    from app.invoice_issue_requests r
    left join app.jobs j on j.id = r.job_id
   where r.organization_id = p_org and r.payload ->> 'doc_type' = 'credit_invoice'
     and r.payload ->> 'original_document_id' = p_document::text
     and app.invoice_credit_reserves(r, j.attempts);
  -- owner (411) ב: the original's lines, what is left of each (its credit lines that name it on active credit invoices, and
  -- the lines of the requests that reserve), and the price mode its lines give back its stored totals in (null = neither)
  select coalesce(jsonb_agg(jsonb_build_object(
           'description', l.description, 'quantity', l.quantity, 'unit_price_agorot', l.unit_price_agorot,
           'discount_agorot', l.discount_agorot, 'vat_exempt', l.vat_exempt) order by l.position), '[]'::jsonb)
    into v_orig_lines
    from public.accounting_document_lines l where l.organization_id = p_org and l.document_id = p_document;
  if jsonb_array_length(v_orig_lines) > 0 and v_doc.vat_rate_bp is not null then
    foreach v_try in array array[false, true] loop
      begin
        v_totals := app.document_totals(v_orig_lines, v_doc.vat_rate_bp, v_try);
      exception when others then
        v_totals := null;
      end;
      if v_totals is not null and (v_totals ->> 'net_total_agorot')::bigint = v_doc.net_agorot
         and (v_totals ->> 'vat_agorot')::bigint = v_doc.vat_agorot and (v_totals ->> 'total_agorot')::bigint = v_doc.amount_agorot then
        v_gross := v_try;
        exit;
      end if;
    end loop;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.id, 'position', l.position, 'description', l.description, 'vat_exempt', l.vat_exempt,
           'product_id', l.product_id, 'total_agorot', l.total_agorot,
           'left_agorot', greatest(l.total_agorot
             - coalesce((select sum(cl.total_agorot) from public.accounting_document_lines cl
                          join public.accounting_documents cd on cd.organization_id = cl.organization_id and cd.id = cl.document_id
                         where cl.organization_id = p_org and cl.credited_line_id = l.id
                           and cd.doc_type = 'credit_invoice' and cd.status = 'active'), 0)
             - coalesce((select sum(round((x ->> 'quantity')::numeric * (x ->> 'unit_price_agorot')::numeric)
                                    - coalesce((x ->> 'discount_agorot')::numeric, 0))
                          from app.invoice_issue_requests r
                          left join app.jobs j on j.id = r.job_id
                          cross join lateral jsonb_array_elements(r.payload -> 'lines') x
                         where r.organization_id = p_org and r.payload ->> 'doc_type' = 'credit_invoice'
                           and r.payload ->> 'original_document_id' = p_document::text
                           and app.invoice_credit_reserves(r, j.attempts)
                           and x ->> 'original_line_id' = l.id::text), 0)::bigint, 0))
           order by l.position), '[]'::jsonb)
    into v_lines
    from public.accounting_document_lines l where l.organization_id = p_org and l.document_id = p_document;

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
    'vat_left_agorot', greatest(coalesce(v_doc.vat_agorot, 0) - v_credited_vat - v_flight_vat, 0),
    -- owner (411) ב: a partial credit of a mixed original is made of chosen lines
    'mixed', exists (select 1 from jsonb_array_elements(v_lines) x where (x ->> 'vat_exempt')::boolean)
             and exists (select 1 from jsonb_array_elements(v_lines) x where not (x ->> 'vat_exempt')::boolean),
    'gross', v_gross, 'lines', v_lines,
    -- the requests that reserve an amount, newest first (the page offers owners and admins to release an ended one)
    'reserving', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'status', x.status, 'code', x.error_code, 'number', x.number,
                                          'total_agorot', (x.payload -> 'totals' ->> 'total_agorot')::bigint,
                                          'created_at', x.created_at) order by x.created_at desc)
        from (select r.* from app.invoice_issue_requests r
                left join app.jobs j on j.id = r.job_id
               where r.organization_id = p_org and r.payload ->> 'doc_type' = 'credit_invoice'
                 and r.payload ->> 'original_document_id' = p_document::text
                 and app.invoice_credit_reserves(r, j.attempts)
               order by r.created_at desc
               limit 20) x), '[]'::jsonb));
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
  v_totals jsonb;
  v_today date;
  v_company uuid;
  v_source jsonb;
  v_payload jsonb;
  v_id uuid;
  v_built jsonb;
  v_mixed boolean;
  v_line_gross boolean;
  v_has_lines boolean;
  v_has_amount boolean;
  v_pick jsonb;
  v_line jsonb;
  v_part bigint;
  v_seen text[];
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
  -- one line: runs of white space (line breaks too) fold into one space
  v_reason := btrim(regexp_replace(coalesce(p_credit ->> 'reason', ''), '[[:space:]]+', ' ', 'g'));
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

  v_mixed := coalesce((v_room ->> 'mixed')::boolean, false);
  v_line_gross := (v_room ->> 'gross')::boolean;
  v_has_lines := jsonb_typeof(p_credit -> 'lines') = 'array' and jsonb_array_length(p_credit -> 'lines') > 0;
  v_has_amount := p_credit -> 'amount_agorot' is not null and jsonb_typeof(p_credit -> 'amount_agorot') <> 'null';

  if v_has_lines then
    -- owner (411) ב: a partial credit of an original that mixes exempt and taxable lines is made of chosen lines
    if not v_mixed or v_line_gross is null then
      raise exception 'lines are chosen only on an original that mixes exempt and taxable lines' using errcode = 'P0001',
        hint = 'invoice_credit:lines';
    end if;
    if jsonb_array_length(p_credit -> 'lines') > 200 then
      raise exception 'at most 200 lines' using errcode = 'P0001', hint = 'invoice_credit:lines';
    end if;
    v_lines := '[]'::jsonb;
    v_seen := '{}';
    for v_pick in select x from jsonb_array_elements(p_credit -> 'lines') x loop
      v_line := null;
      if jsonb_typeof(v_pick) = 'object' then
        select l into v_line from jsonb_array_elements(v_room -> 'lines') l where l ->> 'id' = v_pick ->> 'line_id';
      end if;
      if v_line is null or (v_pick ->> 'line_id') = any (v_seen) then
        raise exception 'each chosen line is a line of the original, once' using errcode = 'P0001', hint = 'invoice_credit:lines';
      end if;
      v_seen := v_seen || (v_pick ->> 'line_id');
      if v_pick -> 'amount_agorot' is null or jsonb_typeof(v_pick -> 'amount_agorot') = 'null' then
        v_part := (v_line ->> 'left_agorot')::bigint;
      else
        begin
          v_part := (v_pick ->> 'amount_agorot')::bigint;
        exception when others then
          raise exception 'a line''s amount is whole agorot' using errcode = 'P0001', hint = 'invoice_credit:amount';
        end;
      end if;
      if v_part is null or v_part < 1 or v_part > (v_line ->> 'left_agorot')::bigint then
        raise exception 'a line''s credit is above zero and never more than what is left of it' using errcode = 'P0001',
          hint = 'invoice_credit:amount';
      end if;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'description', v_line ->> 'description', 'quantity', 1, 'unit_price_agorot', v_part, 'discount_agorot', 0,
        'vat_exempt', (v_line ->> 'vat_exempt')::boolean, 'original_line_id', v_line ->> 'id')
        || case when v_line ->> 'product_id' is not null then jsonb_build_object('product_id', v_line ->> 'product_id') else '{}'::jsonb end);
    end loop;
    v_gross := v_line_gross;
    v_totals := app.document_totals(v_lines, v_doc.vat_rate_bp, v_gross);
    v_amount := (v_totals ->> 'total_agorot')::bigint;
    v_vat := (v_totals ->> 'vat_agorot')::bigint;
    if v_amount < 1 or v_amount > v_left or v_vat > v_vat_left then
      raise exception 'a credit is never more than what is left' using errcode = 'P0001', hint = 'invoice_credit:amount';
    end if;
  else
    if v_has_amount and v_mixed then
      raise exception 'a partial credit of this original is made of chosen lines' using errcode = 'P0001', hint = 'invoice_credit:lines';
    end if;
    if not v_has_amount then
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

    -- a full first credit copies the original's lines when they give back exactly its stored totals
    if v_amount = v_doc.amount_agorot then
      select coalesce(jsonb_agg(jsonb_build_object(
               'description', l.description, 'quantity', l.quantity, 'unit_price_agorot', l.unit_price_agorot,
               'discount_agorot', l.discount_agorot, 'vat_exempt', l.vat_exempt, 'original_line_id', l.id)
               || case when l.product_id is not null then jsonb_build_object('product_id', l.product_id) else '{}'::jsonb end
               order by l.position), '[]'::jsonb)
        into v_lines
        from public.accounting_document_lines l where l.organization_id = p_org and l.document_id = p_document;
      if jsonb_array_length(v_lines) > 0 and v_line_gross is not null then
        v_gross := v_line_gross;
        v_totals := app.document_totals(v_lines, v_doc.vat_rate_bp, v_gross);
        v_vat := v_doc.vat_agorot;
      else
        v_lines := null;
      end if;
    end if;
    -- a mixed original's rest: every line's remaining part, when that is exactly what is left
    if v_lines is null and v_mixed and v_line_gross is not null then
      select coalesce(jsonb_agg(jsonb_build_object(
               'description', l ->> 'description', 'quantity', 1, 'unit_price_agorot', (l ->> 'left_agorot')::bigint,
               'discount_agorot', 0, 'vat_exempt', (l ->> 'vat_exempt')::boolean, 'original_line_id', l ->> 'id')
               || case when l ->> 'product_id' is not null then jsonb_build_object('product_id', l ->> 'product_id') else '{}'::jsonb end
               order by (l ->> 'position')::integer), '[]'::jsonb)
        into v_lines
        from jsonb_array_elements(v_room -> 'lines') l where (l ->> 'left_agorot')::bigint > 0;
      v_totals := case when jsonb_array_length(v_lines) > 0 then app.document_totals(v_lines, v_doc.vat_rate_bp, v_line_gross) end;
      if v_totals is not null and (v_totals ->> 'total_agorot')::bigint = v_amount
         and (v_totals ->> 'vat_agorot')::bigint <= v_vat_left then
        v_gross := v_line_gross;
        v_vat := (v_totals ->> 'vat_agorot')::bigint;
      else
        v_lines := null;
        v_totals := null;
      end if;
    end if;
    if v_lines is null or v_totals is null then
      -- the VAT aimed at: none for an exempt original; else what the rate gives the amount, never above the VAT left
      if coalesce(v_doc.vat_agorot, 0) = 0 or coalesce(v_doc.vat_rate_bp, 0) = 0 then
        v_vat := 0;
      else
        v_vat := v_amount - floor((2 * v_amount::numeric * 10000 + (10000 + v_doc.vat_rate_bp)) / (2 * (10000 + v_doc.vat_rate_bp)))::bigint;
        v_vat := greatest(least(v_vat, v_vat_left, v_amount), 0);
      end if;
      -- lines whose app.document_totals is exactly the request's totals (the VAT never above the aimed one)
      v_built := app.invoice_credit_lines(v_amount, v_vat,
                                          v_doc.vat_rate_bp,
                                          case when v_amount = v_doc.amount_agorot then 'זיכוי ל' else 'זיכוי חלקי ל' end
                                          || app.document_type_label(v_doc.doc_type) || ' ' || v_doc.number);
      v_gross := false;
      v_lines := v_built -> 'lines';
      v_vat := (v_built -> 'totals' ->> 'vat_agorot')::bigint;
    end if;
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
                                 'rate_bp', coalesce(v_doc.vat_rate_bp, 0), 'prices_include_vat', v_gross));
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
                            'provider_customer', app.invoice_provider_customer_of(v_req),
                            -- owner (410) ב: the products the lines name, our details, and the provider's kept ids
                            'provider_products', app.invoice_provider_products_of(v_req));
end;
$$;
revoke all on function public.invoice_issue_claim(uuid, uuid) from public, anon, authenticated;
grant execute on function public.invoice_issue_claim(uuid, uuid) to service_role;

-- ----------------------------------------------------------------------------
-- The worker's record: 021313's body, plus a credit invoice's original_document_id and a late lookup's not_at_provider
-- stamped (provider_absent_at) (DOC-14)
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
  -- owner (410) ב: the provider's product ids the worker got, {product_id: id}
  if jsonb_typeof(p_result -> 'provider_product_ids') = 'object' then
    perform app.invoice_provider_products_keep(v_req, p_result -> 'provider_product_ids');
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
          -- DOC-14: known never issued (a credit request stops reserving its amount)
          update app.invoice_issue_requests r set provider_absent_at = now() where r.id = v_req.id;
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
      (organization_id, deal_id, contact_id, order_id, quote_id, original_document_id, credit_reason, doc_type, number, doc_date,
       amount_agorot, due_date, allocation_number, allocation_failed_at, allocation_error_code, net_agorot, vat_agorot,
       vat_rate_bp, provider, provider_document_id, created_by)
    values
      (v_req.organization_id, (v_source ->> 'deal_id')::uuid, (v_source ->> 'contact_id')::uuid, (v_source ->> 'order_id')::uuid,
       (v_source ->> 'quote_id')::uuid,
       -- DOC-14: a credit invoice refers to its original (null on every other type)
       case when v_type = 'credit_invoice' then (v_payload ->> 'original_document_id')::uuid end,
       -- owner (409) ב: the credit's reason is kept on the recorded credit invoice too
       case when v_type = 'credit_invoice' then left(nullif(btrim(v_payload ->> 'reason'), ''), 500) end,
       v_type, v_number, (v_payload ->> 'doc_date')::date,
       (v_totals ->> 'total_agorot')::bigint, (v_payload ->> 'due_date')::date, v_allocation,
       case when v_failure is not null then now() end, v_failure,
       -- a receipt is the money received: no VAT split (TAX-01)
       case when v_receipt then null else (v_totals ->> 'net_agorot')::bigint end,
       case when v_receipt then null else (v_totals ->> 'vat_agorot')::bigint end,
       case when v_receipt then null else (v_totals ->> 'rate_bp')::integer end,
       v_req.provider, v_doc_id, v_req.requested_by)
    returning id into v_id;
    -- owner (410) ב: a line keeps the product it came from; DOC-14 (owner (411) ב): a credit's line names the original's line
    -- it credits (an original line of the same original, else none)
    insert into public.accounting_document_lines
      (organization_id, document_id, position, product_id, credited_line_id, description, quantity, unit_price_agorot,
       discount_agorot, vat_exempt, created_by)
    select v_req.organization_id, v_id, x.n::integer,
           (select p.id from public.products p where p.organization_id = v_req.organization_id and p.id::text = x.line ->> 'product_id'),
           case when v_type = 'credit_invoice' then
             (select l.id from public.accounting_document_lines l
               where l.organization_id = v_req.organization_id and l.id::text = x.line ->> 'original_line_id'
                 and l.document_id::text = v_payload ->> 'original_document_id') end,
           x.line ->> 'description', (x.line ->> 'quantity')::numeric,
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

-- ----------------------------------------------------------------------------
-- Closing a request: 021297's body; a credit request is marked `checked` by owners and admins only (DOC-14)
-- ----------------------------------------------------------------------------
create or replace function public.invoice_issue_close(p_org uuid, p_request uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_req app.invoice_issue_requests;
begin
  if auth.uid() is null or app.membership_role(p_org) is null then
    raise exception 'only members close a request' using errcode = '42501';
  end if;
  select * into v_req from app.invoice_issue_requests r
   where r.organization_id = p_org and r.id = p_request
     and (r.requested_by = auth.uid() or app.is_admin(p_org))
   for update;
  if not found then
    raise exception 'no such request' using errcode = 'P0001', hint = 'invoice:request';
  end if;
  -- the provider is being asked right now: closing would race its answer
  if v_req.status in ('pending', 'stale') and exists (select 1 from app.jobs j
                                           where j.id = v_req.job_id and j.status = 'running' and j.locked_until > now()) then
    raise exception 'the provider is being asked right now' using errcode = 'P0001', hint = 'invoice:busy';
  end if;
  if v_req.status in ('pending', 'stale') then
    update app.invoice_issue_requests r
       set status = 'unrecorded', error_code = 'closed', closed_by = auth.uid(), finished_at = now()
     where r.id = v_req.id;
    return jsonb_build_object('status', 'unrecorded', 'code', 'closed');
  end if;
  -- one that may exist at the provider (listed as `check`): closed once someone checked; nothing is asked again
  if v_req.status = 'unrecorded' and v_req.document_id is null and v_req.provider_document_id is null
     and v_req.error_code is not null and v_req.error_code not in ('closed', 'checked') then
    -- DOC-14: a credit request reserves its amount until checked; only owners and admins say it was checked
    if v_req.payload ->> 'doc_type' = 'credit_invoice' and not app.is_admin(p_org) then
      raise exception 'only owners and admins close a credit request as checked' using errcode = 'P0001', hint = 'invoice_credit:check_admin';
    end if;
    update app.invoice_issue_requests r set error_code = 'checked', closed_by = auth.uid() where r.id = v_req.id;
    return jsonb_build_object('status', 'unrecorded', 'code', 'checked');
  end if;
  return jsonb_build_object('status', v_req.status, 'code', v_req.error_code);
end;
$$;
revoke all on function public.invoice_issue_close(uuid, uuid) from public, anon;
grant execute on function public.invoice_issue_close(uuid, uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- Releasing a credit request after checking at the provider (owners and admins): it stops reserving its amount
-- ----------------------------------------------------------------------------
create or replace function public.invoice_credit_release(p_org uuid, p_request uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_req app.invoice_issue_requests;
begin
  if auth.uid() is null or app.membership_role(p_org) is null or not app.is_admin(p_org) then
    raise exception 'only owners and admins release a credit request' using errcode = '42501';
  end if;
  select * into v_req from app.invoice_issue_requests r
   where r.organization_id = p_org and r.id = p_request and r.payload ->> 'doc_type' = 'credit_invoice'
   for update;
  if not found then
    raise exception 'no such request' using errcode = 'P0001', hint = 'invoice:request';
  end if;
  if v_req.status in ('pending', 'issued', 'failed') or v_req.document_id is not null then
    raise exception 'only an ended credit request without a recorded document is released' using errcode = 'P0001',
      hint = 'invoice_credit:release';
  end if;
  if exists (select 1 from app.jobs j where j.id = v_req.job_id and j.status = 'running' and j.locked_until > now()) then
    raise exception 'the provider is being asked right now' using errcode = 'P0001', hint = 'invoice:busy';
  end if;
  if v_req.credit_released_at is null then
    update app.invoice_issue_requests r
       set status = 'unrecorded', error_code = 'checked', closed_by = auth.uid(), finished_at = coalesce(r.finished_at, now()),
           credit_released_at = now()
     where r.id = v_req.id;
  end if;
  return jsonb_build_object('status', 'unrecorded', 'code', 'checked');
end;
$$;
revoke all on function public.invoice_credit_release(uuid, uuid) from public, anon;
grant execute on function public.invoice_credit_release(uuid, uuid) to authenticated;
