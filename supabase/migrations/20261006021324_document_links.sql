-- =============================================================================
-- DOC-15 (owner, 18 November 2026, answers (413) ג and (414) א): a sent accounting document reaches the customer.
--   Part 1: the customer's public document page through a secret link (CLAUDE.md hard rule 5's approved pattern; the
--           18 November 2026 paragraph names DOC-15), which the staff send by WhatsApp (wa.me) or email.
--   Part 2 (org_document_settings.document_delivery) is the next migration, document_delivery.
-- =============================================================================
-- The approved pattern, as BAL-04's statement link and ORD-05's order link: the page's server file calls one security definer
-- function granted to service_role only, which checks the token and answers only what the page shows; no table is reached
-- directly with the service key.
--
-- * app.document_links: one link per document (no API access, no grants). Only the SHA-256 of the token is kept; the link is
--   shown once when it is made; a new link replaces the old one; turning it off clears the hash. The row goes with its document
--   (cascade; a document is removed only with its business).
-- * Which documents: an accounting document of type tax_invoice, tax_invoice_receipt, receipt, credit_invoice or proforma
--   (app.document_link_types(); never an opening balance, which has no number), issued through the provider or recorded.
--   A link is made only for an ACTIVE document whose record is live (hints document_link:type|cancelled|deleted).
-- * Who: whoever records documents (app.can_record_documents: owner, admin, manager by role or the PRM-01 key `documents`) or
--   issues them (app.can_issue_documents: owner, admin or the key `issue_documents`), for a document they read: the rule of
--   the accounting_documents_select policy written for a named user (app.document_link_readable: the deal, else the contact,
--   else the company by app.user_can_read_record on its owner and team; no parent = owners, admins and managers by role).
--   A deputy who reads the record only through HEB-08's deputy rule is refused (fails closed), as the statement link.
--   Making a link needs a writable business and the `documents` key; status and revoke need only the rights (turning a link
--   off only lessens access). Audited as action 'document_link' on the document, {"link": "created" | "revoked"} with the
--   document's contact_id, deal_id and company_id (ids only, so a later erasure finds the document through these entries
--   too): never the token or its hash.
-- * The one rule for a link (app.document_link_usable): not found (P0002) for an unknown or revoked token, a business whose
--   public pages are closed (app.org_public_pages_open), a business without the `documents` key, a document of another type,
--   and a document with no live record (every record it names is in the recycle bin or gone, or it names none).
--   A CANCELLED document is found: the page answers a status page without amounts or lines.
-- * public.document_public(token, ip_hash): service_role only. 120 views per link and, with the server's keyed IP hash (FXS-11,
--   src/lib/keyed-ip-hash.ts, scope "document"), 60 per sender, in 10 minutes (app.document_link_view_counts: 1,024 reused
--   buckets per link, no hash stored; the sender scoped to the link by app.document_link_sender). Counted right after the token
--   is looked up and judged usable, before the page's data is read. Past either: {"rate_limited": true}.
--   The answer: the business's name as documents use it (org_document_settings.legal_name when set, else the display name;
--   TAX-01's rule) and its display name (the logo's alt text), logo and colour (QUO-05's design, as the statement page), built-with, the
--   document's type code, number, date, net / VAT / total amounts and VAT rate as recorded, the allocation number (DOC-10, a
--   tax invoice or invoice-receipt only), the lines as recorded (description, quantity, unit price, discount, VAT-exempt mark,
--   total), the due date and, for a debt document (a tax invoice or proforma above 0), its pay state and balance by
--   public.money_allocation_state (paid | partial | unpaid | transferred; an invoice-receipt is paid on issue), the days overdue
--   in the business's zone, and whether a PDF can be downloaded. No ids, no customer name, no notes, nothing of another
--   document, customer or business.
-- * public.document_public_file(token, ip_hash): service_role only, the same lookup and the same counters (a download is a
--   view): the document's CURRENT file (its newest confirmed file, DOC-01's versions) only while that file is a PDF and the
--   document is active; answers its storage path, SHA-256 (null for a person's upload, which has none) and size only.
--   The route reads that one object, compares the SHA-256 when one is kept, else the size, and sends it.
-- * Privacy erasure: when the erasure erases a document's audit entries (app.audit_erase_core reaches the erased person's
--   documents, RVW-45's contact-less documents on their deal too), trigger audit_log_document_link_erase turns its link off
--   (token_hash null), the pattern of audit_log_credit_reason_erase; audit_erase_core is not redefined.
-- Every statement is safe to run twice. No drops, no row removal.

create table if not exists app.document_links (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null,
  document_id        uuid not null,
  -- hex SHA-256 of the token; null = turned off
  token_hash         text unique,
  created_by         uuid,
  created_at         timestamptz,
  window_started_at  timestamptz,
  window_count       integer not null default 0,
  constraint document_links_once unique (organization_id, document_id),
  constraint document_links_document_fk foreign key (organization_id, document_id)
    references public.accounting_documents (organization_id, id) on delete cascade
);
alter table app.document_links enable row level security;
revoke all on app.document_links from public, anon, authenticated, service_role;

-- Views per sender: a fixed set of counters per link (1,024 buckets picked by the scoped keyed IP hash), each counting its
-- 10-minute window and reused by the next one (an update, never a delete). No hash is stored.
create table if not exists app.document_link_view_counts (
  link_id       uuid not null references app.document_links (id) on delete cascade,
  bucket        integer not null check (bucket between 0 and 1023),
  window_start  timestamptz not null,
  views         integer not null,
  primary key (link_id, bucket)
);
alter table app.document_link_view_counts enable row level security;
revoke all on app.document_link_view_counts from public, anon, authenticated, service_role;

-- The document types a customer gets a link to (mirrored by DOCUMENT_LINK_TYPES in src/features/document-links/public.ts)
create or replace function app.document_link_types() returns text[]
language sql immutable
set search_path = ''
as $$
  select array['tax_invoice', 'tax_invoice_receipt', 'receipt', 'credit_invoice', 'proforma']::text[]
$$;
revoke all on function app.document_link_types() from public, anon, authenticated, service_role;

-- The sender, scoped to one link: nothing matches across links or businesses
create or replace function app.document_link_sender(p_link uuid, p_hash text) returns text
language sql immutable
set search_path = ''
as $$
  select case when p_hash is null or p_link is null then null
              else encode(sha256(convert_to('document:' || p_link::text || ':' || p_hash, 'UTF8')), 'hex') end
$$;
revoke all on function app.document_link_sender(uuid, text) from public, anon, authenticated, service_role;

-- The document's record is live: it names at least one deal, contact or company, and none it names is in the recycle bin
create or replace function app.document_link_record_live(p_doc public.accounting_documents) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_doc.id is not null
     and (p_doc.deal_id is not null or p_doc.contact_id is not null or p_doc.company_id is not null)
     and (p_doc.deal_id is null or exists (
           select 1 from public.deals d
            where d.organization_id = p_doc.organization_id and d.id = p_doc.deal_id and d.deleted_at is null))
     and (p_doc.contact_id is null or exists (
           select 1 from public.contacts c
            where c.organization_id = p_doc.organization_id and c.id = p_doc.contact_id and c.deleted_at is null))
     and (p_doc.company_id is null or exists (
           select 1 from public.companies c
            where c.organization_id = p_doc.organization_id and c.id = p_doc.company_id and c.deleted_at is null))
$$;
revoke all on function app.document_link_record_live(public.accounting_documents) from public, anon, authenticated, service_role;

-- The one rule for a link: anything else answers "not found" (a cancelled document is found: its page is a status page)
create or replace function app.document_link_usable(p_link app.document_links, p_doc public.accounting_documents) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_link.id is not null
     and p_link.token_hash is not null
     and p_doc.id is not null
     and p_doc.organization_id = p_link.organization_id
     and p_doc.id = p_link.document_id
     and p_doc.doc_type = any (app.document_link_types())
     and coalesce(app.org_public_pages_open(p_link.organization_id), false)
     and coalesce(app.org_has_feature(p_link.organization_id, 'documents'), false)
     and app.document_link_record_live(p_doc)
$$;
revoke all on function app.document_link_usable(app.document_links, public.accounting_documents) from public, anon, authenticated, service_role;

-- The caller reads the document: the accounting_documents_select policy's rule for auth.uid() (keep in step): the deal, else
-- the contact, else the company, by app.user_can_read_record on its owner and team; no parent = owners, admins and managers
-- by role. In the recycle bin too, so a binned record's link can still be seen and turned off.
create or replace function app.document_link_readable(p_doc public.accounting_documents) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select case
    when p_doc.id is null then false
    when p_doc.deal_id is not null then exists (
      select 1 from public.deals d
       where d.organization_id = p_doc.organization_id and d.id = p_doc.deal_id
         and app.user_can_read_record(p_doc.organization_id, auth.uid(), d.owner_id, d.team_id))
    when p_doc.contact_id is not null then exists (
      select 1 from public.contacts c
       where c.organization_id = p_doc.organization_id and c.id = p_doc.contact_id
         and app.user_can_read_record(p_doc.organization_id, auth.uid(), c.owner_id, c.team_id))
    when p_doc.company_id is not null then exists (
      select 1 from public.companies c
       where c.organization_id = p_doc.organization_id and c.id = p_doc.company_id
         and app.user_can_read_record(p_doc.organization_id, auth.uid(), c.owner_id, c.team_id))
    else coalesce(app.role_in(p_doc.organization_id)::text in ('owner', 'admin', 'manager'), false)
  end
$$;
revoke all on function app.document_link_readable(public.accounting_documents) from public, anon, authenticated, service_role;

-- Who may manage a document's link: whoever records or issues documents in the business, for a document they read.
-- Answers the document (42501 for anything else, so an outsider learns nothing).
create or replace function app.document_link_check(p_org uuid, p_document uuid) returns public.accounting_documents
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_doc public.accounting_documents;
begin
  if p_org is null or p_document is null then
    raise exception 'name a document' using errcode = '22023';
  end if;
  if not (coalesce(app.can_record_documents(p_org), false) or coalesce(app.can_issue_documents(p_org), false)) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  select * into v_doc from public.accounting_documents d where d.organization_id = p_org and d.id = p_document;
  if not found or not app.document_link_readable(v_doc) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return v_doc;
end;
$$;
revoke all on function app.document_link_check(uuid, uuid) from public, anon, authenticated, service_role;

-- The document's current file (DOC-01: the newest confirmed file; earlier ones are its versions), only while it is a PDF
create or replace function app.document_link_file(p_doc public.accounting_documents) returns public.files
language sql stable security definer
set search_path = ''
as $$
  select x.* from (
    select f.* from public.files f
     where f.organization_id = p_doc.organization_id and f.accounting_document_id = p_doc.id
       and f.unconfirmed_since is null
     order by f.created_at desc, f.id desc
     limit 1) x
   where x.mime_type = 'application/pdf'
$$;
revoke all on function app.document_link_file(public.accounting_documents) from public, anon, authenticated, service_role;

-- A new link (shown once: only its hash is kept; the document's previous link stops working)
create or replace function public.document_link_create(p_org uuid, p_document uuid) returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_doc public.accounting_documents;
  v_token text;
  v_hash text;
begin
  v_doc := app.document_link_check(p_org, p_document);
  if not app.org_writable(p_org) then
    raise exception 'the organization is read-only' using errcode = 'P0001', hint = 'org:read_only';
  end if;
  if not coalesce(app.org_has_feature(p_org, 'documents'), false) then
    raise exception 'documents are not in this plan' using errcode = 'P0001', hint = 'feature:documents';
  end if;
  if not (v_doc.doc_type = any (app.document_link_types())) then
    raise exception 'this document type has no customer link' using errcode = 'P0001', hint = 'document_link:type';
  end if;
  if v_doc.status <> 'active' then
    raise exception 'the document is cancelled' using errcode = 'P0001', hint = 'document_link:cancelled';
  end if;
  if not app.document_link_record_live(v_doc) then
    raise exception 'the document''s record is not live' using errcode = 'P0001', hint = 'document_link:deleted';
  end if;

  -- 48 random bytes from three UUIDs, base64url: 64 characters
  v_token := translate(
    encode(decode(replace(gen_random_uuid()::text || gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'), 'base64'),
    E'+/=\n', '-_');
  v_hash := encode(sha256(convert_to(v_token, 'UTF8')), 'hex');

  insert into app.document_links as l (organization_id, document_id, token_hash, created_by, created_at, window_started_at, window_count)
  values (p_org, p_document, v_hash, auth.uid(), now(), null, 0)
  on conflict (organization_id, document_id) do update
    set token_hash = excluded.token_hash, created_by = excluded.created_by, created_at = excluded.created_at,
        window_started_at = null, window_count = 0;
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'document_link', 'accounting_documents', p_document,
          jsonb_build_object('link', 'created', 'contact_id', v_doc.contact_id, 'deal_id', v_doc.deal_id, 'company_id', v_doc.company_id));
  return v_token;
end;
$$;
revoke all on function public.document_link_create(uuid, uuid) from public, anon;
grant execute on function public.document_link_create(uuid, uuid) to authenticated;

-- Turning the link off only lessens access: the rights and a document the caller reads, no writable business or key, and
-- whatever the link's state (a binned record, the key off, closed public pages: a link that does not open now is still turned
-- off, so it never comes back)
create or replace function public.document_link_revoke(p_org uuid, p_document uuid) returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_doc public.accounting_documents;
  v_count integer;
begin
  v_doc := app.document_link_check(p_org, p_document);
  update app.document_links l
     set token_hash = null, created_at = null, window_started_at = null, window_count = 0
   where l.organization_id = p_org and l.document_id = p_document and l.token_hash is not null;
  get diagnostics v_count = row_count;
  if v_count > 0 then
    insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
    values (p_org, auth.uid(), 'document_link', 'accounting_documents', p_document,
            jsonb_build_object('link', 'revoked', 'contact_id', v_doc.contact_id, 'deal_id', v_doc.deal_id, 'company_id', v_doc.company_id));
  end if;
  return v_count > 0;
end;
$$;
revoke all on function public.document_link_revoke(uuid, uuid) from public, anon;
grant execute on function public.document_link_revoke(uuid, uuid) to authenticated;

-- Whether the document has a link (exists: made and not turned off) and whether it opens now (usable), and since when (never
-- the hash). A link can exist and not open (a binned record, the documents key off, closed public pages): the screen still
-- offers to turn it off, so it never comes back to life when the reason goes away.
create or replace function public.document_link_status(p_org uuid, p_document uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_doc public.accounting_documents;
  v_link app.document_links;
  v_usable boolean;
  v_reason text;
begin
  v_doc := app.document_link_check(p_org, p_document);
  select * into v_link from app.document_links l
   where l.organization_id = p_org and l.document_id = p_document and l.token_hash is not null;
  v_usable := v_link.id is not null and app.document_link_usable(v_link, v_doc);
  -- why an existing link does not open now, when it can be told: the business (pages closed), the plan key, the record.
  -- Accepted: `record_gone` may tell a link manager that a record the document names (not necessarily the one they read it
  -- through) is in the recycle bin or gone; one bit, to link managers only, about a document they already read
  if v_link.id is not null and not v_usable then
    v_reason := case
      when not coalesce(app.org_public_pages_open(p_org), false) then 'pages_closed'
      when not coalesce(app.org_has_feature(p_org, 'documents'), false) then 'feature_off'
      when not app.document_link_record_live(v_doc) then 'record_gone'
    end;
  end if;
  return jsonb_build_object('exists', v_link.id is not null, 'usable', v_usable, 'reason', v_reason,
                            'created_at', v_link.created_at);
end;
$$;
revoke all on function public.document_link_status(uuid, uuid) from public, anon;
grant execute on function public.document_link_status(uuid, uuid) to authenticated;

-- Which of the given documents have a link (made and not turned off), for the documents card: also while the business is
-- not writable or the plan lacks `documents`, so a link that does not open now can still be seen and turned off. The rights
-- of the link (whoever records or issues documents; nobody else gets an answer) and only documents the caller reads; at most
-- 200 ids.
create or replace function public.document_links_existing(p_org uuid, p_documents uuid[]) returns uuid[]
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if p_org is null or not (coalesce(app.can_record_documents(p_org), false) or coalesce(app.can_issue_documents(p_org), false)) then
    return '{}'::uuid[];
  end if;
  if coalesce(cardinality(p_documents), 0) > 200 then
    raise exception 'too many documents' using errcode = '22023', hint = 'document_link:too_many';
  end if;
  return coalesce((
    select array_agg(d.id order by d.id)
      from public.accounting_documents d
      join app.document_links l on l.organization_id = d.organization_id and l.document_id = d.id and l.token_hash is not null
     where d.organization_id = p_org and d.id = any (p_documents) and app.document_link_readable(d)), '{}'::uuid[]);
end;
$$;
revoke all on function public.document_links_existing(uuid, uuid[]) from public, anon;
grant execute on function public.document_links_existing(uuid, uuid[]) to authenticated;

-- ----------------------------------------------------------------------------
-- The customer's page and file
-- ----------------------------------------------------------------------------
-- The lookup and the counters shared by the page and the file: the link and its document, or P0002; null = rate limited
create or replace function app.document_link_take(p_token text, p_ip_hash text) returns app.document_links
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_link app.document_links;
  v_doc public.accounting_documents;
  v_count integer;
  v_bucket integer;
  v_views integer;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'document not found' using errcode = 'P0002';
  end if;
  select * into v_link from app.document_links l where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found then
    raise exception 'document not found' using errcode = 'P0002';
  end if;
  select * into v_doc from public.accounting_documents d where d.organization_id = v_link.organization_id and d.id = v_link.document_id;
  if not app.document_link_usable(v_link, v_doc) then
    raise exception 'document not found' using errcode = 'P0002';
  end if;

  -- 120 views per link in 10 minutes; counted (one row update) before the page's data is read
  update app.document_links l
     set window_started_at = case when l.window_started_at > now() - interval '10 minutes' then l.window_started_at else now() end,
         window_count = case when l.window_started_at > now() - interval '10 minutes' then l.window_count + 1 else 1 end
   where l.id = v_link.id
  returning l.window_count into v_count;
  if v_count > 120 then
    return null;
  end if;
  -- FXS-11: 60 views per sender in 10 minutes, by the server's keyed IP hash scoped to this link
  if p_ip_hash is not null then
    v_bucket := ((hashtextextended(app.document_link_sender(v_link.id, p_ip_hash), 0) % 1024) + 1024) % 1024;
    insert into app.document_link_view_counts as vc (link_id, bucket, window_start, views)
    values (v_link.id, v_bucket, now(), 1)
    on conflict (link_id, bucket) do update
      set window_start = case when vc.window_start > now() - interval '10 minutes' then vc.window_start else now() end,
          views = case when vc.window_start > now() - interval '10 minutes' then vc.views + 1 else 1 end
    returning vc.views into v_views;
    if v_views > 60 then
      return null;
    end if;
  end if;
  return v_link;
end;
$$;
revoke all on function app.document_link_take(text, text) from public, anon, authenticated, service_role;

create or replace function public.document_public(p_token text, p_ip_hash text default null) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_link app.document_links;
  v_doc public.accounting_documents;
  v_org public.organizations;
  v_design public.quote_designs;
  v_today date;
  v_brand jsonb;
  v_built_with boolean;
  v_state jsonb;
  v_pay text;
  v_balance bigint;
  v_lines jsonb;
  v_file public.files;
  v_legal text;
begin
  v_link := app.document_link_take(p_token, p_ip_hash);
  if v_link.id is null then
    return jsonb_build_object('rate_limited', true);
  end if;
  select * into v_doc from public.accounting_documents d where d.organization_id = v_link.organization_id and d.id = v_link.document_id;
  select * into v_org from public.organizations o where o.id = v_link.organization_id;
  select * into v_design from public.quote_designs d where d.organization_id = v_link.organization_id;
  -- TAX-01's rule: documents use the registered name when set; the display name stays for the logo's alt text
  select nullif(btrim(s.legal_name), '') into v_legal from public.org_document_settings s where s.organization_id = v_link.organization_id;
  v_today := (now() at time zone coalesce(v_org.timezone, 'Asia/Jerusalem'))::date;
  -- QUO-05: no design row = the defaults (logo shown)
  v_brand := jsonb_build_object('logo', case when coalesce(v_design.show_logo, true) then v_org.logo_path end,
                                'color', coalesce(v_design.accent_color, v_org.brand_color));
  begin
    v_built_with := coalesce(app.show_built_with(v_link.organization_id), true);
  exception when others then
    v_built_with := true;
  end;

  -- a cancelled document: its type and number only, no amounts or lines
  if v_doc.status <> 'active' then
    return jsonb_build_object(
      'status_page', jsonb_build_object('cancelled', true, 'type', v_doc.doc_type, 'number', v_doc.number),
      'business', jsonb_build_object('name', coalesce(v_legal, v_org.name), 'display_name', v_org.name),
      'brand', v_brand,
      'built_with', v_built_with);
  end if;

  -- a debt document's pay state and balance (PAY-02's rule); the money function runs as this function's owner, so every
  -- row of THIS document counts (the page is not a person)
  if v_doc.doc_type in ('tax_invoice', 'proforma') and v_doc.amount_agorot > 0 then
    select x.value into v_state
      from jsonb_array_elements(public.money_allocation_state(v_doc.organization_id, array[v_doc.id], '{}'::uuid[]) -> 'documents') as x(value)
     limit 1;
    v_pay := v_state ->> 'state';
    v_balance := coalesce((v_state ->> 'balance')::bigint, 0);
  elsif v_doc.doc_type = 'tax_invoice_receipt' then
    v_pay := 'paid_on_issue';
    v_balance := 0;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'description', l.description,
           'quantity', l.quantity,
           'unit_price_agorot', l.unit_price_agorot,
           'discount_agorot', l.discount_agorot,
           'vat_exempt', l.vat_exempt,
           'total_agorot', l.total_agorot) order by l.position), '[]'::jsonb)
    into v_lines
    from public.accounting_document_lines l
   where l.organization_id = v_doc.organization_id and l.document_id = v_doc.id;

  v_file := app.document_link_file(v_doc);

  return jsonb_build_object(
    'business', jsonb_build_object('name', coalesce(v_legal, v_org.name), 'display_name', v_org.name),
    'brand', v_brand,
    'today', v_today,
    'currency', 'ILS',
    'document', jsonb_build_object(
      'type', v_doc.doc_type,
      'number', v_doc.number,
      'doc_date', v_doc.doc_date,
      'due_date', case when v_doc.doc_type in ('tax_invoice', 'proforma') then v_doc.due_date end,
      'amount_agorot', v_doc.amount_agorot,
      'net_agorot', v_doc.net_agorot,
      'vat_agorot', v_doc.vat_agorot,
      'vat_rate_bp', v_doc.vat_rate_bp,
      'allocation_number', case when v_doc.doc_type in ('tax_invoice', 'tax_invoice_receipt') then v_doc.allocation_number end,
      'pay_state', v_pay,
      'balance_agorot', v_balance,
      'overdue_days', case when v_pay in ('unpaid', 'partial') and v_doc.due_date < v_today then v_today - v_doc.due_date else 0 end),
    'lines', v_lines,
    'file', v_file.id is not null,
    'built_with', v_built_with);
end;
$$;
revoke all on function public.document_public(text, text) from public, anon, authenticated;
grant execute on function public.document_public(text, text) to service_role;

create or replace function public.document_public_file(p_token text, p_ip_hash text default null) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_link app.document_links;
  v_doc public.accounting_documents;
  v_file public.files;
begin
  v_link := app.document_link_take(p_token, p_ip_hash);
  if v_link.id is null then
    return jsonb_build_object('rate_limited', true);
  end if;
  select * into v_doc from public.accounting_documents d where d.organization_id = v_link.organization_id and d.id = v_link.document_id;
  if v_doc.status <> 'active' then
    return jsonb_build_object('unavailable', true);
  end if;
  v_file := app.document_link_file(v_doc);
  if v_file.id is null then
    return jsonb_build_object('unavailable', true);
  end if;
  return jsonb_build_object('path', v_file.storage_path, 'sha256', v_file.sha256, 'size', v_file.size_bytes,
                            'type', v_doc.doc_type, 'number', v_doc.number);
end;
$$;
revoke all on function public.document_public_file(text, text) from public, anon, authenticated;
grant execute on function public.document_public_file(text, text) to service_role;

-- ----------------------------------------------------------------------------
-- Privacy erasure turns the link off
-- ----------------------------------------------------------------------------
-- When the erasure erases a document's audit entries (app.audit_erase_core, its RVW-45 branch too), the document's link stops
-- working: the hash is cleared (the row stays; nothing is removed). The link's own audit entries are erased with the rest.
create or replace function app.audit_log_document_link_erase() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  update app.document_links l
     set token_hash = null, created_at = null, window_started_at = null, window_count = 0
   where l.organization_id = new.organization_id and l.document_id = new.entity_id and l.token_hash is not null;
  return null;
end;
$$;
revoke all on function app.audit_log_document_link_erase() from public, anon, authenticated, service_role;

create or replace trigger audit_log_document_link_erase after update of changes on public.audit_log
  for each row when (new.entity_type = 'accounting_documents' and new.entity_id is not null
                     and new.changes = '{"erased": true}'::jsonb and old.changes is distinct from new.changes)
  execute function app.audit_log_document_link_erase();
