-- =============================================================================
-- A file on a recorded payment (PAY-01 follow-up), and erasure of the entries of document and payment files
-- =============================================================================
-- * files.payment_id: a file may belong to one recorded payment (a receipt, a bank confirmation, a cheque's photo), the
--   same way 020640 lets it belong to an accounting document: files_one_subject counts it, never on a timeline entry,
--   composite foreign key on delete cascade (a payment is never deleted; only its business's deletion takes the files).
-- * Who: reading follows the payment (payments_select: its deal, else its contact, else owners, admins and managers);
--   adding needs the payment rules (app.can_record_payments in a writable business with the `payments` flag) besides
--   app.can_write. A cancelled or refunded payment takes files too (the paper that was received still exists; the
--   payment's facts stay frozen).
-- * Never removed (owner, 20 October 2026, the rule of 020640): nobody deletes a payment's file; a new version replaces it
--   and the earlier ones stay. The delete policy, the Storage delete policy and trigger files_keep_attached hold it, with
--   the same two exceptions (the business's own deletion; the uploader's upload that never arrived).
-- * PDF and images only (app.document_file_types), as declared and as stored; one current file per payment, linked by the
--   server to the payment's latest file under a lock (as for documents).
-- * Privacy erasure (app.audit_erase_core, the body of 020635): the entries of the files of every document and payment the
--   erasure reaches are erased too (a file's name may carry the customer's name). The files themselves stay with the
--   document or payment, as those do.
-- * Storage reads public.files with the caller's rights as before; its delete policy also keeps a payment's file.
-- Every statement is safe to run twice. No drops, no row removal.

alter table public.files add column if not exists payment_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'files_payment_fk') then
    alter table public.files add constraint files_payment_fk
      foreign key (organization_id, payment_id) references public.payments (organization_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'files_payment_no_note') then
    alter table public.files add constraint files_payment_no_note check (payment_id is null or activity_id is null);
  end if;
end;
$$;

-- one subject each: a record, a document or a payment (every existing row has exactly one of the first five)
alter table public.files drop constraint if exists files_one_subject;
alter table public.files add constraint files_one_subject
  check (num_nonnulls(lead_id, contact_id, company_id, deal_id, accounting_document_id, payment_id) = 1);

create index if not exists files_payment_idx on public.files (organization_id, payment_id);

grant insert (payment_id) on public.files to authenticated;

-- ----------------------------------------------------------------------------
-- Policies: a payment's file follows the payment; documents' and records' files keep the rules of 020640
-- ----------------------------------------------------------------------------
alter policy files_select on public.files
  using (app.is_member(organization_id)
         and case when accounting_document_id is not null
                  then exists (select 1 from public.accounting_documents d
                                where d.organization_id = files.organization_id and d.id = files.accounting_document_id)
                  when payment_id is not null
                  then exists (select 1 from public.payments pm
                                where pm.organization_id = files.organization_id and pm.id = files.payment_id)
                  else app.can_read_activity_subject(lead_id, contact_id, company_id, deal_id)
                       and (activity_id is null
                            or exists (select 1 from public.activities a
                                        where a.organization_id = files.organization_id and a.id = files.activity_id))
             end);
alter policy files_insert on public.files
  with check (app.can_write(organization_id)
              and uploaded_by = (select auth.uid())
              and case when accounting_document_id is not null
                       then app.can_record_documents(organization_id) and app.org_writable(organization_id)
                            and app.org_has_feature(organization_id, 'documents')
                            and exists (select 1 from public.accounting_documents d
                                         where d.organization_id = files.organization_id and d.id = files.accounting_document_id)
                       when payment_id is not null
                       then app.can_record_payments(organization_id) and app.org_writable(organization_id)
                            and app.org_has_feature(organization_id, 'payments')
                            and exists (select 1 from public.payments pm
                                         where pm.organization_id = files.organization_id and pm.id = files.payment_id)
                       else app.can_read_activity_subject(lead_id, contact_id, company_id, deal_id)
                            and (activity_id is null
                                 or exists (select 1 from public.activities a
                                             where a.organization_id = files.organization_id and a.id = files.activity_id))
                  end);
alter policy files_delete on public.files
  using (app.can_write(organization_id)
         and (uploaded_by = (select auth.uid()) or app.is_admin(organization_id))
         and case when accounting_document_id is not null or payment_id is not null
                  -- never removed (owner); only the uploader's own upload that never arrived goes
                  then unconfirmed_since is not null and uploaded_by = (select auth.uid())
                  else app.can_read_activity_subject(lead_id, contact_id, company_id, deal_id)
                       and (activity_id is null
                            or exists (select 1 from public.activities a
                                        where a.organization_id = files.organization_id and a.id = files.activity_id))
             end);

-- Storage keeps the object of a document's or a payment's file: only an upload that never arrived goes
alter policy record_files_delete on storage.objects
  using (bucket_id = 'record-files'
         and exists (select 1 from public.files f
                      where f.storage_path = objects.name and app.can_write(f.organization_id)
                        and (f.uploaded_by = (select auth.uid()) or app.is_admin(f.organization_id))
                        and ((f.accounting_document_id is null and f.payment_id is null)
                             or (f.unconfirmed_since is not null and f.uploaded_by = (select auth.uid())))));

-- For every writer, definer paths included (020640, plus payments)
create or replace function app.files_keep_attached() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if (old.accounting_document_id is not null or old.payment_id is not null)
     and old.unconfirmed_since is null and app.org_exists(old.organization_id) then
    raise exception 'a document''s or a payment''s file is kept; add a new version instead' using errcode = 'P0001', hint = 'file:kept';
  end if;
  return old;
end;
$$;
revoke all on function app.files_keep_attached() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The path, the uploader, the waiting state and the quota (020640), plus a payment's flag and types
-- ----------------------------------------------------------------------------
create or replace function app.files_before_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_gb  numeric := app.org_limit(new.organization_id, 'storage_gb');
  v_uid uuid := auth.uid();
begin
  new.storage_path := new.organization_id::text || '/' || new.id::text;
  new.uploaded_by := v_uid;
  new.upload_checked_at := null;
  -- RVW-23: a caller the write policy refuses gets RLS's plain 42501, never this business's quota or plan
  if auth.uid() is not null
     and not (app.can_write(new.organization_id)
              and (new.accounting_document_id is null
                   or (app.can_record_documents(new.organization_id) and app.org_writable(new.organization_id)))
              and (new.payment_id is null
                   or (app.can_record_payments(new.organization_id) and app.org_writable(new.organization_id)))) then
    return new;
  end if;
  -- a document's or a payment's file: the plan's flag, and PDF or an image only
  if new.accounting_document_id is not null and not app.org_has_feature(new.organization_id, 'documents') then
    raise exception 'accounting documents are not in the plan' using errcode = 'P0001', hint = 'feature:documents';
  end if;
  if new.payment_id is not null and not app.org_has_feature(new.organization_id, 'payments') then
    raise exception 'payments are not in the plan' using errcode = 'P0001', hint = 'feature:payments';
  end if;
  if (new.accounting_document_id is not null or new.payment_id is not null)
     and not (lower(coalesce(new.mime_type, '')) = any (app.document_file_types())) then
    raise exception 'a document''s or a payment''s file is a PDF or an image' using errcode = 'P0001', hint = 'file:document_type';
  end if;
  if v_uid is not null then
    -- FXS-07: a person's row waits until its upload is confirmed
    new.unconfirmed_since := now();
    perform pg_advisory_xact_lock(hashtextextended('files_pending:' || new.organization_id::text || ':' || v_uid::text, 0));
    if (select count(*) from public.files f
         where f.organization_id = new.organization_id and f.uploaded_by = v_uid
           and f.unconfirmed_since > now() - interval '1 hour') >= 20 then
      raise exception 'too many uploads are waiting for confirmation' using errcode = 'P0001', hint = 'file:pending_max';
    end if;
  end if;
  if v_gb is not null then
    perform pg_advisory_xact_lock(hashtextextended('files_quota:' || new.organization_id::text, 0));
    if not app.files_quota_ok(new.organization_id, new.size_bytes) then
      raise exception 'plan storage limit reached (% GB)', v_gb using errcode = 'P0001', hint = 'limit:storage_gb';
    end if;
  end if;
  return new;
end;
$function$;
revoke all on function app.files_before_insert() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Links (020640), plus: a payment's new file follows its latest file
-- ----------------------------------------------------------------------------
create or replace function app.files_links_check() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_note public.activities;
  v_prev public.files;
  v_latest uuid;
  v_person boolean := current_user in ('authenticated', 'anon');
begin
  -- a person who may not write here gets RLS's plain refusal right after
  if v_person and not app.can_write(new.organization_id) then
    return new;
  end if;
  if new.accounting_document_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('files_document:' || new.organization_id::text || ':' || new.accounting_document_id::text, 0));
    -- the latest file: the one no other file of the document replaces (the history is one line)
    select f.id into v_latest
      from public.files f
     where f.organization_id = new.organization_id and f.accounting_document_id = new.accounting_document_id
       and not exists (select 1 from public.files n where n.organization_id = f.organization_id and n.previous_id = f.id)
     order by f.created_at desc, f.id desc
     limit 1;
    if new.previous_id is not null and new.previous_id is distinct from v_latest then
      raise exception 'this document already has a newer file' using errcode = 'P0001', hint = 'file:version_taken';
    end if;
    new.previous_id := v_latest;
  end if;
  -- PAY-01 follow-up: a payment's new file follows its latest file the same way
  if new.payment_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('files_payment:' || new.organization_id::text || ':' || new.payment_id::text, 0));
    select f.id into v_latest
      from public.files f
     where f.organization_id = new.organization_id and f.payment_id = new.payment_id
       and not exists (select 1 from public.files n where n.organization_id = f.organization_id and n.previous_id = f.id)
     order by f.created_at desc, f.id desc
     limit 1;
    if new.previous_id is not null and new.previous_id is distinct from v_latest then
      raise exception 'this payment already has a newer file' using errcode = 'P0001', hint = 'file:version_taken';
    end if;
    new.previous_id := v_latest;
  end if;
  if new.activity_id is not null then
    select * into v_note from public.activities a where a.organization_id = new.organization_id and a.id = new.activity_id;
    if not found
       or v_note.lead_id is distinct from new.lead_id or v_note.contact_id is distinct from new.contact_id
       or v_note.company_id is distinct from new.company_id or v_note.deal_id is distinct from new.deal_id
       or (v_person and (v_note.type not in ('note', 'call', 'meeting', 'email', 'whatsapp', 'sms')
                         or v_note.created_by is distinct from auth.uid())) then
      raise exception 'a file is attached only to an entry of the same record, by its author'
        using errcode = 'P0001', hint = 'file:note';
    end if;
  end if;
  if new.previous_id is not null then
    select * into v_prev from public.files f where f.organization_id = new.organization_id and f.id = new.previous_id;
    if not found
       or v_prev.lead_id is distinct from new.lead_id or v_prev.contact_id is distinct from new.contact_id
       or v_prev.company_id is distinct from new.company_id or v_prev.deal_id is distinct from new.deal_id
       or v_prev.activity_id is distinct from new.activity_id
       or v_prev.accounting_document_id is distinct from new.accounting_document_id
       or v_prev.payment_id is distinct from new.payment_id then
      raise exception 'a new version belongs to the same record and note as the earlier one'
        using errcode = 'P0001', hint = 'file:version';
    end if;
    if exists (select 1 from public.files f where f.previous_id = new.previous_id) then
      raise exception 'this file already has a newer version' using errcode = 'P0001', hint = 'file:version_taken';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.files_links_check() from public, anon;
grant execute on function app.files_links_check() to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The real object (020640): a payment's file must really be a PDF or an image too
-- ----------------------------------------------------------------------------
create or replace function public.confirm_file_upload(p_org uuid, p_file uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_file    public.files%rowtype;
  v_obj     record;
  v_problem text;
begin
  if v_uid is null or not app.is_member(p_org) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('files_quota:' || p_org::text, 0));
  select * into v_file from public.files f where f.organization_id = p_org and f.id = p_file for update;
  if not found or v_file.uploaded_by is distinct from v_uid then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_file.unconfirmed_since is null then
    return jsonb_build_object('ok', true);
  end if;
  select * into v_obj from app.record_file_object(v_file.storage_path);
  v_problem := app.file_upload_problem(v_obj.present, v_obj.size, v_obj.mimetype);
  if v_problem is null and (v_file.accounting_document_id is not null or v_file.payment_id is not null) and not (v_obj.mimetype = any (app.document_file_types())) then
    v_problem := 'type';
  end if;
  if v_problem is null and not app.files_quota_ok(p_org, v_obj.size, p_file) then
    v_problem := 'quota';
  end if;
  if v_problem is not null then
    -- the row keeps waiting (hidden); a larger real size counts against the cap until it is removed
    update public.files f
       set size_bytes = case when v_obj.size between 1 and 26214400 and v_obj.size > f.size_bytes then v_obj.size else f.size_bytes end,
           upload_checked_at = now()
     where f.organization_id = p_org and f.id = p_file;
    return jsonb_build_object('ok', false, 'reason', v_problem);
  end if;
  update public.files f
     set size_bytes = v_obj.size, mime_type = v_obj.mimetype, unconfirmed_since = null, upload_checked_at = now()
   where f.organization_id = p_org and f.id = p_file;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.confirm_file_upload(uuid, uuid) from public, anon;
grant execute on function public.confirm_file_upload(uuid, uuid) to authenticated;

create or replace function app.reconcile_pending_files(p_limit integer default 500) returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  r         record;
  v_obj     record;
  v_problem text;
  v_done    integer := 0;
begin
  for r in
    select f.organization_id, f.id, f.storage_path, f.accounting_document_id, f.payment_id
      from public.files f
     where f.unconfirmed_since is not null
       and f.unconfirmed_since < now() - interval '10 minutes'
       and f.unconfirmed_since > now() - interval '14 days'
       and (f.upload_checked_at is null or f.upload_checked_at < now() - interval '1 hour')
     order by f.upload_checked_at nulls first, f.unconfirmed_since
     limit greatest(1, least(coalesce(p_limit, 500), 5000))
     for update skip locked
  loop
    begin
      perform pg_advisory_xact_lock(hashtextextended('files_quota:' || r.organization_id::text, 0));
      select * into v_obj from app.record_file_object(r.storage_path);
      v_problem := app.file_upload_problem(v_obj.present, v_obj.size, v_obj.mimetype);
      if v_problem is null and (r.accounting_document_id is not null or r.payment_id is not null) and not (v_obj.mimetype = any (app.document_file_types())) then
        v_problem := 'type';
      end if;
      if v_problem is null and not app.files_quota_ok(r.organization_id, v_obj.size, r.id) then
        v_problem := 'quota';
      end if;
      if v_problem is null then
        update public.files f
           set size_bytes = v_obj.size, mime_type = v_obj.mimetype, unconfirmed_since = null, upload_checked_at = now()
         where f.organization_id = r.organization_id and f.id = r.id;
      else
        update public.files f
           set size_bytes = case when v_obj.size between 1 and 26214400 and v_obj.size > f.size_bytes then v_obj.size else f.size_bytes end,
               upload_checked_at = now()
         where f.organization_id = r.organization_id and f.id = r.id;
      end if;
      v_done := v_done + 1;
    exception when others then
      raise warning 'reconcile_pending_files: file % skipped: %', r.id, sqlerrm;
    end;
  end loop;
  return v_done;
end;
$$;
revoke all on function app.reconcile_pending_files(integer) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Privacy erasure: 020635's app.audit_erase_core, plus the entries of the files of the documents and payments it reaches
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
     where a.organization_id = p_org and a.entity_type in ('tasks', 'files', 'activities', 'deal_lines', 'quotes', 'orders', 'accounting_documents', 'payments') and a.entity_id is not null
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
  if p_type in ('contacts', 'deals') then
    for v_child in
      select 'accounting_documents'::text as entity_type, d.id as entity_id
        from public.accounting_documents d
       where d.organization_id = p_org
         and d.id in (select a.entity_id from public.audit_log a
                       where a.organization_id = p_org and a.entity_type = 'accounting_documents' and a.entity_id is not null
                         and (a.changes ->> v_col = p_id::text or a.changes -> v_col ->> 'old' = p_id::text
                              or a.changes -> v_col ->> 'new' = p_id::text))
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
    for v_child in
      update public.payments pm
         set reference = null, note = null,
             cancel_reason = case when pm.status = 'cancelled' then 'הסיבה נמחקה (מחיקת פרטיות)' end
       where pm.organization_id = p_org
         and pm.id in (select a.entity_id from public.audit_log a
                        where a.organization_id = p_org and a.entity_type = 'payments' and a.entity_id is not null
                          and (a.changes ->> v_col = p_id::text or a.changes -> v_col ->> 'old' = p_id::text
                               or a.changes -> v_col ->> 'new' = p_id::text))
      returning 'payments'::text as entity_type, pm.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    perform set_config('app.payment_server', '', true);
  end if;
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

notify pgrst, 'reload schema';
