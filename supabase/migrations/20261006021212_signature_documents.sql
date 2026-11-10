-- =============================================================================
-- SGN-02: a document from a record, sent by a secret link, signed on the customer's phone, the signed PDF kept
-- =============================================================================
-- Owner, 9 November 2026, answer (191) א (DECISIONS.md): a new use of the service key for signing a document from a secret
-- link, under QUO-08 / QUO-09's conditions (CLAUDE.md hard rule 5): one security definer function per public action, granted to
-- service_role only, which checks the token and answers only what the page needs; the signature kept like quote_decisions
-- (name, signature, wording version, the fingerprint of the document as shown, IP and browser); the quote page's limits (120
-- views per link and 60 per sender in 10 minutes, 10 signing tries); "not found" by one rule; database tests; an independent
-- review before merge; its own "In use" line. The signing wording is a DRAFT with a version. A counter against SGN-01's
-- max_signatures_per_month (answer (67)), counted when a document is SENT for signature (the 021200 header).
--
-- * public.signature_documents: one row per document sent. One record (lead | contact | company | deal, composite FKs).
--   Owner (219) ב, as sent quotes (QUO-07): when the record is purged its documents STAY, detached (before-delete triggers
--   *_signature_documents_detach: the record's column emptied, former_<type>_id and customer_deleted_at set; skipped while the
--   whole business is deleted); a detached document, its signature and its signed PDF are read by owners, admins and managers
--   by role (signature_documents_select, quotes_select's rule; the signature and the PDF stay owners and admins only); its
--   link answers not found. A privacy erasure empties it (below). template_id (set null when the template goes), title 1..120, body = the FILLED text (REC-04's
--   cleaned Markdown, filled by the app from SGN-01's template with the sender's session, frozen here), status
--   sent | viewed | signed | cancelled (expired is the shown state of an unsigned document past expires_at; SGN-03 adds
--   reminders), sent_by / sent_at, viewed_at, signed_at, cancelled_at / cancelled_by, optional expires_at, and content_sha256
--   (the fingerprint of the document as shown: app.signature_fingerprint). Read follows the record (the activities rule,
--   app.can_read_activity_subject); no client writes: every write goes through the functions below. Not audited row by row
--   (the body holds personal data): sending, a new link and cancelling write one audit entry each with ids and codes only.
-- * The customer's download of the signed PDF (owner (223) ב, a new approved service-key use): public.signature_public_pdf
--   (token, ip_hash), service_role only, answers path, SHA-256 and file name only, only after signing and only for the link
--   the document was signed with (app.signature_links.signed_token_hash, set by the signing; a signed document never gets a
--   new link, signature_document_link refuses it, so any other token is not found); 20 downloads per sender in 10 minutes
--   (keyed IP hash scope `signature`, app.signature_pdf_download_counts, 1,024 buckets, no hash kept) plus the link's
--   120-view window, both counted after the token lookup; {unavailable: true} while the PDF is not kept yet. The route
--   compares the bytes with the SHA-256 before it serves them.
-- * public.signature_signatures: one signature per document, written only by public.signature_public_sign, read only by
--   owners and admins (as quote_decisions, owner (37) ב's safe side), not audited; it cascades with its document.
-- * app.signature_links: the SHA-256 of the one token per document (no grants); a new link replaces the old one. The token
--   is shown once, when the document is sent or a new link is made.
-- * The one rule for a link, app.signature_link_usable: not found (P0002) only for an unknown or replaced token, a record in
--   the bin, a business whose public pages are closed or that lost the `signatures` key. A cancelled document answers
--   {status_page: {state: cancelled}}, an unsigned one past expires_at {status_page: {state: expired}}, without the text.
-- * Sending (public.signature_document_send): whoever may edit the live record (app.can_edit_record) in a writable business
--   with the key; an active template of the record's type; no merge field of the type left unfilled (hint
--   signature_document:unfilled); the month's count in the business zone under max_signatures_per_month (hint
--   limit:max_signatures_per_month; app.signature_months, one row per business and month). A system timeline entry on the
--   record (kind signature_sent, by the sender, the title only), which also makes the record "worked on" for sample data and
--   import undo (app.sample_untouched / app.import_record_worked count any timeline entry).
-- * The customer: public.signature_public(token, ip_hash) and public.signature_public_sign(token, ...) (service_role). A view
--   moves sent -> viewed once. Signing: the page's fingerprint must equal the stored one, the wording version given, the
--   box ticked; one signature per document (row lock); a system timeline entry (kind signature_signed, no author) and one
--   `system` notice (the document's title only) to the sender and the record's owner (active, not viewers), else owners/admins.
-- * The signed PDF: rendered on our server and kept as a files row of the document (files.signature_document_id, the tenth
--   subject; PDF only; one per document; server rows only: no person inserts, reads it but an owner or admin, or removes it).
--   Two entries, as QUO-09: the customer's route right after signing (public.signature_pdf_public, then
--   public.signature_pdf_public_store) and staff, owners and admins, when that failed (public.signature_pdf_allowed with the
--   person's session, then public.signature_pdf_store, service_role, which checks that user again). The writer is
--   app.signature_pdf_write: a first call answers a fresh path (kept in app.signature_pdf_attempts); the route uploads there
--   (upsert off); a second call naming the path checks the object (a PDF of the stated size) and inserts the confirmed row,
--   whose path is that one. Not counted in max_pdf_per_month (the signature cap already counts the document). The file is named
--   "מסמך חתום <date>.pdf", never after the title, so its audit entry holds nothing personal.
-- * Merge moves a duplicate's documents to the kept record through the `merged` entry (app.merge_signature_documents).
-- * Erasure (review 1): a purged record leaves its documents detached (219 ב, above). A document on ANOTHER record can still name a
--   person: a deal's template fills the deal contact's name, phone and email, and anyone may sign a deal's or a company's
--   document. So every document keeps, server side, `people`: the leads and contacts it was about when it was sent and when it
--   was signed (the record itself; a deal's contact, its deal_contacts and the lead converted into it; a company's contacts by
--   contacts.company_id and CON-05 links, 500 each; a contact's converted lead). app.audit_erase_core (redefined from its latest
--   body, 021166, one call added) calls app.signature_documents_erase for an erased lead or contact: every document whose
--   `people` holds it, and a contact's deals at its purge (RVW-45's audit trail, v_deals), gets body and title replaced by a
--   neutral line, erased_at stamped and its link revoked; the signature loses name, ID number, image, IP and browser
--   (erased_at); the timeline entries of those documents get a neutral body and their audit entries are erased; the "signed"
--   notices lose the title (as RVW-42 for quotes); and the signed PDF goes through app.signature_pdf_drop, whose body (a row
--   removal) is in the pasted 20261006021213_signature_pdf_erase; here a placeholder that does nothing, made only while the
--   function is missing (running this file again never undoes the pasted body). Until 021213 is pasted an erased document's
--   signed PDF stays (owners and admins only). The object goes to the orphan cleanup with the row (files_after_delete).
--   Accepted (safe side, owner question): erasing any one contact of a company erases every company document that names it in
--   `people`, a company contract included.
-- * PRV-01 (review 2, safe interim until owner question 219): app.lead_retention_candidates (redefined from 021081) keeps a
--   lead that holds a signed document (its own, or one whose `people` names it).
-- * Wording versions (review 5): app.signature_wording_versions (version + text, as app.agreement_texts); signing accepts only
--   a registered version, and the signed PDF prints the stored version's own text.
-- * Owner (224) ב (replaces review 7's "the action fills"): the database fills the template itself (see "edit before
--   sending" below); the sender edits the free text only, and the send judges the text against the server's fill.
-- * The audit entries of this feature hold ids and codes only.
-- Every statement is safe to run twice. No statement starts with drop (two `alter table ... drop constraint if exists`
-- re-add files_one_subject and files_sha256_shape), no row removal.

-- ----------------------------------------------------------------------------
-- The documents
-- ----------------------------------------------------------------------------
create table if not exists public.signature_documents (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  lead_id         uuid,
  contact_id      uuid,
  company_id      uuid,
  deal_id         uuid,
  template_id     uuid,
  title           text not null check (char_length(title) between 1 and 120 and title = btrim(title) and title !~ '[[:cntrl:]]'),
  body            text not null check (char_length(body) between 1 and 30000),
  status          text not null default 'sent' check (status in ('sent', 'viewed', 'signed', 'cancelled')),
  sent_by         uuid,
  sent_at         timestamptz not null default now(),
  viewed_at       timestamptz,
  signed_at       timestamptz,
  cancelled_at    timestamptz,
  cancelled_by    uuid,
  expires_at      timestamptz,
  content_sha256  text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  -- server only (review 1): the leads and contacts the document was about when sent and when signed, for erasure
  people          uuid[] not null default '{}' check (cardinality(people) <= 2000),
  -- owner (219) ב: the record it was on, once that record was purged (server only)
  former_lead_id     uuid,
  former_contact_id  uuid,
  former_company_id  uuid,
  former_deal_id     uuid,
  customer_deleted_at timestamptz,
  -- set when a person's erasure emptied the document (app.signature_documents_erase)
  erased_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  constraint signature_documents_one_record check (
    num_nonnulls(lead_id, contact_id, company_id, deal_id) = 1
    or (num_nonnulls(lead_id, contact_id, company_id, deal_id) = 0 and customer_deleted_at is not null)),
  constraint signature_documents_shape check (
    (status <> 'signed' or signed_at is not null) and (status <> 'cancelled' or cancelled_at is not null)),
  constraint signature_documents_lead_fk foreign key (organization_id, lead_id)
    references public.leads (organization_id, id) on delete cascade,
  constraint signature_documents_contact_fk foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id) on delete cascade,
  constraint signature_documents_company_fk foreign key (organization_id, company_id)
    references public.companies (organization_id, id) on delete cascade,
  constraint signature_documents_deal_fk foreign key (organization_id, deal_id)
    references public.deals (organization_id, id) on delete cascade,
  constraint signature_documents_template_fk foreign key (organization_id, template_id)
    references public.document_templates (organization_id, id) on delete set null (template_id)
);

create index if not exists signature_documents_lead_idx on public.signature_documents (organization_id, lead_id);
create index if not exists signature_documents_contact_idx on public.signature_documents (organization_id, contact_id);
create index if not exists signature_documents_company_idx on public.signature_documents (organization_id, company_id);
create index if not exists signature_documents_deal_idx on public.signature_documents (organization_id, deal_id);
create index if not exists signature_documents_template_idx on public.signature_documents (organization_id, template_id);
create index if not exists signature_documents_month_idx on public.signature_documents (organization_id, sent_at);

alter table public.signature_documents enable row level security;
revoke all on public.signature_documents from anon, authenticated;
-- review 3 (10 November 2026): every column but `people` (the server reads it as definer); a new column needs its own grant
-- and its place in EXPORT_COLUMNS (src/features/imports/export-build.ts) and the person export's column list
grant select (id, organization_id, lead_id, contact_id, company_id, deal_id, template_id, title, body, status, sent_by, sent_at, viewed_at, signed_at, cancelled_at, cancelled_by, expires_at, content_sha256, former_lead_id, former_contact_id, former_company_id, former_deal_id, customer_deleted_at, erased_at, created_at, updated_at) on public.signature_documents to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'signature_documents' and policyname = 'signature_documents_select') then
    -- the record's readers (the activities rule); a detached document (219 ב): owners, admins and managers by role
    create policy signature_documents_select on public.signature_documents for select to authenticated
      using (app.is_member(organization_id)
             and case when num_nonnulls(lead_id, contact_id, company_id, deal_id) > 0
                      then app.can_read_activity_subject(lead_id, contact_id, company_id, deal_id)
                      else coalesce(app.role_in(organization_id) = any (array['owner', 'admin', 'manager']::public.membership_role[]), false)
                 end);
  end if;
end;
$$;

create or replace trigger signature_documents_touch before update on public.signature_documents
  for each row execute function app.touch_row();

-- owner (219) ב: a purged record leaves its documents detached (QUO-07's pattern). One function per table, so a column of
-- another table is never named (the PL/pgSQL rule in CLAUDE.md).
create or replace function app.signature_documents_detach_lead() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if not app.org_exists(old.organization_id) then
    return old;
  end if;
  update public.signature_documents d set lead_id = null, former_lead_id = old.id, customer_deleted_at = now()
   where d.organization_id = old.organization_id and d.lead_id = old.id;
  return old;
end;
$$;
create or replace function app.signature_documents_detach_contact() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if not app.org_exists(old.organization_id) then
    return old;
  end if;
  update public.signature_documents d set contact_id = null, former_contact_id = old.id, customer_deleted_at = now()
   where d.organization_id = old.organization_id and d.contact_id = old.id;
  return old;
end;
$$;
create or replace function app.signature_documents_detach_company() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if not app.org_exists(old.organization_id) then
    return old;
  end if;
  update public.signature_documents d set company_id = null, former_company_id = old.id, customer_deleted_at = now()
   where d.organization_id = old.organization_id and d.company_id = old.id;
  return old;
end;
$$;
create or replace function app.signature_documents_detach_deal() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if not app.org_exists(old.organization_id) then
    return old;
  end if;
  update public.signature_documents d set deal_id = null, former_deal_id = old.id, customer_deleted_at = now()
   where d.organization_id = old.organization_id and d.deal_id = old.id;
  return old;
end;
$$;
revoke all on function app.signature_documents_detach_lead() from public, anon, authenticated, service_role;
revoke all on function app.signature_documents_detach_contact() from public, anon, authenticated, service_role;
revoke all on function app.signature_documents_detach_company() from public, anon, authenticated, service_role;
revoke all on function app.signature_documents_detach_deal() from public, anon, authenticated, service_role;
create or replace trigger leads_signature_documents_detach before delete on public.leads
  for each row execute function app.signature_documents_detach_lead();
create or replace trigger contacts_signature_documents_detach before delete on public.contacts
  for each row execute function app.signature_documents_detach_contact();
create or replace trigger companies_signature_documents_detach before delete on public.companies
  for each row execute function app.signature_documents_detach_company();
create or replace trigger deals_signature_documents_detach before delete on public.deals
  for each row execute function app.signature_documents_detach_deal();

-- ----------------------------------------------------------------------------
-- The signature (as quote_decisions)
-- ----------------------------------------------------------------------------
create table if not exists public.signature_signatures (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  document_id       uuid not null,
  signed_at         timestamptz not null default now(),
  signer_name       text check (signer_name is null or char_length(btrim(signer_name)) between 2 and 120),
  signer_id_number  text check (signer_id_number is null or app.valid_israeli_id(signer_id_number)),
  signature_kind    text not null check (signature_kind in ('drawn', 'typed')),
  signature_image   text check (signature_image is null
                                or (char_length(signature_image) <= 300000 and signature_image ~ '^data:image/png;base64,[A-Za-z0-9+/]+=*$')),
  wording_version   text not null check (char_length(wording_version) between 1 and 40),
  content_sha256    text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  ip                text check (ip is null or char_length(ip) <= 64),
  user_agent        text check (user_agent is null or char_length(user_agent) <= 500),
  -- set if the personal fields are ever emptied (today a purge removes the row with its document)
  erased_at         timestamptz,
  created_at        timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, document_id),
  constraint signature_signatures_document_fk foreign key (organization_id, document_id)
    references public.signature_documents (organization_id, id) on delete cascade,
  constraint signature_signatures_shape check (
    erased_at is not null
    or (signer_name is not null and (signature_kind = 'typed' or signature_image is not null)))
);

alter table public.signature_signatures enable row level security;
revoke all on public.signature_signatures from anon, authenticated;
grant select on public.signature_signatures to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'signature_signatures' and policyname = 'signature_signatures_select') then
    -- as quote_decisions: owners and admins only
    create policy signature_signatures_select on public.signature_signatures for select to authenticated
      using (app.is_admin(organization_id));
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- Server-only tables (schema app: RLS on, no grants)
-- ----------------------------------------------------------------------------
create table if not exists app.signature_links (
  document_id             uuid primary key,
  organization_id         uuid not null,
  token_hash              text unique,
  created_by              uuid,
  created_at              timestamptz,
  window_started_at       timestamptz,
  window_count            integer not null default 0,
  sign_window_started_at  timestamptz,
  sign_count              integer not null default 0,
  -- (223) ב: the token hash the document was signed with; only that link downloads the signed PDF
  signed_token_hash       text,
  unique (organization_id, document_id),
  constraint signature_links_document_fk foreign key (organization_id, document_id)
    references public.signature_documents (organization_id, id) on delete cascade
);
alter table app.signature_links enable row level security;
revoke all on app.signature_links from public, anon, authenticated, service_role;

-- views per sender: 1,024 reused buckets per document, no hash stored
create table if not exists app.signature_link_view_counts (
  document_id   uuid not null references public.signature_documents (id) on delete cascade,
  bucket        integer not null check (bucket between 0 and 1023),
  window_start  timestamptz not null,
  views         integer not null,
  primary key (document_id, bucket)
);
alter table app.signature_link_view_counts enable row level security;
revoke all on app.signature_link_view_counts from public, anon, authenticated, service_role;

-- (223) ב: the customer's PDF downloads per sender: 1,024 reused buckets per document, no hash stored
create table if not exists app.signature_pdf_download_counts (
  document_id   uuid not null references public.signature_documents (id) on delete cascade,
  bucket        integer not null check (bucket between 0 and 1023),
  window_start  timestamptz not null,
  downloads     integer not null,
  primary key (document_id, bucket)
);
alter table app.signature_pdf_download_counts enable row level security;
revoke all on app.signature_pdf_download_counts from public, anon, authenticated, service_role;

-- documents sent for signature, per business and month in its zone (max_signatures_per_month)
create table if not exists app.signature_months (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  month           date not null,
  sent            integer not null default 0,
  primary key (organization_id, month)
);
alter table app.signature_months enable row level security;
revoke all on app.signature_months from public, anon, authenticated, service_role;

-- the upload paths handed out for a document's signed PDF; an unused one is queued for the orphan cleanup
create table if not exists app.signature_pdf_attempts (
  storage_path    text primary key,
  organization_id uuid not null,
  document_id     uuid not null references public.signature_documents (id) on delete cascade,
  created_at      timestamptz not null default now(),
  done_at         timestamptz
);
alter table app.signature_pdf_attempts enable row level security;
revoke all on app.signature_pdf_attempts from public, anon, authenticated, service_role;
create index if not exists signature_pdf_attempts_document_idx on app.signature_pdf_attempts (document_id);

-- review 5: the signing wordings, by version (as app.agreement_texts); a new wording is a new version in a new migration.
-- The text equals SIGN_WORDING in src/features/signatures/public.ts (unit test signature-documents). DRAFT until the lawyer.
create table if not exists app.signature_wording_versions (
  version    text primary key check (version ~ '^[a-z0-9-]{1,40}$'),
  wording    text not null check (char_length(wording) between 1 and 2000),
  created_at timestamptz not null default now()
);
alter table app.signature_wording_versions enable row level security;
revoke all on app.signature_wording_versions from public, anon, authenticated, service_role;
insert into app.signature_wording_versions (version, wording)
values ('sign-draft-2026-11-10', 'קראתי את המסמך ואני מאשר/ת את תוכנו. החתימה שלי כאן מחייבת כמו חתימה בכתב יד.')
on conflict (version) do nothing;

-- ----------------------------------------------------------------------------
-- The signed PDF on files: the tenth subject
-- ----------------------------------------------------------------------------
alter table public.files add column if not exists signature_document_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'files_signature_document_fk') then
    alter table public.files add constraint files_signature_document_fk foreign key (organization_id, signature_document_id)
      references public.signature_documents (organization_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'files_signature_document_shape') then
    alter table public.files add constraint files_signature_document_shape
      check (signature_document_id is null
             or (activity_id is null and custom_field_key is null and previous_id is null and mime_type = 'application/pdf'));
  end if;
end;
$$;

alter table public.files drop constraint if exists files_one_subject;
alter table public.files add constraint files_one_subject
  check (num_nonnulls(lead_id, contact_id, company_id, deal_id, accounting_document_id, payment_id, quote_id, order_id,
                      library_item_id, signature_document_id) = 1);

-- a signed document's PDF carries the SHA-256 of its bytes, as QUO-06's and ORD-05's server rows (021119's text plus the subject)
alter table public.files drop constraint if exists files_sha256_shape;
alter table public.files add constraint files_sha256_shape
  check (sha256 is null
         or ((quote_id is not null or order_id is not null or signature_document_id is not null) and sha256 ~ '^[0-9a-f]{64}$'));

create index if not exists files_signature_document_idx on public.files (organization_id, signature_document_id);
create unique index if not exists files_signature_document_one on public.files (organization_id, signature_document_id)
  where signature_document_id is not null;

-- files_select (021155's text): a signed document's PDF holds the signature, so it follows its document AND needs an owner or
-- admin (as QUO-09's signed PDF)
alter policy files_select on public.files
  using (app.is_member(organization_id)
         and case when accounting_document_id is not null
                  then exists (select 1 from public.accounting_documents d
                                where d.organization_id = files.organization_id and d.id = files.accounting_document_id)
                  when payment_id is not null
                  then exists (select 1 from public.payments pm
                                where pm.organization_id = files.organization_id and pm.id = files.payment_id)
                  when quote_id is not null
                  then exists (select 1 from public.quotes qu
                                where qu.organization_id = files.organization_id and qu.id = files.quote_id)
                       -- QUO-09: the signed PDF for owners and admins only
                       and (quote_signed is not true or app.is_admin(organization_id))
                  -- ORD-05: an order's PDF follows the order (orders_select)
                  when order_id is not null
                  then exists (select 1 from public.orders od
                                where od.organization_id = files.organization_id and od.id = files.order_id)
                  -- LIB-01: a library file follows its item (library_items_select)
                  when library_item_id is not null
                  then exists (select 1 from public.library_items li
                                where li.organization_id = files.organization_id and li.id = files.library_item_id)
                  -- SGN-02: a signed document's PDF: its document (signature_documents_select) and an owner or admin
                  when signature_document_id is not null
                  then app.is_admin(organization_id)
                       and exists (select 1 from public.signature_documents sd
                                    where sd.organization_id = files.organization_id and sd.id = files.signature_document_id)
                  else app.can_read_activity_subject(lead_id, contact_id, company_id, deal_id)
                       and (activity_id is null
                            or exists (select 1 from public.activities a
                                        where a.organization_id = files.organization_id and a.id = files.activity_id))
             end);

-- files_insert and files_delete need no change: their last branch asks app.can_read_activity_subject of a row without a
-- record, which is false, so no person adds or removes a signed document's PDF. The storage policy record_files_delete
-- (021155's text) would let an owner or admin remove the object of a row with no document, payment, quote or order; a signed
-- document's PDF joins that list
alter policy record_files_delete on storage.objects
  using (bucket_id = 'record-files'
         and exists (select 1 from public.files f
                      where f.storage_path = objects.name and app.can_write(f.organization_id)
                        and (f.uploaded_by = (select auth.uid()) or app.is_admin(f.organization_id))
                        and ((f.accounting_document_id is null and f.payment_id is null and f.quote_id is null and f.order_id is null
                              and f.signature_document_id is null)
                             or (f.unconfirmed_since is not null and f.uploaded_by = (select auth.uid()))
                             or ((f.quote_id is not null or f.order_id is not null) and f.unconfirmed_since is not null
                                 and app.is_admin(f.organization_id)))
                        and (f.custom_field_key is null or not app.field_file_in_use(f.organization_id, f.id))
                        and (f.library_item_id is null or app.library_writable(f.organization_id))));

-- ----------------------------------------------------------------------------
-- Helpers (internal, no grants)
-- ----------------------------------------------------------------------------
-- the document's record: its owner, team and whether it is in the bin; null when it is gone
create or replace function app.signature_record_row(p_org uuid, p_type text, p_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_row jsonb;
begin
  if p_type not in ('lead', 'contact', 'company', 'deal') or p_id is null then
    return null;
  end if;
  execute format('select jsonb_build_object(''owner_id'', t.owner_id, ''team_id'', t.team_id, ''deleted_at'', t.deleted_at)
                    from public.%I t where t.organization_id = $1 and t.id = $2',
                 case p_type when 'lead' then 'leads' when 'contact' then 'contacts' when 'company' then 'companies' else 'deals' end)
    into v_row using p_org, p_id;
  return v_row;
end;
$$;
revoke all on function app.signature_record_row(uuid, text, uuid) from public, anon, authenticated, service_role;

create or replace function app.signature_record_type(p_doc public.signature_documents) returns text
language sql immutable
set search_path = ''
as $$
  select case when p_doc.lead_id is not null then 'lead' when p_doc.contact_id is not null then 'contact'
              when p_doc.company_id is not null then 'company' when p_doc.deal_id is not null then 'deal' end
$$;
revoke all on function app.signature_record_type(public.signature_documents) from public, anon, authenticated, service_role;

create or replace function app.signature_record_id(p_doc public.signature_documents) returns uuid
language sql immutable
set search_path = ''
as $$
  select coalesce(p_doc.lead_id, p_doc.contact_id, p_doc.company_id, p_doc.deal_id)
$$;
revoke all on function app.signature_record_id(public.signature_documents) from public, anon, authenticated, service_role;

-- the SHA-256 of what the customer reads: the title, the filled text and the time it was sent (written in UTC, so the
-- session's time zone never changes it)
create or replace function app.signature_fingerprint(p_doc public.signature_documents) returns text
language sql immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(jsonb_build_object(
           'title', p_doc.title,
           'body', p_doc.body,
           'sent_at', to_char(p_doc.sent_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text, 'UTF8')), 'hex')
$$;
revoke all on function app.signature_fingerprint(public.signature_documents) from public, anon, authenticated, service_role;

-- The one rule for a link: everything but this shows the document or its state
create or replace function app.signature_link_usable(p_doc public.signature_documents) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_record jsonb;
begin
  if p_doc.id is null or not app.org_public_pages_open(p_doc.organization_id)
     or not app.org_has_feature(p_doc.organization_id, 'signatures') then
    return false;
  end if;
  v_record := app.signature_record_row(p_doc.organization_id, app.signature_record_type(p_doc), app.signature_record_id(p_doc));
  return v_record is not null and (v_record ->> 'deleted_at') is null;
end;
$$;
revoke all on function app.signature_link_usable(public.signature_documents) from public, anon, authenticated, service_role;

-- the sender, scoped to one document: nothing matches across documents or businesses
create or replace function app.signature_link_sender(p_doc uuid, p_hash text) returns text
language sql immutable
set search_path = ''
as $$
  select case when p_hash is null or p_doc is null then null
              else encode(sha256(convert_to('signature:' || p_doc::text || ':' || p_hash, 'UTF8')), 'hex') end
$$;
revoke all on function app.signature_link_sender(uuid, text) from public, anon, authenticated, service_role;

-- the document behind a token, or P0002 (the one rule)
create or replace function app.signature_token_document(p_token text) returns public.signature_documents
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_link app.signature_links;
  v_doc public.signature_documents;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'document not found' using errcode = 'P0002';
  end if;
  select * into v_link from app.signature_links l where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found then
    raise exception 'document not found' using errcode = 'P0002';
  end if;
  select * into v_doc from public.signature_documents d where d.organization_id = v_link.organization_id and d.id = v_link.document_id;
  if not found or not app.signature_link_usable(v_doc) then
    raise exception 'document not found' using errcode = 'P0002';
  end if;
  return v_doc;
end;
$$;
revoke all on function app.signature_token_document(text) from public, anon, authenticated, service_role;

-- 48 random bytes, base64url: 64 characters
create or replace function app.signature_new_token() returns text
language sql volatile
set search_path = ''
as $$
  select translate(
    encode(decode(replace(gen_random_uuid()::text || gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'), 'base64'),
    E'+/=\n', '-_')
$$;
revoke all on function app.signature_new_token() from public, anon, authenticated, service_role;

-- puts a new token on the document's link (replacing the old one) and answers it
create or replace function app.signature_link_issue(p_doc public.signature_documents) returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_token text := app.signature_new_token();
begin
  insert into app.signature_links as l (document_id, organization_id, token_hash, created_by, created_at)
  values (p_doc.id, p_doc.organization_id, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), auth.uid(), now())
  on conflict (document_id) do update
    set token_hash = excluded.token_hash,
        created_by = excluded.created_by,
        created_at = excluded.created_at,
        window_started_at = null,
        window_count = 0,
        sign_window_started_at = null,
        sign_count = 0;
  return v_token;
end;
$$;
revoke all on function app.signature_link_issue(public.signature_documents) from public, anon, authenticated, service_role;

-- a timeline entry on the document's record (server written; app.activities_signature_entry_guard keeps people out)
create or replace function app.signature_timeline(p_doc public.signature_documents, p_kind text, p_body text, p_author uuid)
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  insert into public.activities (organization_id, type, lead_id, contact_id, company_id, deal_id, body, metadata, created_by)
  values (p_doc.organization_id, 'system', p_doc.lead_id, p_doc.contact_id, p_doc.company_id, p_doc.deal_id, p_body,
          jsonb_build_object('kind', p_kind, 'signature_document_id', p_doc.id), p_author);
end;
$$;
revoke all on function app.signature_timeline(public.signature_documents, text, text, uuid) from public, anon, authenticated, service_role;

-- The caller may manage the document: they may edit its live record, in a writable business with the key
create or replace function app.signature_managed_document(p_org uuid, p_doc uuid) returns public.signature_documents
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_doc public.signature_documents;
  v_record jsonb;
begin
  select * into v_doc from public.signature_documents d where d.organization_id = p_org and d.id = p_doc;
  if found then
    v_record := app.signature_record_row(p_org, app.signature_record_type(v_doc), app.signature_record_id(v_doc));
  end if;
  if v_doc.id is null or v_record is null or (v_record ->> 'deleted_at') is not null
     or not app.can_write(p_org)
     or not app.can_edit_record(p_org, (v_record ->> 'owner_id')::uuid, (v_record ->> 'team_id')::uuid) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not app.org_writable(p_org) then
    raise exception 'the business is read only' using errcode = '42501';
  end if;
  if not app.org_has_feature(p_org, 'signatures') then
    raise exception 'signatures are not in the plan' using errcode = 'P0001', hint = 'feature:signatures';
  end if;
  return v_doc;
end;
$$;
revoke all on function app.signature_managed_document(uuid, uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Sending
-- ----------------------------------------------------------------------------
-- ----------------------------------------------------------------------------
-- Owner (224) ב: the sender may edit the free text before sending; locked sections and merge-field values may not change
-- ----------------------------------------------------------------------------
-- A template marks a locked section with a line "::: נעול" before it and a line ":::" after it (each alone on its line,
-- spaces around allowed). Sections do not nest; at most 20; none empty (app.document_locked_segments = lockedSegments() in
-- src/features/document-templates/locked.ts; both run tests/unit/fixtures/document-locked-sections.json). The template check
-- refuses a malformed one (hint document_template:locked). The markers are never sent: the document is the template's lines
-- without them.
-- The fill is the SERVER's (app.signature_document_fill, here in SQL, from the template and the record read as the server
-- with the caller's read rights on linked records): public.signature_document_draft answers it to the app (the sender's
-- editor), and public.signature_document_send judges the sent text against it, never against anything the client says: every
-- locked section as filled, and every merge-field value filled into the free text, must appear unchanged and in this order
-- (hint signature_document:locked_changed). A field with no value still stops sending (signature_document:unfilled). What is
-- sent is what the customer reads and signs (the fingerprint).

-- a value as literal text in REC-04's cleaned Markdown (= markdownLiteral in src/features/document-templates/fields.ts)
create or replace function app.document_literal(p_value text) returns text
language sql immutable
set search_path = ''
as $$
  select regexp_replace(regexp_replace(coalesce(p_value, ''), '\s*[\r\n]+\s*', ' ', 'g'), '([][\\*()#_`-])', '\\\1', 'g')
$$;
revoke all on function app.document_literal(text) from public, anon, authenticated, service_role;

-- the byte after a gender block part's "label:" head (app.template_variant_head's walk), or -1
create or replace function app.document_variant_head_end(p_bytes bytea, p_at integer, p_end integer) returns integer
language plpgsql immutable
set search_path = ''
as $$
declare
  v_p integer := p_at;
begin
  while v_p < p_end and get_byte(p_bytes, v_p) = 32 loop
    v_p := v_p + 1;
  end loop;
  if v_p + 6 <= p_end and substring(p_bytes from v_p + 1 for 6) = decode('d796d79bd7a8', 'hex') then
    v_p := v_p + 6;
  elsif v_p + 8 <= p_end and substring(p_bytes from v_p + 1 for 8) = decode('d7a0d7a7d791d794', 'hex') then
    v_p := v_p + 8;
  elsif v_p + 12 <= p_end and substring(p_bytes from v_p + 1 for 12) = decode('d7a0d799d798d7a8d79cd799', 'hex') then
    v_p := v_p + 12;
  else
    return -1;
  end if;
  while v_p < p_end and get_byte(p_bytes, v_p) = 32 loop
    v_p := v_p + 1;
  end loop;
  if v_p < p_end and get_byte(p_bytes, v_p) = 58 then
    return v_p + 1;
  end if;
  return -1;
end;
$$;
revoke all on function app.document_variant_head_end(bytea, integer, integer) from public, anon, authenticated, service_role;

-- HEB-01's pick (= pickVariants in src/features/whatsapp/variants.ts; test 324 runs tests/unit/fixtures/gender-variants.json):
-- every block becomes the part for the gender (male / female when the block has it), else the neutral part; a text with a
-- problem is left as it is
create or replace function app.document_pick_variants(p_text text, p_gender text) returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v_b bytea := convert_to(coalesce(p_text, ''), 'UTF8');
  v_n integer := length(convert_to(coalesce(p_text, ''), 'UTF8'));
  v_out bytea := ''::bytea;
  v_at integer := 0;
  v_i integer := 0;
  v_j integer;
  v_depth integer;
  v_close integer;
  v_ch integer;
  v_bounds integer[];
  v_k integer;
  v_label text;
  v_head integer;
  v_part text;
  v_male text;
  v_female text;
  v_neutral text;
begin
  if app.template_variant_problem(p_text) is not null then
    return p_text;
  end if;
  while v_i < v_n loop
    if get_byte(v_b, v_i) <> 123 or app.template_variant_head(v_b, v_i + 1, v_n) is null then
      v_i := v_i + 1;
      continue;
    end if;
    v_depth := 0;
    v_close := -1;
    v_bounds := array[v_i];
    v_j := v_i + 1;
    while v_j < v_n loop
      v_ch := get_byte(v_b, v_j);
      if v_ch = 123 then
        v_depth := 1;
      elsif v_ch = 125 then
        if v_depth = 0 then
          v_close := v_j;
          exit;
        end if;
        v_depth := 0;
      elsif v_ch = 124 and v_depth = 0 then
        v_bounds := v_bounds || v_j;
      end if;
      v_j := v_j + 1;
    end loop;
    v_bounds := v_bounds || v_close;
    v_male := null;
    v_female := null;
    v_neutral := null;
    for v_k in 1 .. array_length(v_bounds, 1) - 1 loop
      v_label := app.template_variant_head(v_b, v_bounds[v_k] + 1, v_bounds[v_k + 1]);
      v_head := app.document_variant_head_end(v_b, v_bounds[v_k] + 1, v_bounds[v_k + 1]);
      v_part := btrim(convert_from(substring(v_b from v_head + 1 for v_bounds[v_k + 1] - v_head), 'UTF8'), E' \t\n\r');
      if v_label = 'male' then
        v_male := v_part;
      elsif v_label = 'female' then
        v_female := v_part;
      else
        v_neutral := v_part;
      end if;
    end loop;
    v_out := v_out || substring(v_b from v_at + 1 for v_i - v_at)
             || convert_to(coalesce(case p_gender when 'male' then v_male when 'female' then v_female end, v_neutral, ''), 'UTF8');
    v_at := v_close + 1;
    v_i := v_close + 1;
  end loop;
  return convert_from(v_out || substring(v_b from v_at + 1 for v_n - v_at), 'UTF8');
end;
$$;
revoke all on function app.document_pick_variants(text, text) from public, anon, authenticated, service_role;

-- the characters a document for signature never holds (bidi controls and invisible ones: U+200B-U+200F, U+202A-U+202E,
-- U+2066-U+2069, U+2028, U+2029), removed from what the SERVER puts in (record values, template text); what the sender types
-- is refused instead (signature_document_send). Written with chr() (the connector rule).
create or replace function app.document_invisible_class() returns text
language sql immutable
set search_path = ''
as $$
  select '[' || chr(8203) || '-' || chr(8207) || chr(8234) || '-' || chr(8238)
         || chr(8294) || '-' || chr(8297) || chr(8232) || chr(8233) || ']'
$$;
revoke all on function app.document_invisible_class() from public, anon, authenticated, service_role;

create or replace function app.document_strip_invisible(p_text text) returns text
language sql immutable
set search_path = ''
as $$
  select regexp_replace(coalesce(p_text, ''), app.document_invisible_class(), '', 'g')
$$;
revoke all on function app.document_strip_invisible(text) from public, anon, authenticated, service_role;

-- a text's merge fields filled in one pass (= fillDocument's replacement): {text, anchors} where anchors are the values put
-- in, in order; a field without a value stays as it is
create or replace function app.document_fill(p_text text, p_values jsonb) returns jsonb
language plpgsql immutable
set search_path = ''
as $$
declare
  v_parts text[] := regexp_split_to_array(coalesce(p_text, ''), '\{[^{}:|\n]{1,30}\}');
  v_out text := v_parts[1];
  v_anchors text[] := '{}';
  v_match record;
  v_value text;
begin
  for v_match in
    select t.m[1] as name, t.ord from regexp_matches(coalesce(p_text, ''), '\{([^{}:|\n]{1,30})\}', 'g') with ordinality as t(m, ord)
     order by t.ord
  loop
    -- a value copied from a phone often carries direction marks: removed before it enters the body and the anchors
    v_value := nullif(btrim(app.document_strip_invisible(p_values ->> v_match.name)), '');
    if v_value is null then
      v_out := v_out || '{' || v_match.name || '}';
    else
      v_value := app.document_literal(v_value);
      v_out := v_out || v_value;
      v_anchors := v_anchors || v_value;
    end if;
    v_out := v_out || coalesce(v_parts[v_match.ord + 1], '');
  end loop;
  return jsonb_build_object('text', v_out, 'anchors', to_jsonb(v_anchors));
end;
$$;
revoke all on function app.document_fill(text, jsonb) from public, anon, authenticated, service_role;

-- the template's lines in runs, locked or free, without the markers; or the first problem
create or replace function app.document_locked_segments(p_text text) returns jsonb
language plpgsql immutable
set search_path = ''
as $$
declare
  v_lines text[] := string_to_array(replace(coalesce(p_text, ''), E'\r\n', E'\n'), E'\n');
  v_line text;
  v_mark text;
  v_open boolean := false;
  v_sections integer := 0;
  v_segments jsonb := '[]';
  v_run text[] := '{}';
  v_run_locked boolean := false;
  v_has boolean;
begin
  foreach v_line in array v_lines loop
    v_mark := btrim(v_line, E' \t');
    if v_mark ~ '^:::[ \t]*נעול$' then
      if v_open then
        return jsonb_build_object('problem', 'nested');
      end if;
      if cardinality(v_run) > 0 then
        v_segments := v_segments || jsonb_build_array(jsonb_build_object('locked', v_run_locked, 'text', array_to_string(v_run, E'\n')));
      end if;
      v_run := '{}';
      v_open := true;
      v_run_locked := true;
      v_sections := v_sections + 1;
      if v_sections > 20 then
        return jsonb_build_object('problem', 'too_many');
      end if;
    elsif v_mark = ':::' then
      if not v_open then
        return jsonb_build_object('problem', 'stray');
      end if;
      select coalesce(bool_or(btrim(x, E' \t') <> ''), false) into v_has from unnest(v_run) x;
      if not v_has then
        return jsonb_build_object('problem', 'empty');
      end if;
      v_segments := v_segments || jsonb_build_array(jsonb_build_object('locked', true, 'text', array_to_string(v_run, E'\n')));
      v_run := '{}';
      v_open := false;
      v_run_locked := false;
    else
      v_run := v_run || v_line;
    end if;
  end loop;
  if v_open then
    return jsonb_build_object('problem', 'unclosed');
  end if;
  if cardinality(v_run) > 0 then
    v_segments := v_segments || jsonb_build_array(jsonb_build_object('locked', false, 'text', array_to_string(v_run, E'\n')));
  end if;
  return jsonb_build_object('problem', null, 'segments', v_segments);
end;
$$;
revoke all on function app.document_locked_segments(text) from public, anon, authenticated, service_role;
-- the template check runs as the writer (security invoker)
grant execute on function app.document_locked_segments(text) to authenticated;

-- the merge values of a record and of the business (= readRecordDocumentValues + businessDocumentValues), read as the
-- server; a linked contact or company counts only when the caller reads it (as the app read them with the user's session)
create or replace function app.document_record_values(p_org uuid, p_type text, p_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_org public.organizations;
  v_set public.org_document_settings;
  v_user text;
  v_values jsonb;
  v_gender text;
  v_lead public.leads;
  v_contact public.contacts;
  v_company public.companies;
  v_deal public.deals;
  v_person public.contacts;
  v_firm public.companies;
  v_money numeric;
begin
  select * into v_org from public.organizations o where o.id = p_org;
  select * into v_set from public.org_document_settings s where s.organization_id = p_org;
  select nullif(btrim(p.full_name), '') into v_user from public.profiles p where p.id = auth.uid();
  v_values := jsonb_build_object(
    'שם העסק', nullif(btrim(v_org.name), ''),
    'השם הרשום של העסק', coalesce(nullif(btrim(v_set.legal_name), ''), nullif(btrim(v_org.name), '')),
    'מספר העוסק', nullif(btrim(v_set.tax_id), ''),
    'כתובת העסק', nullif(concat_ws(', ', nullif(btrim(v_set.address_line), ''), nullif(btrim(v_set.city), '')), ''),
    'טלפון העסק', coalesce(nullif(btrim(v_set.phone), ''), nullif(btrim(v_org.phone), '')),
    'אימייל העסק', nullif(btrim(v_set.email), ''),
    'שם הנציג', coalesce(v_user, (select nullif(btrim(u.email), '') from auth.users u where u.id = auth.uid()), 'משתמש'),
    'תאריך היום', to_char((now() at time zone app.intake_zone(v_org.timezone))::date, 'DD.MM.YYYY'));

  if p_type = 'lead' then
    select * into v_lead from public.leads l where l.organization_id = p_org and l.id = p_id;
    v_values := v_values || jsonb_build_object(
      'שם מלא', nullif(btrim(v_lead.full_name), ''),
      'שם פרטי', nullif(split_part(btrim(regexp_replace(coalesce(v_lead.full_name, ''), '\s+', ' ', 'g')), ' ', 1), ''),
      'טלפון', nullif(btrim(v_lead.phone), ''),
      'אימייל', nullif(btrim(v_lead.email), ''),
      'שם החברה', nullif(btrim(v_lead.company_name), ''),
      'תפקיד', nullif(btrim(v_lead.job_title), ''));
    v_gender := v_lead.gender;
  elsif p_type = 'contact' then
    select * into v_contact from public.contacts c where c.organization_id = p_org and c.id = p_id;
    if v_contact.company_id is not null and app.can_read_activity_subject(null, null, v_contact.company_id, null) then
      select * into v_firm from public.companies c where c.organization_id = p_org and c.id = v_contact.company_id;
    end if;
    v_values := v_values || jsonb_build_object(
      'שם מלא', nullif(btrim(v_contact.full_name), ''),
      'שם פרטי', coalesce(nullif(btrim(v_contact.first_name), ''),
                          nullif(split_part(btrim(regexp_replace(coalesce(v_contact.full_name, ''), '\s+', ' ', 'g')), ' ', 1), '')),
      'שם משפחה', nullif(btrim(v_contact.last_name), ''),
      'טלפון', nullif(btrim(v_contact.phone), ''),
      'אימייל', nullif(btrim(v_contact.email), ''),
      'תפקיד', nullif(btrim(v_contact.job_title), ''),
      'כתובת', nullif(concat_ws(', ', nullif(btrim(v_contact.address_line), ''), nullif(btrim(v_contact.city), '')), ''),
      'תעודת זהות', nullif(btrim(v_contact.billing_tax_id), ''),
      'כתובת לחיוב', coalesce(nullif(btrim(v_contact.billing_address), ''), nullif(btrim(v_firm.billing_address), '')),
      'שם החברה', nullif(btrim(v_firm.name), ''),
      'תאריך לידה', to_char(v_contact.birth_date, 'DD.MM.YYYY'));
    v_gender := v_contact.gender;
  elsif p_type = 'company' then
    select * into v_company from public.companies c where c.organization_id = p_org and c.id = p_id;
    v_values := v_values || jsonb_build_object(
      'שם החברה', nullif(btrim(v_company.name), ''),
      'מספר החברה', nullif(btrim(v_company.tax_id), ''),
      'כתובת', nullif(concat_ws(', ', nullif(btrim(v_company.address_line), ''), nullif(btrim(v_company.city), '')), ''),
      'טלפון', nullif(btrim(v_company.phone), ''),
      'אימייל', nullif(btrim(v_company.email), ''),
      'שם לחיוב', coalesce(nullif(btrim(v_company.billing_name), ''), nullif(btrim(v_company.name), '')),
      'כתובת לחיוב', nullif(btrim(v_company.billing_address), ''));
  elsif p_type = 'deal' then
    select * into v_deal from public.deals d where d.organization_id = p_org and d.id = p_id;
    if v_deal.contact_id is not null and app.can_read_activity_subject(null, v_deal.contact_id, null, null) then
      select * into v_person from public.contacts c where c.organization_id = p_org and c.id = v_deal.contact_id;
    end if;
    if v_deal.company_id is not null and app.can_read_activity_subject(null, null, v_deal.company_id, null) then
      select * into v_firm from public.companies c where c.organization_id = p_org and c.id = v_deal.company_id;
    end if;
    v_money := v_deal.amount_agorot / 100.0;
    v_values := v_values || jsonb_build_object(
      'שם העסקה', nullif(btrim(v_deal.name), ''),
      'סכום העסקה', case when v_deal.amount_agorot is null then null
                         when v_deal.amount_agorot % 100 = 0 then to_char(v_money, 'FM999,999,999,999,990') || ' ₪'
                         else to_char(v_money, 'FM999,999,999,999,990.00') || ' ₪' end,
      'תאריך סגירה צפוי', to_char(v_deal.expected_close_date, 'DD.MM.YYYY'),
      'שם מלא', nullif(btrim(v_person.full_name), ''),
      'שם פרטי', coalesce(nullif(btrim(v_person.first_name), ''),
                          nullif(split_part(btrim(regexp_replace(coalesce(v_person.full_name, ''), '\s+', ' ', 'g')), ' ', 1), '')),
      'טלפון', nullif(btrim(v_person.phone), ''),
      'אימייל', nullif(btrim(v_person.email), ''),
      'שם החברה', nullif(btrim(v_firm.name), ''));
    v_gender := v_person.gender;
  end if;
  return jsonb_build_object('values', jsonb_strip_nulls(v_values), 'gender', v_gender);
end;
$$;
revoke all on function app.document_record_values(uuid, text, uuid) from public, anon, authenticated, service_role;

-- the server's fill of a template for a record: segments [{locked, text, anchors}] and the body (the segments' texts)
create or replace function app.signature_document_fill(p_org uuid, p_template public.document_templates, p_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_read jsonb := app.document_record_values(p_org, p_template.record_type, p_id);
  v_split jsonb := app.document_locked_segments(p_template.body);
  v_seg jsonb;
  v_filled jsonb;
  v_out jsonb := '[]';
  v_texts text[] := '{}';
begin
  if v_split ->> 'problem' is not null then
    raise exception 'a locked section of the template is malformed' using errcode = 'P0001', hint = 'document_template:locked';
  end if;
  for v_seg in select x from jsonb_array_elements(v_split -> 'segments') x loop
    v_filled := app.document_fill(app.document_strip_invisible(app.document_pick_variants(v_seg ->> 'text', v_read ->> 'gender')),
                                  v_read -> 'values');
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'locked', (v_seg ->> 'locked')::boolean,
      'text', v_filled ->> 'text',
      -- a locked section is judged whole; in free text each value put in
      'anchors', case when (v_seg ->> 'locked')::boolean then jsonb_build_array(v_filled ->> 'text') else v_filled -> 'anchors' end));
    v_texts := v_texts || (v_filled ->> 'text');
  end loop;
  return jsonb_build_object('segments', v_out, 'body', array_to_string(v_texts, E'\n'));
end;
$$;
revoke all on function app.signature_document_fill(uuid, public.document_templates, uuid) from public, anon, authenticated, service_role;

-- every anchor appears in the text, unchanged and in order (an empty anchor is nothing to find)
create or replace function app.signature_anchors_kept(p_body text, p_segments jsonb) returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  v_at integer := 1;
  v_row record;
  v_pos integer;
  v_from integer;
  v_end integer;
  v_found boolean;
  v_body text := replace(coalesce(p_body, ''), E'\r\n', E'\n');
  v_len integer := char_length(replace(coalesce(p_body, ''), E'\r\n', E'\n'));
begin
  for v_row in
    select t.a as anchor, coalesce((s.seg ->> 'locked')::boolean, false) as locked
      from jsonb_array_elements(p_segments) with ordinality s(seg, i),
           jsonb_array_elements_text(s.seg -> 'anchors') with ordinality t(a, j)
     order by s.i, t.j
  loop
    continue when v_row.anchor = '';
    if not v_row.locked then
      -- a filled value in the free text: anywhere after the previous anchor
      v_pos := strpos(substr(v_body, v_at), v_row.anchor);
      if v_pos = 0 then
        return false;
      end if;
      v_at := v_at + v_pos - 1 + char_length(v_row.anchor);
    else
      -- review 1 (10 November 2026): a locked section is WHOLE LINES only: it starts the body or follows a line break, and
      -- ends the body or is followed by one, so no text may be added on its own lines (before, after, or around it)
      v_from := v_at;
      v_found := false;
      loop
        v_pos := strpos(substr(v_body, v_from), v_row.anchor);
        exit when v_pos = 0;
        v_pos := v_from + v_pos - 1;
        v_end := v_pos + char_length(v_row.anchor) - 1;
        if (v_pos = 1 or substr(v_body, v_pos - 1, 1) = E'\n') and (v_end = v_len or substr(v_body, v_end + 1, 1) = E'\n') then
          v_found := true;
          exit;
        end if;
        v_from := v_pos + 1;
      end loop;
      if not v_found then
        return false;
      end if;
      v_at := v_end + 1;
    end if;
  end loop;
  return true;
end;
$$;
revoke all on function app.signature_anchors_kept(text, jsonb) from public, anon, authenticated, service_role;

-- the sender's editor: the template filled by the server for the record, in segments; the same rights as sending
create or replace function public.signature_document_draft(p_org uuid, p_template uuid, p_record_type text, p_record_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_record jsonb := app.signature_record_row(p_org, p_record_type, p_record_id);
  v_template public.document_templates;
  v_fill jsonb;
begin
  if p_org is null or v_record is null or (v_record ->> 'deleted_at') is not null
     or not app.can_write(p_org)
     or not app.can_edit_record(p_org, (v_record ->> 'owner_id')::uuid, (v_record ->> 'team_id')::uuid) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not app.org_has_feature(p_org, 'signatures') then
    raise exception 'signatures are not in the plan' using errcode = 'P0001', hint = 'feature:signatures';
  end if;
  select * into v_template from public.document_templates t
   where t.organization_id = p_org and t.id = p_template and t.is_active and t.record_type = p_record_type;
  if not found then
    raise exception 'pick an active template of this record type' using errcode = 'P0001', hint = 'signature_document:template';
  end if;
  v_fill := app.signature_document_fill(p_org, v_template, p_record_id);
  return jsonb_build_object(
    'title', v_template.name,
    'draft_wording', v_template.draft_wording,
    'segments', (select coalesce(jsonb_agg(jsonb_build_object('locked', s -> 'locked', 'text', s -> 'text') order by i), '[]')
                   from jsonb_array_elements(v_fill -> 'segments') with ordinality x(s, i)),
    'unfilled', (select coalesce(jsonb_agg(distinct m[1]), '[]')
                   from regexp_matches(v_fill ->> 'body', '\{([^{}:|\n]{1,30})\}', 'g') as m
                  where m[1] = any (app.document_merge_fields(p_record_type))));
end;
$$;
revoke all on function public.signature_document_draft(uuid, uuid, text, uuid) from public, anon;
grant execute on function public.signature_document_draft(uuid, uuid, text, uuid) to authenticated;

-- SGN-01's template check (021200's body) with the locked sections added
create or replace function app.document_templates_check() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_problem text;
begin
  if tg_op = 'UPDATE' then
    if new.body is not distinct from old.body and new.record_type is not distinct from old.record_type then
      return new;
    end if;
    -- a changed wording is the business's own, no longer the seeded draft
    if new.body is distinct from old.body then
      new.draft_wording := false;
    end if;
  end if;
  -- longer than the column allows: its check constraint refuses it, without walking it
  if char_length(new.body) > 20000 then
    return new;
  end if;
  v_problem := app.template_variant_problem(new.body);
  if v_problem = 'neutral' then
    raise exception 'a gender wording needs its neutral part' using errcode = 'P0001', hint = 'document_template:neutral';
  elsif v_problem is not null then
    raise exception 'a gender wording is malformed' using errcode = 'P0001', hint = 'document_template:variant';
  end if;
  if app.document_unknown_field(new.body, new.record_type) is not null then
    raise exception 'unknown merge field' using errcode = 'P0001', hint = 'document_template:field';
  end if;
  -- (224) ב: "::: נעול" ... ":::" sections, not nested, at most 20, none empty
  if app.document_locked_segments(new.body) ->> 'problem' is not null then
    raise exception 'a locked section is malformed' using errcode = 'P0001', hint = 'document_template:locked';
  end if;
  return new;
end;
$$;
revoke all on function app.document_templates_check() from public, anon, authenticated;

create or replace function public.signature_document_send(
  p_org uuid, p_template uuid, p_record_type text, p_record_id uuid, p_title text, p_body text,
  p_valid_days integer default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_record jsonb;
  v_template public.document_templates;
  v_title text := btrim(coalesce(p_title, ''));
  v_limit numeric;
  v_month date;
  v_sent integer;
  v_doc public.signature_documents;
  v_token text;
  v_field text;
  v_fill jsonb;
begin
  v_record := app.signature_record_row(p_org, p_record_type, p_record_id);
  if p_org is null or v_record is null or (v_record ->> 'deleted_at') is not null
     or not app.can_write(p_org)
     or not app.can_edit_record(p_org, (v_record ->> 'owner_id')::uuid, (v_record ->> 'team_id')::uuid) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not app.org_writable(p_org) then
    raise exception 'the business is read only' using errcode = '42501';
  end if;
  if not app.org_has_feature(p_org, 'signatures') then
    raise exception 'signatures are not in the plan' using errcode = 'P0001', hint = 'feature:signatures';
  end if;
  select * into v_template from public.document_templates t
   where t.organization_id = p_org and t.id = p_template and t.is_active and t.record_type = p_record_type;
  if not found then
    raise exception 'pick an active template of this record type' using errcode = 'P0001', hint = 'signature_document:template';
  end if;
  if v_title = '' then
    v_title := v_template.name;
  end if;
  if char_length(v_title) > 120 or v_title ~ '[[:cntrl:]]' then
    raise exception 'the title is too long' using errcode = 'P0001', hint = 'signature_document:title';
  end if;
  if p_body is null or char_length(btrim(p_body)) = 0 or char_length(p_body) > 30000 then
    raise exception 'the document is empty or too long' using errcode = 'P0001', hint = 'signature_document:body';
  end if;
  if p_valid_days is not null and p_valid_days not between 1 and 365 then
    raise exception 'the validity is 1 to 365 days' using errcode = 'P0001', hint = 'signature_document:valid_days';
  end if;
  -- delta review (10 November 2026): no bidi controls or invisible characters in what the customer signs, so a hidden
  -- direction mark cannot change how a locked section reads. The server's fill removes them from record values and template
  -- text (app.document_strip_invisible), so any left in the body or the title is what the sender typed: refused.
  if (p_body || v_title) ~ app.document_invisible_class() then
    raise exception 'the document holds invisible or direction characters' using errcode = 'P0001', hint = 'signature_document:invisible';
  end if;
  -- (224) ב: the server's own fill of the template for this record
  v_fill := app.signature_document_fill(p_org, v_template, p_record_id);
  -- every merge field of the record's type must be filled (a customer signs what they read, nothing still in braces), in
  -- the text sent and in the server's fill (deleting a field the record has no value for does not get around it)
  select m[1] into v_field
    from regexp_matches(p_body || E'\n' || (v_fill ->> 'body'), '\{([^{}:|\n]{1,30})\}', 'g') as m
   where m[1] = any (app.document_merge_fields(p_record_type))
   limit 1;
  if v_field is not null then
    raise exception 'a merge field is not filled' using errcode = 'P0001', hint = 'signature_document:unfilled';
  end if;
  -- (224) ב: the free text may be edited; every locked section and every value the server filled in stays, in order
  if not app.signature_anchors_kept(p_body, v_fill -> 'segments') then
    raise exception 'a locked section or a filled value was changed' using errcode = 'P0001', hint = 'signature_document:locked_changed';
  end if;

  -- the cap: documents sent this month in the business zone (one sender at a time per business)
  v_limit := app.org_limit(p_org, 'max_signatures_per_month');
  v_month := date_trunc('month', now() at time zone app.intake_zone((select o.timezone from public.organizations o where o.id = p_org)))::date;
  insert into app.signature_months (organization_id, month, sent) values (p_org, v_month, 0)
  on conflict (organization_id, month) do nothing;
  select m.sent into v_sent from app.signature_months m where m.organization_id = p_org and m.month = v_month for update;
  if v_limit is not null and v_sent >= v_limit then
    raise exception 'monthly signature limit reached' using errcode = 'P0001', hint = 'limit:max_signatures_per_month';
  end if;
  update app.signature_months m set sent = m.sent + 1 where m.organization_id = p_org and m.month = v_month;

  insert into public.signature_documents (organization_id, lead_id, contact_id, company_id, deal_id, template_id, title, body,
                                          sent_by, sent_at, expires_at, content_sha256)
  values (p_org,
          case when p_record_type = 'lead' then p_record_id end,
          case when p_record_type = 'contact' then p_record_id end,
          case when p_record_type = 'company' then p_record_id end,
          case when p_record_type = 'deal' then p_record_id end,
          v_template.id, v_title, p_body, auth.uid(), now(),
          case when p_valid_days is not null then now() + make_interval(days => p_valid_days) end,
          repeat('0', 64))
  returning * into v_doc;
  update public.signature_documents d set content_sha256 = app.signature_fingerprint(v_doc), people = app.signature_people(v_doc)
   where d.organization_id = p_org and d.id = v_doc.id
  returning * into v_doc;

  v_token := app.signature_link_issue(v_doc);
  perform app.signature_timeline(v_doc, 'signature_sent', 'נשלח מסמך לחתימה: ' || v_doc.title, auth.uid());
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'signature_document', 'signature_documents', v_doc.id,
          jsonb_build_object('status', 'sent', 'record_type', p_record_type, 'template_id', v_template.id));
  return jsonb_build_object('id', v_doc.id, 'token', v_token);
end;
$$;
revoke all on function public.signature_document_send(uuid, uuid, text, uuid, text, text, integer) from public, anon;
grant execute on function public.signature_document_send(uuid, uuid, text, uuid, text, text, integer) to authenticated;

-- A new link for a document that waits for its signature (the old link stops working)
create or replace function public.signature_document_link(p_org uuid, p_doc uuid) returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_doc public.signature_documents := app.signature_managed_document(p_org, p_doc);
  v_token text;
begin
  if v_doc.status not in ('sent', 'viewed') or v_doc.erased_at is not null then
    raise exception 'only a document waiting for its signature gets a new link' using errcode = 'P0001', hint = 'signature_document:closed';
  end if;
  v_token := app.signature_link_issue(v_doc);
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'signature_document', 'signature_documents', v_doc.id, jsonb_build_object('link', 'created'));
  return v_token;
end;
$$;
revoke all on function public.signature_document_link(uuid, uuid) from public, anon;
grant execute on function public.signature_document_link(uuid, uuid) to authenticated;

-- Cancelling: the link then shows "cancelled" only
create or replace function public.signature_document_cancel(p_org uuid, p_doc uuid) returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_doc public.signature_documents := app.signature_managed_document(p_org, p_doc);
begin
  -- one at a time against a signature in flight
  select * into v_doc from public.signature_documents d where d.organization_id = p_org and d.id = p_doc for update;
  if v_doc.status not in ('sent', 'viewed') or v_doc.erased_at is not null then
    raise exception 'only a document waiting for its signature is cancelled' using errcode = 'P0001', hint = 'signature_document:closed';
  end if;
  update public.signature_documents d
     set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
   where d.organization_id = p_org and d.id = p_doc
  returning * into v_doc;
  perform app.signature_timeline(v_doc, 'signature_cancelled', 'בוטל מסמך לחתימה: ' || v_doc.title, auth.uid());
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'signature_document', 'signature_documents', v_doc.id, jsonb_build_object('status', 'cancelled'));
  return true;
end;
$$;
revoke all on function public.signature_document_cancel(uuid, uuid) from public, anon;
grant execute on function public.signature_document_cancel(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The customer's page
-- ----------------------------------------------------------------------------
create or replace function public.signature_public(p_token text, p_ip_hash text default null) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_doc public.signature_documents := app.signature_token_document(p_token);
  v_count integer;
  v_bucket integer;
  v_views integer;
  v_org public.organizations;
  v_settings public.org_document_settings;
  v_phone text;
  v_built_with boolean;
  v_expired boolean;
begin
  -- 120 views per link in 10 minutes, counted first
  update app.signature_links l
     set window_started_at = case when l.window_started_at > now() - interval '10 minutes' then l.window_started_at else now() end,
         window_count = case when l.window_started_at > now() - interval '10 minutes' then l.window_count + 1 else 1 end
   where l.document_id = v_doc.id
  returning l.window_count into v_count;
  if v_count > 120 then
    return jsonb_build_object('rate_limited', true);
  end if;
  -- FXS-11: 60 views per sender in 10 minutes (keyed IP hash, scope "signature", scoped to this document)
  if p_ip_hash is not null then
    v_bucket := ((hashtextextended(app.signature_link_sender(v_doc.id, p_ip_hash), 0) % 1024) + 1024) % 1024;
    insert into app.signature_link_view_counts as vc (document_id, bucket, window_start, views)
    values (v_doc.id, v_bucket, now(), 1)
    on conflict (document_id, bucket) do update
      set window_start = case when vc.window_start > now() - interval '10 minutes' then vc.window_start else now() end,
          views = case when vc.window_start > now() - interval '10 minutes' then vc.views + 1 else 1 end
    returning vc.views into v_views;
    if v_views > 60 then
      return jsonb_build_object('rate_limited', true);
    end if;
  end if;

  select * into v_org from public.organizations o where o.id = v_doc.organization_id;
  select * into v_settings from public.org_document_settings s where s.organization_id = v_doc.organization_id;
  v_phone := coalesce(nullif(btrim(v_settings.phone), ''), nullif(btrim(v_org.phone), ''));
  v_expired := v_doc.status in ('sent', 'viewed') and v_doc.expires_at is not null and v_doc.expires_at <= now();

  if v_doc.status = 'cancelled' or v_expired then
    return jsonb_build_object('status_page', jsonb_build_object(
      'state', case when v_doc.status = 'cancelled' then 'cancelled' else 'expired' end,
      'title', v_doc.title,
      'business', v_org.name,
      'logo', v_org.logo_path,
      'color', v_org.brand_color,
      'phone', v_phone));
  end if;

  -- the first view of a document that waits for its signature
  if v_doc.status = 'sent' then
    update public.signature_documents d set status = 'viewed', viewed_at = now()
     where d.organization_id = v_doc.organization_id and d.id = v_doc.id and d.status = 'sent'
    returning * into v_doc;
  end if;

  begin
    v_built_with := coalesce(app.show_built_with(v_doc.organization_id), true);
  exception when others then
    v_built_with := true;
  end;

  return jsonb_build_object(
    'document', jsonb_build_object(
      'title', v_doc.title,
      'body', v_doc.body,
      'status', v_doc.status,
      'sent_at', v_doc.sent_at,
      'signed_at', v_doc.signed_at,
      'expires_at', v_doc.expires_at),
    'business', jsonb_build_object('name', v_org.name, 'phone', v_phone),
    'brand', jsonb_build_object('logo', v_org.logo_path, 'color', v_org.brand_color),
    -- review 6: the page writes its dates in the business's zone
    'time_zone', app.intake_zone(v_org.timezone),
    'built_with', v_built_with,
    -- what a signature must name, while the document waits for one
    'fingerprint', case when v_doc.status in ('sent', 'viewed') then v_doc.content_sha256 end);
end;
$$;
revoke all on function public.signature_public(text, text) from public, anon, authenticated;
grant execute on function public.signature_public(text, text) to service_role;

create or replace function public.signature_public_sign(
  p_token text, p_fingerprint text, p_signer_name text, p_id_number text default null,
  p_signature_kind text default null, p_signature_image text default null, p_wording_version text default null,
  p_agreed boolean default false, p_ip text default null, p_user_agent text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_doc public.signature_documents := app.signature_token_document(p_token);
  v_views integer;
  v_tries integer;
  v_name text := nullif(btrim(coalesce(p_signer_name, '')), '');
  v_id text := nullif(regexp_replace(coalesce(p_id_number, ''), '[^0-9]', '', 'g'), '');
  v_record jsonb;
begin
  -- counted first, in the link's view window and in its own (10 tries in 10 minutes)
  update app.signature_links l
     set window_started_at = case when l.window_started_at > now() - interval '10 minutes' then l.window_started_at else now() end,
         window_count = case when l.window_started_at > now() - interval '10 minutes' then l.window_count + 1 else 1 end,
         sign_window_started_at = case when l.sign_window_started_at > now() - interval '10 minutes' then l.sign_window_started_at else now() end,
         sign_count = case when l.sign_window_started_at > now() - interval '10 minutes' then l.sign_count + 1 else 1 end
   where l.document_id = v_doc.id
  returning l.window_count, l.sign_count into v_views, v_tries;
  if v_views > 120 or v_tries > 10 then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  -- locked against a second signature and a cancel in parallel
  select * into v_doc from public.signature_documents d where d.organization_id = v_doc.organization_id and d.id = v_doc.id for update;
  if v_doc.status = 'signed' then
    return jsonb_build_object('status', 'already_signed');
  end if;
  if v_doc.status not in ('sent', 'viewed') or (v_doc.expires_at is not null and v_doc.expires_at <= now()) then
    return jsonb_build_object('status', 'closed');
  end if;
  if p_fingerprint is distinct from v_doc.content_sha256 or v_doc.content_sha256 is distinct from app.signature_fingerprint(v_doc) then
    return jsonb_build_object('status', 'changed');
  end if;
  if not coalesce(p_agreed, false) or v_name is null or char_length(v_name) not between 2 and 120
     or not exists (select 1 from app.signature_wording_versions w where w.version = p_wording_version)
     or p_signature_kind is null or p_signature_kind not in ('drawn', 'typed')
     or (p_signature_kind = 'drawn' and (p_signature_image is null or char_length(p_signature_image) > 300000
                                         or p_signature_image !~ '^data:image/png;base64,[A-Za-z0-9+/]+=*$'))
     or (v_id is not null and not app.valid_israeli_id(v_id)) then
    return jsonb_build_object('status', 'invalid');
  end if;

  insert into public.signature_signatures (organization_id, document_id, signer_name, signer_id_number, signature_kind,
                                           signature_image, wording_version, content_sha256, ip, user_agent)
  values (v_doc.organization_id, v_doc.id, v_name, v_id, p_signature_kind,
          case when p_signature_kind = 'drawn' then p_signature_image end, p_wording_version, v_doc.content_sha256,
          left(nullif(btrim(coalesce(p_ip, '')), ''), 64), left(nullif(btrim(coalesce(p_user_agent, '')), ''), 500));
  update app.signature_links l set signed_token_hash = l.token_hash where l.document_id = v_doc.id;
  update public.signature_documents d
     set status = 'signed', signed_at = now(),
         people = (select coalesce(array_agg(distinct x), '{}') from unnest(d.people || app.signature_people(d)) x)
   where d.organization_id = v_doc.organization_id and d.id = v_doc.id
  returning * into v_doc;
  perform app.signature_timeline(v_doc, 'signature_signed', 'הלקוח חתם על המסמך: ' || v_doc.title, null);

  -- the sender and the record's owner (active, not viewers); else the active owners and admins. The title only.
  v_record := app.signature_record_row(v_doc.organization_id, app.signature_record_type(v_doc), app.signature_record_id(v_doc));
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select v_doc.organization_id, r.user_id, 'system', 'מסמך נחתם בקישור', v_doc.title,
         app.signature_record_type(v_doc), app.signature_record_id(v_doc)
    from (select m.user_id from public.memberships m
           where m.organization_id = v_doc.organization_id and m.status = 'active' and m.role <> 'viewer'
             and m.user_id in (v_doc.sent_by, (v_record ->> 'owner_id')::uuid)
          union
          select m.user_id from public.memberships m
           where m.organization_id = v_doc.organization_id and m.status = 'active' and m.role in ('owner', 'admin')
             and not exists (select 1 from public.memberships o
                              where o.organization_id = v_doc.organization_id and o.status = 'active' and o.role <> 'viewer'
                                and o.user_id in (v_doc.sent_by, (v_record ->> 'owner_id')::uuid))) r;
  return jsonb_build_object('status', 'signed');
end;
$$;
revoke all on function public.signature_public_sign(text, text, text, text, text, text, text, boolean, text, text) from public, anon, authenticated;
grant execute on function public.signature_public_sign(text, text, text, text, text, text, text, boolean, text, text) to service_role;

-- ----------------------------------------------------------------------------
-- The signed PDF
-- ----------------------------------------------------------------------------
-- a confirmed signed PDF of the document exists
create or replace function app.signature_pdf_done(p_doc public.signature_documents) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.files f
                  where f.organization_id = p_doc.organization_id and f.signature_document_id = p_doc.id)
$$;
revoke all on function app.signature_pdf_done(public.signature_documents) from public, anon, authenticated, service_role;

-- What a signed PDF is rendered from: the document, the business, the signature; null while there is nothing to render
-- (223) ב: the customer downloads the signed PDF from the signing page, after signing only
create or replace function public.signature_public_pdf(p_token text, p_ip_hash text default null) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_doc public.signature_documents := app.signature_token_document(p_token);
  v_link app.signature_links;
  v_count integer;
  v_bucket integer;
  v_file public.files;
begin
  select * into v_link from app.signature_links l where l.document_id = v_doc.id;
  -- only a signed document, and only through the link it was signed with
  if v_doc.status <> 'signed' or v_link.signed_token_hash is null or v_link.token_hash is distinct from v_link.signed_token_hash then
    raise exception 'document not found' using errcode = 'P0002';
  end if;
  -- the link's own window, shared with the page (120 in 10 minutes), counted after the lookup
  update app.signature_links l
     set window_started_at = case when l.window_started_at > now() - interval '10 minutes' then l.window_started_at else now() end,
         window_count = case when l.window_started_at > now() - interval '10 minutes' then l.window_count + 1 else 1 end
   where l.document_id = v_doc.id
  returning l.window_count into v_count;
  if v_count > 120 then
    return jsonb_build_object('rate_limited', true);
  end if;
  -- 20 downloads per sender in 10 minutes (keyed IP hash, scope signature, scoped to this document); no hash = not counted
  if p_ip_hash is not null then
    v_bucket := ((hashtextextended(app.signature_link_sender(v_doc.id, p_ip_hash), 0) % 1024) + 1024) % 1024;
    insert into app.signature_pdf_download_counts as dc (document_id, bucket, window_start, downloads)
    values (v_doc.id, v_bucket, now(), 1)
    on conflict (document_id, bucket) do update
      set window_start = case when dc.window_start > now() - interval '10 minutes' then dc.window_start else now() end,
          downloads = case when dc.window_start > now() - interval '10 minutes' then dc.downloads + 1 else 1 end
    returning dc.downloads into v_count;
    if v_count > 20 then
      return jsonb_build_object('rate_limited', true);
    end if;
  end if;
  select * into v_file from public.files f
   where f.organization_id = v_doc.organization_id and f.signature_document_id = v_doc.id
     and f.unconfirmed_since is null and f.sha256 is not null;
  if not found then
    return jsonb_build_object('unavailable', true);
  end if;
  return jsonb_build_object('path', v_file.storage_path, 'sha256', v_file.sha256, 'name', v_file.name);
end;
$$;
revoke all on function public.signature_public_pdf(text, text) from public, anon, authenticated;
grant execute on function public.signature_public_pdf(text, text) to service_role;

-- review 3: a path is handed to the orphan cleanup only when it is an open upload attempt of THIS document of this business
-- (never a path a caller names that belongs to something else)
create or replace function app.signature_pdf_abandon(p_org uuid, p_doc uuid, p_path text) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if p_path is null then
    return;
  end if;
  if exists (select 1 from app.signature_pdf_attempts a
              where a.storage_path = p_path and a.document_id = p_doc and a.organization_id = p_org and a.done_at is null) then
    perform app.quote_pdf_abandon(p_org, p_path);
    update app.signature_pdf_attempts a set done_at = now() where a.storage_path = p_path;
  end if;
end;
$$;
revoke all on function app.signature_pdf_abandon(uuid, uuid, text) from public, anon, authenticated, service_role;

-- review 1: the leads and contacts a document is about (see the header), read as the server
create or replace function app.signature_people(p_doc public.signature_documents) returns uuid[]
language sql stable security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct s.x) filter (where s.x is not null), '{}')
    from (select p_doc.lead_id as x
          union all select p_doc.contact_id
          union all select d.contact_id from public.deals d
                     where p_doc.deal_id is not null and d.organization_id = p_doc.organization_id and d.id = p_doc.deal_id
          union all select dc.contact_id from public.deal_contacts dc
                     where p_doc.deal_id is not null and dc.organization_id = p_doc.organization_id and dc.deal_id = p_doc.deal_id
          union all select l.id from public.leads l
                     where p_doc.deal_id is not null and l.organization_id = p_doc.organization_id and l.converted_deal_id = p_doc.deal_id
          union all select l.id from public.leads l
                     where p_doc.contact_id is not null and l.organization_id = p_doc.organization_id
                       and l.converted_contact_id = p_doc.contact_id
          union all (select c.id from public.contacts c
                      where p_doc.company_id is not null and c.organization_id = p_doc.organization_id and c.company_id = p_doc.company_id
                      order by c.id limit 500)
          union all (select cc.contact_id from public.contact_companies cc
                      where p_doc.company_id is not null and cc.organization_id = p_doc.organization_id and cc.company_id = p_doc.company_id
                      order by cc.contact_id limit 500)) s
$$;
revoke all on function app.signature_people(public.signature_documents) from public, anon, authenticated, service_role;

create or replace function app.signature_pdf_source(p_doc public.signature_documents) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_sig public.signature_signatures;
  v_org public.organizations;
  v_settings public.org_document_settings;
begin
  if p_doc.status <> 'signed' or p_doc.erased_at is not null then
    return null;
  end if;
  select * into v_sig from public.signature_signatures s
   where s.organization_id = p_doc.organization_id and s.document_id = p_doc.id and s.erased_at is null;
  if not found then
    return null;
  end if;
  select * into v_org from public.organizations o where o.id = p_doc.organization_id;
  select * into v_settings from public.org_document_settings s where s.organization_id = p_doc.organization_id;
  return jsonb_build_object(
    'document', jsonb_build_object('title', p_doc.title, 'body', p_doc.body, 'sent_at', p_doc.sent_at),
    'business', jsonb_build_object(
      'name', coalesce(nullif(btrim(v_settings.legal_name), ''), v_org.name),
      'tax_id', v_settings.tax_id,
      'phone', coalesce(nullif(btrim(v_settings.phone), ''), nullif(btrim(v_org.phone), '')),
      'email', v_settings.email),
    'brand', jsonb_build_object('logo', v_org.logo_path, 'color', v_org.brand_color),
    'signature', jsonb_build_object(
      'signer_name', v_sig.signer_name,
      'id_number', v_sig.signer_id_number,
      'kind', v_sig.signature_kind,
      'image', case when v_sig.signature_kind = 'drawn' then v_sig.signature_image end,
      'signed_at', v_sig.signed_at,
      'time_zone', app.intake_zone(v_org.timezone),
      'wording_version', v_sig.wording_version,
      -- review 5: the registered text of that version (null for a version not registered)
      'wording', (select w.wording from app.signature_wording_versions w where w.version = v_sig.wording_version),
      'fingerprint', v_sig.content_sha256));
end;
$$;
revoke all on function app.signature_pdf_source(public.signature_documents) from public, anon, authenticated, service_role;

-- The one writer. Without p_path: {status: upload, path} (a fresh path for this attempt) or {status: stored, file_id}.
-- With the path it handed out: the object must be there, a PDF of the stated size; then the confirmed row is made on that
-- path: {status: stored, file_id}; {status: upload, path} again while the object is missing; {status: changed} when the
-- render printed another fingerprint (nothing written).
create or replace function app.signature_pdf_write(p_doc_id uuid, p_org uuid, p_path text, p_size bigint, p_sha256 text,
                                                   p_fingerprint text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_doc public.signature_documents;
  v_file public.files;
  v_attempt app.signature_pdf_attempts;
  v_obj record;
  v_id uuid;
  v_path text;
  v_day text;
begin
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' or p_size is null or p_size < 1 or p_size > 26214400 then
    raise exception 'invalid PDF details' using errcode = '22023', hint = 'signature_pdf:invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('signature_pdf:' || p_doc_id::text, 0));
  select * into v_doc from public.signature_documents d where d.organization_id = p_org and d.id = p_doc_id;
  if not found or v_doc.status <> 'signed' or app.signature_pdf_source(v_doc) is null then
    raise exception 'a signed PDF is made for a signed document' using errcode = 'P0001', hint = 'signature_pdf:not_signed';
  end if;
  if p_fingerprint is distinct from v_doc.content_sha256 then
    perform app.signature_pdf_abandon(p_org, p_doc_id, p_path);
    return jsonb_build_object('status', 'changed');
  end if;

  select * into v_file from public.files f where f.organization_id = p_org and f.signature_document_id = p_doc_id;
  if found then
    -- kept once: another attempt's path is not the file
    if p_path is distinct from v_file.storage_path then
      perform app.signature_pdf_abandon(p_org, p_doc_id, p_path);
    end if;
    return jsonb_build_object('status', 'stored', 'file_id', v_file.id);
  end if;

  if p_path is null then
    -- earlier attempts that never finished are left to the orphan cleanup
    for v_attempt in
      select * from app.signature_pdf_attempts a
       where a.document_id = p_doc_id and a.done_at is null and a.created_at < now() - interval '10 minutes'
    loop
      perform app.quote_pdf_abandon(p_org, v_attempt.storage_path);
      update app.signature_pdf_attempts a set done_at = now() where a.storage_path = v_attempt.storage_path;
    end loop;
    v_path := p_org::text || '/' || gen_random_uuid()::text;
    insert into app.signature_pdf_attempts (storage_path, organization_id, document_id) values (v_path, p_org, p_doc_id);
    return jsonb_build_object('status', 'upload', 'path', v_path);
  end if;

  select * into v_attempt from app.signature_pdf_attempts a
   where a.storage_path = p_path and a.document_id = p_doc_id and a.organization_id = p_org and a.done_at is null;
  if not found then
    raise exception 'not a path of this document' using errcode = '22023', hint = 'signature_pdf:invalid';
  end if;
  select * into v_obj from app.record_file_object(p_path);
  if not coalesce(v_obj.present, false) then
    return jsonb_build_object('status', 'upload', 'path', p_path);
  end if;
  if v_obj.size is distinct from p_size or v_obj.mimetype is distinct from 'application/pdf' then
    perform app.quote_pdf_abandon(p_org, p_path);
    update app.signature_pdf_attempts a set done_at = now() where a.storage_path = p_path;
    raise exception 'the uploaded object is not the stated PDF' using errcode = '22023', hint = 'signature_pdf:invalid';
  end if;

  -- the row's path is <org>/<id> (files_before_insert), so the id is the attempt's
  v_id := substr(p_path, length(p_org::text) + 2)::uuid;
  v_day := to_char(v_doc.signed_at at time zone app.intake_zone((select o.timezone from public.organizations o where o.id = p_org)), 'YYYY-MM-DD');
  insert into public.files (id, organization_id, signature_document_id, name, mime_type, size_bytes, sha256)
  values (v_id, p_org, p_doc_id, 'מסמך חתום ' || v_day || '.pdf', 'application/pdf', p_size, p_sha256)
  returning * into v_file;
  update public.files f set upload_checked_at = now() where f.organization_id = p_org and f.id = v_file.id;
  update app.signature_pdf_attempts a set done_at = now() where a.storage_path = p_path;
  -- any other unfinished attempt of the document is not needed any more
  for v_attempt in
    select * from app.signature_pdf_attempts a where a.document_id = p_doc_id and a.done_at is null
  loop
    perform app.quote_pdf_abandon(p_org, v_attempt.storage_path);
    update app.signature_pdf_attempts a set done_at = now() where a.storage_path = v_attempt.storage_path;
  end loop;
  return jsonb_build_object('status', 'stored', 'file_id', v_file.id);
end;
$$;
revoke all on function app.signature_pdf_write(uuid, uuid, text, bigint, text, text) from public, anon, authenticated, service_role;

-- (1) The customer's route, right after signing: what to render ({done} once kept, {unavailable} while not signed)
create or replace function public.signature_pdf_public(p_token text) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_doc public.signature_documents := app.signature_token_document(p_token);
  v_source jsonb;
begin
  if app.signature_pdf_done(v_doc) then
    return jsonb_build_object('done', true);
  end if;
  v_source := app.signature_pdf_source(v_doc);
  if v_source is null then
    return jsonb_build_object('unavailable', true);
  end if;
  return v_source;
end;
$$;
revoke all on function public.signature_pdf_public(text) from public, anon, authenticated;
grant execute on function public.signature_pdf_public(text) to service_role;

create or replace function public.signature_pdf_public_store(p_token text, p_size bigint, p_sha256 text,
                                                             p_path text default null, p_fingerprint text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_doc public.signature_documents := app.signature_token_document(p_token);
begin
  return app.signature_pdf_write(v_doc.id, v_doc.organization_id, p_path, p_size, p_sha256, p_fingerprint);
end;
$$;
revoke all on function public.signature_pdf_public_store(text, bigint, text, text, text) from public, anon, authenticated;
grant execute on function public.signature_pdf_public_store(text, bigint, text, text, text) to service_role;

-- (2) Staff, owners and admins, when (1) failed: asked with the person's own session; the source to render, or null
create or replace function public.signature_pdf_allowed(p_org uuid, p_doc uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_doc public.signature_documents;
begin
  if p_org is null or not app.is_admin(p_org) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  select * into v_doc from public.signature_documents d where d.organization_id = p_org and d.id = p_doc;
  if not found or not app.can_write(p_org) or not app.org_writable(p_org) or not app.org_has_feature(p_org, 'signatures')
     or app.signature_pdf_done(v_doc) then
    return null;
  end if;
  return app.signature_pdf_source(v_doc);
end;
$$;
revoke all on function public.signature_pdf_allowed(uuid, uuid) from public, anon;
grant execute on function public.signature_pdf_allowed(uuid, uuid) to authenticated;

create or replace function public.signature_pdf_store(p_org uuid, p_doc uuid, p_user uuid, p_size bigint, p_sha256 text,
                                                      p_path text default null, p_fingerprint text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  -- written for an active owner or admin of a writable business with the key only
  if not exists (select 1 from public.memberships m
                  where m.organization_id = p_org and m.user_id = p_user and m.status = 'active' and m.role in ('owner', 'admin'))
     or not exists (select 1 from public.signature_documents d where d.organization_id = p_org and d.id = p_doc)
     or not app.org_writable(p_org) or not app.org_has_feature(p_org, 'signatures') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return app.signature_pdf_write(p_doc, p_org, p_path, p_size, p_sha256, p_fingerprint);
end;
$$;
revoke all on function public.signature_pdf_store(uuid, uuid, uuid, bigint, text, text, text) from public, anon, authenticated;
grant execute on function public.signature_pdf_store(uuid, uuid, uuid, bigint, text, text, text) to service_role;

-- ----------------------------------------------------------------------------
-- The timeline entries are the server's: a person never writes, changes or removes them
-- ----------------------------------------------------------------------------
create or replace function app.activities_signature_entry_guard() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  if tg_op in ('UPDATE', 'DELETE') and coalesce(old.metadata ->> 'kind', '') in ('signature_sent', 'signature_signed', 'signature_cancelled') then
    raise exception 'a document for signature on the timeline is history' using errcode = '42501', hint = 'activity:signature_entry';
  end if;
  if tg_op in ('INSERT', 'UPDATE') and coalesce(new.metadata ->> 'kind', '') in ('signature_sent', 'signature_signed', 'signature_cancelled') then
    raise exception 'only the server writes a document for signature entry' using errcode = '42501', hint = 'activity:signature_entry';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
revoke all on function app.activities_signature_entry_guard() from public, anon, authenticated, service_role;

create or replace trigger activities_signature_entry_guard before insert or update or delete on public.activities
  for each row execute function app.activities_signature_entry_guard();

-- ----------------------------------------------------------------------------
-- Merge: a duplicate's documents move to the kept record (before the duplicate is deleted)
-- ----------------------------------------------------------------------------
create or replace function app.merge_signature_documents() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_merged uuid;
begin
  if (new.metadata ->> 'merged_id') !~ '^[0-9a-fA-F-]{36}$' then
    return null;
  end if;
  v_merged := (new.metadata ->> 'merged_id')::uuid;
  -- review 1: a document that named the duplicate names the kept record too, so the kept record's erasure reaches it
  if coalesce(new.lead_id, new.contact_id) is not null and v_merged <> coalesce(new.lead_id, new.contact_id) then
    update public.signature_documents d set people = array_append(d.people, coalesce(new.lead_id, new.contact_id))
     where d.organization_id = new.organization_id and v_merged = any (d.people)
       and not (coalesce(new.lead_id, new.contact_id) = any (d.people)) and cardinality(d.people) < 2000;
  end if;
  if new.lead_id is not null and v_merged <> new.lead_id then
    update public.signature_documents d set lead_id = new.lead_id
     where d.organization_id = new.organization_id and d.lead_id = v_merged;
  elsif new.contact_id is not null and v_merged <> new.contact_id then
    update public.signature_documents d set contact_id = new.contact_id
     where d.organization_id = new.organization_id and d.contact_id = v_merged;
  elsif new.company_id is not null and v_merged <> new.company_id then
    update public.signature_documents d set company_id = new.company_id
     where d.organization_id = new.organization_id and d.company_id = v_merged;
  end if;
  return null;
end;
$$;
revoke all on function app.merge_signature_documents() from public, anon, authenticated, service_role;

create or replace trigger activities_merge_signature_documents after insert on public.activities
  for each row
  when (new.type = 'system' and (new.lead_id is not null or new.contact_id is not null or new.company_id is not null)
        and new.metadata ? 'merged_id')
  execute function app.merge_signature_documents();


-- ----------------------------------------------------------------------------
-- Erasure (review 1)
-- ----------------------------------------------------------------------------
-- the signed PDFs of erased documents: the body, a row removal, is in the pasted 20261006021213_signature_pdf_erase. Here a
-- placeholder made only while the function is missing, so running this file again never undoes the pasted body.
do $do$
begin
  if to_regprocedure('app.signature_pdf_drop(uuid, uuid[])') is null then
    execute $f$
      create function app.signature_pdf_drop(p_org uuid, p_docs uuid[]) returns void
      language plpgsql security definer
      set search_path = ''
      as $b$
      begin
        -- until 20261006021213 is pasted: the signed PDF stays (read by owners and admins only)
        return;
      end;
      $b$
    $f$;
  end if;
end;
$do$;
revoke all on function app.signature_pdf_drop(uuid, uuid[]) from public, anon, authenticated, service_role;

create or replace function app.signature_documents_erase(p_org uuid, p_type text, p_id uuid, p_deals uuid[]) returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_docs uuid[];
  v_titles text[];
  v_records uuid[];
  v_entries uuid[];
  v_count integer := 0;
  v_more integer;
begin
  if p_org is null or p_id is null or p_type not in ('leads', 'contacts', 'deals', 'companies') then
    return 0;
  end if;
  select coalesce(array_agg(d.id), '{}'), coalesce(array_agg(distinct d.title), '{}'),
         coalesce(array_agg(distinct coalesce(d.lead_id, d.contact_id, d.company_id, d.deal_id, d.former_lead_id,
                                              d.former_contact_id, d.former_company_id, d.former_deal_id)), '{}')
    into v_docs, v_titles, v_records
    from public.signature_documents d
   where d.organization_id = p_org
     and case p_type
           when 'leads' then p_id = any (d.people) or d.former_lead_id = p_id
           when 'contacts' then p_id = any (d.people) or d.former_contact_id = p_id
                                or d.deal_id = any (coalesce(p_deals, '{}'::uuid[]))
                                or d.former_deal_id = any (coalesce(p_deals, '{}'::uuid[]))
           -- review 2 (10 November 2026): an erased deal or company empties its own detached documents, as its quote and
           -- order decisions are emptied
           when 'deals' then d.former_deal_id = p_id
           else d.former_company_id = p_id
         end;
  if cardinality(v_docs) = 0 then
    return 0;
  end if;

  update public.signature_documents d
     set body = 'המסמך נמחק (מחיקת פרטיות)', title = 'מסמך לחתימה (נמחק)', erased_at = coalesce(d.erased_at, now())
   where d.organization_id = p_org and d.id = any (v_docs)
     and (d.erased_at is null or d.body <> 'המסמך נמחק (מחיקת פרטיות)');
  get diagnostics v_more = row_count;
  v_count := v_count + v_more;
  -- the link answers not found from now on
  update app.signature_links l set token_hash = null where l.organization_id = p_org and l.document_id = any (v_docs);

  update public.signature_signatures s
     set signer_name = null, signer_id_number = null, signature_image = null, ip = null, user_agent = null,
         erased_at = coalesce(s.erased_at, now())
   where s.organization_id = p_org and s.document_id = any (v_docs)
     and (s.erased_at is null or s.signer_name is not null or s.signer_id_number is not null or s.signature_image is not null
          or s.ip is not null or s.user_agent is not null);
  get diagnostics v_more = row_count;
  v_count := v_count + v_more;

  -- the timeline entries keep their kind, with a neutral body; their audit entries (which held the title) are erased
  with changed as (
    update public.activities a
       set body = case a.metadata ->> 'kind'
                    when 'signature_sent' then 'נשלח מסמך לחתימה (הפרטים נמחקו)'
                    when 'signature_signed' then 'הלקוח חתם על המסמך (הפרטים נמחקו)'
                    else 'בוטל מסמך לחתימה (הפרטים נמחקו)' end
     where a.organization_id = p_org and a.type = 'system'
       and a.metadata ->> 'kind' in ('signature_sent', 'signature_signed', 'signature_cancelled')
       and a.metadata ->> 'signature_document_id' = any (v_docs::text[])
    returning a.id)
  select coalesce(array_agg(c.id), '{}') into v_entries from changed c;
  v_count := v_count + cardinality(v_entries);
  update public.audit_log al set changes = '{"erased": true}'::jsonb
   where al.organization_id = p_org and al.entity_type = 'activities' and al.entity_id = any (v_entries)
     and al.changes is distinct from '{"erased": true}'::jsonb;

  -- the "signed" notices carried the title only
  update public.notifications n set body = 'מסמך לחתימה (הפרטים נמחקו)'
   where n.organization_id = p_org and n.type = 'system' and n.title = 'מסמך נחתם בקישור'
     and n.entity_id = any (v_records) and n.body = any (v_titles);
  get diagnostics v_more = row_count;
  v_count := v_count + v_more;

  -- an upload in flight finds no source any more (signature_pdf_source answers null for an erased document)
  perform app.signature_pdf_drop(p_org, v_docs);
  return v_count;
end;
$$;
revoke all on function app.signature_documents_erase(uuid, text, uuid, uuid[]) from public, anon, authenticated, service_role;

-- review 3 (10 November 2026): `people` is not selectable by clients; the person export (PRV-02, owners and admins only) asks
-- here for the ids of the documents that name the person's leads and contacts, then reads them under RLS
create or replace function public.signature_documents_naming(p_org uuid, p_ids uuid[]) returns uuid[]
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if p_org is null or not app.is_admin(p_org) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_ids), 0) = 0 then
    return '{}';
  end if;
  if cardinality(p_ids) > 2000 then
    raise exception 'too many ids' using errcode = '22023';
  end if;
  return (select coalesce(array_agg(d.id order by d.id), '{}')
            from public.signature_documents d
           where d.organization_id = p_org and d.people && p_ids);
end;
$$;
revoke all on function public.signature_documents_naming(uuid, uuid[]) from public, anon;
grant execute on function public.signature_documents_naming(uuid, uuid[]) to authenticated;

-- 021166's body with the one call above added
CREATE OR REPLACE FUNCTION app.audit_erase_core(p_org uuid, p_type text, p_id uuid, p_actor uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
     where a.organization_id = p_org and a.entity_type in ('tasks', 'files', 'activities', 'deal_lines', 'quotes', 'orders', 'accounting_documents', 'payments', 'customer_holds', 'punch_cards') and a.entity_id is not null
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
    -- QUO-08 (owner, 1 November 2026): the customer's questions on those quotes keep only that a question was asked; the
    -- entries' audit history (the text included) is erased below with the rest
    for v_child in
      update public.activities ac
         set body = 'שאלה מהלקוח על הצעת מחיר' || coalesce(' ' || (ac.metadata ->> 'number'), '') || ' (הטקסט נמחק)'
       where ac.organization_id = p_org and ac.type = 'system' and ac.metadata ->> 'kind' = 'quote_question'
         and ac.metadata ->> 'quote_id' = any (select substr(c, length('quotes:') + 1) from unnest(v_children) c where c like 'quotes:%')
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
                       -- QUO-08: a question's text leaves the body like a decline reason
                       else nullif(regexp_replace(n.body, '( · )?(סיבה|שאלה): .*$', ''), '') end
     where n.organization_id = p_org and n.entity_type = 'quote'
       and n.entity_id = any (select substr(c, length('quotes:') + 1)::uuid from unnest(v_children) c where c like 'quotes:%')
       and (n.type = 'quote_viewed' or (n.type = 'quote' and (n.title like '%: %' or n.body like '%סיבה: %' or n.body like '%שאלה: %')));
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
    -- ORD-05 PDF: the stored PDF of those orders holds the customer's name, details, notes and line texts, so it goes (as a
    -- quote's, QUO-06 answer (2) א); its object follows through the orphan cleanup (app.orphan_files)
    perform app.order_pdf_drop(p_org, array(select substr(c, length('orders:') + 1)::uuid from unnest(v_children) c where c like 'orders:%'));
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

  -- PKG-01 (owner (87) ב): a card transferred or merged away from the person keeps its numbers; its free text and the
  -- entries that name the person go (app.punch_cards_erase; PKG-02 adds the entries of the cards' used entries)
  if p_type = 'contacts' then
    v_children := v_children || app.punch_cards_erase(p_org, p_id, v_children);
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

  -- SGN-02: documents for signature that named the person (a lead's or a contact's erasure: also a deal's or a company's
  -- documents), and a deal's or a company's own detached documents (review 2)
  v_count := v_count + app.signature_documents_erase(p_org, p_type, p_id, v_deals);

  v_count := v_count + v_notes;
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, p_actor, 'erase', p_type, p_id, jsonb_build_object('entries', v_count));
  return v_count;
end;
$function$;
revoke all on function app.audit_erase_core(uuid, text, uuid, uuid) from public, anon, authenticated;

-- 021081's body with the signed-document line added (review 2)
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
                        and (sd.lead_id = l.id or l.id = any (sd.people)));
$function$;
revoke all on function app.lead_retention_candidates(uuid, timestamptz, uuid) from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';
