-- =============================================================================
-- ORD-05 PDF (owner, 1 November 2026, DECISIONS.md "מסמכי PDF שנשארו בגל 2", answer (1) ב): the order confirmation's PDF is
-- stored once per numbered order, written by the server alone, and the customer downloads it from the order's link
-- =============================================================================
-- An approved use of the service-role key under QUO-06's pattern and conditions (CLAUDE.md hard rule 5: one security definer
-- function granted to service_role only per use, no direct table access, SHA-256 on every serving, database tests, an
-- independent review). Every rule below is QUO-06's (020955, 020995) with the order in place of the quote:
-- * files.order_id: a file may belong to one order (files_one_subject counts eight columns; composite foreign key on delete
--   cascade: a numbered order is never deleted, and a draft never has a PDF). One file per order (files_order_pdf_root: one first file per order, and a file's newer
--   version is unique, files_one_newer, so an order's files form one line; 021121 adds the versions), a PDF
--   (files_order_pdf_shape), never on a note, never a version or a field file. Reading follows the order (orders_select).
-- * Server-only write: the app asks the person's right with their own session (public.order_pdf_allowed, invoker: a numbered
--   order that is not cancelled and whose customer was not deleted, a writable business with the `orders` flag, the caller may
--   edit its deal, else its contact, else its company: app.order_editable), renders the PDF, and hands size and SHA-256 to
--   public.order_pdf_store (service_role only), which checks again for that user (app.order_pdf_user_may: app.can_edit_record's
--   rule for a named user over the same parent; keep in step), takes the quota through trigger files_order_pdf (app.pdf_take:
--   max_pdf_per_month, 30 a minute, the 80% notice) and answers the one path the server may upload to; the second call naming
--   that path confirms the row once the object there is a PDF of the stated size. Upload/stored/busy, a two-minute takeover to
--   a fresh path, abandoned paths queued for the orphan cleanup (app.quote_pdf_abandon), files.sha256 server-only.
--   authenticated has no insert on files.order_id, the files_insert policy refuses an order's PDF, record_files_insert refuses
--   an object for an order's row, and app.reconcile_pending_files never confirms an order's server row.
-- * Kept: never removed (files_keep_attached, files_delete, storage record_files_delete) except an unconfirmed upload (an
--   owner or admin may remove a waiting row, which gives its count back: files_order_pdf_return) and a privacy erasure:
--   app.audit_erase_core calls app.order_pdf_drop for the detached orders it cleans, under the transaction setting
--   app.order_pdf_erase = the business. Its body (it removes rows) is in 20261006021120_order_pdf_erase, pasted by hand.
-- * Customer download: public.order_public_pdf(token, ip_hash) (service_role only) follows app.order_link_usable (not found
--   for an unknown or revoked token, a draft, a deleted customer, closed public pages or no flag), counts in the link's own
--   window shared with the page (120 in 10 minutes) and in its own per-sender window (20 in 10 minutes, keyed IP hash scoped
--   to the order by app.order_link_sender, 1,024 reused buckets, no hash kept), gives no file for a cancelled order (its
--   page is a status page without prices) and answers only the storage path, the SHA-256 and the file name.
--   public.order_public (021087's body) adds `pdf` (a stored, fingerprinted file exists) for the page's link.
-- Every statement is safe to run twice. No drops, no row removal.

alter table public.files add column if not exists order_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'files_order_fk') then
    alter table public.files add constraint files_order_fk
      foreign key (organization_id, order_id) references public.orders (organization_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'files_order_pdf_shape') then
    alter table public.files add constraint files_order_pdf_shape
      check (order_id is null
             or (activity_id is null and previous_id is null and custom_field_key is null and mime_type = 'application/pdf'));
  end if;
end;
$$;

-- one subject each: a record, a document, a payment, a quote or an order (every existing row has exactly one of the first seven)
alter table public.files drop constraint if exists files_one_subject;
alter table public.files add constraint files_one_subject
  check (num_nonnulls(lead_id, contact_id, company_id, deal_id, accounting_document_id, payment_id, quote_id, order_id) = 1);

-- the SHA-256 is kept on a server row only: a quote's or an order's PDF
alter table public.files drop constraint if exists files_sha256_shape;
alter table public.files add constraint files_sha256_shape
  check (sha256 is null or ((quote_id is not null or order_id is not null) and sha256 ~ '^[0-9a-f]{64}$'));

-- a server row (a quote's or an order's PDF) moves to a fresh path of its own business for each render attempt
alter table public.files drop constraint if exists files_path;
alter table public.files add constraint files_path
  check (storage_path = organization_id::text || '/' || id::text
         or ((quote_id is not null or order_id is not null)
             and storage_path ~ ('^' || organization_id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')));

create index if not exists files_order_idx on public.files (organization_id, order_id);
-- one first PDF per numbered order; with files_one_newer (one newer version per file) an order's files are one line, so there
-- is exactly one current file (the one no other file names as its earlier version). Here previous_id is always null
-- (files_order_pdf_shape), so this is one PDF per order; 20261006021121 lets a newer version follow (owner's answer (34) ב).
create unique index if not exists files_order_pdf_root on public.files (organization_id, order_id)
  where order_id is not null and previous_id is null;

-- ----------------------------------------------------------------------------
-- Policies (the latest of each, 020955 / 020995, with the order lines added)
-- ----------------------------------------------------------------------------
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
                  -- ORD-05: an order's PDF follows the order (orders_select)
                  when order_id is not null
                  then exists (select 1 from public.orders od
                                where od.organization_id = files.organization_id and od.id = files.order_id)
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
                       -- QUO-06 (owner's answer 3) and ORD-05 (answer (1) ב): only the server writes these PDFs
                       when quote_id is not null or order_id is not null
                       then false
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
                  -- a quote's or an order's PDF: likewise, and an owner or admin also removes a server row that never got its
                  -- object (it would block the PDF for good); the prefix above already asks for one of the two
                  when quote_id is not null or order_id is not null
                  then unconfirmed_since is not null
                  else app.can_read_activity_subject(lead_id, contact_id, company_id, deal_id)
                       and (activity_id is null
                            or exists (select 1 from public.activities a
                                        where a.organization_id = files.organization_id and a.id = files.activity_id))
             end);

alter policy record_files_delete on storage.objects
  using (bucket_id = 'record-files'
         and exists (select 1 from public.files f
                      where f.storage_path = objects.name and app.can_write(f.organization_id)
                        and (f.uploaded_by = (select auth.uid()) or app.is_admin(f.organization_id))
                        and ((f.accounting_document_id is null and f.payment_id is null and f.quote_id is null and f.order_id is null)
                             or (f.unconfirmed_since is not null and f.uploaded_by = (select auth.uid()))
                             or ((f.quote_id is not null or f.order_id is not null) and f.unconfirmed_since is not null
                                 and app.is_admin(f.organization_id)))
                        and (f.custom_field_key is null or not app.field_file_in_use(f.organization_id, f.id))));

alter policy record_files_insert on storage.objects
  with check (bucket_id = 'record-files'
              and exists (select 1 from public.files f
                           where f.storage_path = objects.name
                             and f.uploaded_by = (select auth.uid())
                             and f.unconfirmed_since is not null
                             and f.quote_id is null
                             and f.order_id is null));

-- For every writer, definer paths included (020955, plus orders)
create or replace function app.files_keep_attached() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- a privacy erasure removes a detached quote's or order's PDF: only app.quote_pdf_drop / app.order_pdf_drop set these,
  -- inside the erasure's transaction, naming the business; a person's delete is refused by the files policy before it gets here
  if old.quote_id is not null and current_setting('app.quote_pdf_erase', true) = old.organization_id::text then
    return old;
  end if;
  if old.order_id is not null and current_setting('app.order_pdf_erase', true) = old.organization_id::text then
    return old;
  end if;
  if (old.accounting_document_id is not null or old.payment_id is not null or old.quote_id is not null or old.order_id is not null)
     and old.unconfirmed_since is null and app.org_exists(old.organization_id) then
    raise exception 'a document''s, a payment''s, a quote''s or an order''s file is kept' using errcode = 'P0001', hint = 'file:kept';
  end if;
  return old;
end;
$$;
revoke all on function app.files_keep_attached() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The quota: an order's PDF is a numbered order's that is not cancelled, the flag, then app.pdf_take (QUO-06's counter)
-- ----------------------------------------------------------------------------
create or replace function app.files_order_pdf() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_order public.orders;
begin
  if new.order_id is null then
    return new;
  end if;
  select * into v_order from public.orders o where o.organization_id = new.organization_id and o.id = new.order_id;
  -- review (low), as files_quote_pdf: a person the write rules refuse gets RLS's plain 42501 right after (the files_insert
  -- policy refuses an order's PDF for everyone), never this business's quota or plan; the server's caller was checked by
  -- public.order_pdf_store
  if auth.uid() is not null
     and not (v_order.id is not null and app.can_write(new.organization_id) and app.org_writable(new.organization_id)
              and v_order.status not in ('draft', 'cancelled')
              and app.order_editable(v_order.organization_id, v_order.deal_id, v_order.contact_id, v_order.company_id)) then
    return new;
  end if;
  if v_order.id is null or v_order.status = 'draft' then
    raise exception 'a draft order has no PDF' using errcode = 'P0001', hint = 'order_pdf:draft';
  end if;
  if v_order.status = 'cancelled' or v_order.customer_deleted_at is not null then
    raise exception 'an order''s PDF is made while it is numbered and not cancelled' using errcode = 'P0001', hint = 'order_pdf:closed';
  end if;
  if not app.org_has_feature(new.organization_id, 'orders') then
    raise exception 'orders are not in the plan' using errcode = 'P0001', hint = 'feature:orders';
  end if;
  perform app.pdf_take(new.organization_id);
  return new;
end;
$$;
revoke all on function app.files_order_pdf() from public, anon, authenticated;

-- named to run after files_before_insert, files_field_check and files_links_check, so a row they refuse is never counted
create or replace trigger files_order_pdf before insert on public.files
  for each row when (new.order_id is not null) execute function app.files_order_pdf();

-- the quota counts files made, not attempts: a waiting row that is removed gives its count back (QUO-06 review M2)
create or replace function app.files_order_pdf_return() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if old.order_id is not null and old.unconfirmed_since is not null then
    update app.pdf_months m
       set produced = greatest(m.produced - 1, 0)
     where m.organization_id = old.organization_id
       and m.month = date_trunc('month', old.created_at at time zone coalesce(
             (select nullif(o.timezone, '') from public.organizations o where o.id = old.organization_id), 'Asia/Jerusalem'))::date;
  end if;
  return old;
end;
$$;
revoke all on function app.files_order_pdf_return() from public, anon, authenticated;

create or replace trigger files_order_pdf_return after delete on public.files
  for each row when (old.order_id is not null) execute function app.files_order_pdf_return();

-- ----------------------------------------------------------------------------
-- 020995's app.reconcile_pending_files, skipping an order's server row too (only public.order_pdf_store confirms it)
-- ----------------------------------------------------------------------------
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
    select f.organization_id, f.id, f.storage_path, f.accounting_document_id, f.payment_id, f.quote_id
      from public.files f
     where f.unconfirmed_since is not null
       -- QUO-06 follow-up (review M2): a quote's PDF written by the server is confirmed by public.quote_pdf_store only
       and not (f.quote_id is not null and f.sha256 is not null)
       -- ORD-05: an order's PDF is written by the server alone and confirmed by public.order_pdf_store only
       and f.order_id is null
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
      if v_problem is null and r.quote_id is not null and v_obj.mimetype is distinct from 'application/pdf' then
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
-- The person's right, asked with their own session (the app calls it before rendering)
-- ----------------------------------------------------------------------------
create or replace function public.order_pdf_allowed(p_org uuid, p_order uuid) returns boolean
language sql stable security invoker
set search_path = ''
as $$
  select exists (
    select 1 from public.orders o
     where o.organization_id = p_org and o.id = p_order
       and o.status not in ('draft', 'cancelled')
       and o.customer_deleted_at is null
       and app.can_write(o.organization_id)
       and app.org_writable(o.organization_id)
       and app.org_has_feature(o.organization_id, 'orders')
       and app.order_editable(o.organization_id, o.deal_id, o.contact_id, o.company_id))
$$;
revoke all on function public.order_pdf_allowed(uuid, uuid) from public, anon;
grant execute on function public.order_pdf_allowed(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The same right for a named user, checked again inside the service-role function: app.order_editable's parent (the deal,
-- else the contact, else the company) under app.can_edit_record's rule (keep in step with app.quote_pdf_user_may)
-- ----------------------------------------------------------------------------
create or replace function app.order_pdf_user_may(p_org uuid, p_user uuid, p_deal uuid, p_contact uuid, p_company uuid) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_role  public.membership_role;
  v_owner uuid;
  v_team  uuid;
begin
  if p_user is null or not app.org_writable(p_org) then
    return false;
  end if;
  select m.role into v_role
    from public.memberships m
   where m.organization_id = p_org and m.user_id = p_user and m.status = 'active';
  if v_role is null or v_role = 'viewer' then
    return false;
  end if;
  if p_deal is not null then
    select d.owner_id, d.team_id into v_owner, v_team
      from public.deals d where d.organization_id = p_org and d.id = p_deal and d.deleted_at is null;
  elsif p_contact is not null then
    select c.owner_id, c.team_id into v_owner, v_team
      from public.contacts c where c.organization_id = p_org and c.id = p_contact and c.deleted_at is null;
  elsif p_company is not null then
    select c.owner_id, c.team_id into v_owner, v_team
      from public.companies c where c.organization_id = p_org and c.id = p_company and c.deleted_at is null;
  else
    return false;
  end if;
  if not found then
    return false;
  end if;
  if v_role in ('owner', 'admin') or (v_owner is not null and v_owner = p_user) then
    return true;
  end if;
  return v_role = 'manager' and v_team is not null and exists (
    with recursive chain as (
      select t.id, t.parent_team_id, 1 as depth
        from public.teams t where t.id = v_team
      union all
      select t.id, t.parent_team_id, c.depth + 1
        from public.teams t join chain c on t.id = c.parent_team_id
       where c.depth < 10
    )
    select 1 from chain c join public.team_members tm on tm.team_id = c.id
     where tm.user_id = p_user and tm.is_manager);
end;
$$;
revoke all on function app.order_pdf_user_may(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The one service-role entry for writing (QUO-06's public.quote_pdf_store with the order in place of the quote): answers
-- {status: upload, path}, {status: stored, file_id} or {status: busy}; refusals raise
-- p_content_stamp: the orders.pdf_content_changed_at the caller's render read (null when never changed); 20261006021121 keeps it
-- with the file and judges the order's current PDF by it. Unused here.
-- ----------------------------------------------------------------------------
create or replace function public.order_pdf_store(p_org uuid, p_order uuid, p_user uuid, p_size bigint, p_sha256 text, p_name text,
                                                  p_path text default null, p_content_stamp timestamptz default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_file  public.files;
  v_obj   record;
  v_path  text;
begin
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' or p_size is null or p_size < 1 or p_size > 26214400
     or coalesce(btrim(p_name), '') = '' or char_length(p_name) > 200 or p_name ~ '[/\\]' or lower(p_name) !~ '\.pdf$' then
    raise exception 'invalid PDF details' using errcode = '22023', hint = 'order_pdf:invalid';
  end if;
  select * into v_order from public.orders o where o.organization_id = p_org and o.id = p_order;
  if not found or not app.order_pdf_user_may(p_org, p_user, v_order.deal_id, v_order.contact_id, v_order.company_id) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  -- one render at a time per order
  perform pg_advisory_xact_lock(hashtextextended('order_pdf:' || p_order::text, 0));
  select * into v_file from public.files f where f.organization_id = p_org and f.order_id = p_order for update;
  if found and v_file.unconfirmed_since is null then
    -- a stale render that uploaded to its own path: that object is not the file
    if p_path is distinct from v_file.storage_path then
      perform app.quote_pdf_abandon(p_org, p_path);
    end if;
    return jsonb_build_object('status', 'stored', 'file_id', v_file.id);
  end if;
  if v_order.status = 'draft' then
    raise exception 'a draft order has no PDF' using errcode = 'P0001', hint = 'order_pdf:draft';
  end if;
  if v_order.status = 'cancelled' or v_order.customer_deleted_at is not null then
    raise exception 'an order''s PDF is made while it is numbered and not cancelled' using errcode = 'P0001', hint = 'order_pdf:closed';
  end if;
  if not app.org_has_feature(p_org, 'orders') then
    raise exception 'orders are not in the plan' using errcode = 'P0001', hint = 'feature:orders';
  end if;

  if v_file.id is null then
    -- files_before_insert sets the path (`<org>/<file id>`) and no uploader (no session); files_order_pdf takes the quota
    insert into public.files (organization_id, order_id, name, mime_type, size_bytes, unconfirmed_since, sha256)
    values (p_org, p_order, btrim(p_name), 'application/pdf', p_size, now(), p_sha256)
    returning * into v_file;
    update public.files f set upload_checked_at = now() where f.organization_id = p_org and f.id = v_file.id;
    perform app.quote_pdf_abandon(p_org, p_path);
    return jsonb_build_object('status', 'upload', 'path', v_file.storage_path);
  end if;

  if v_file.sha256 = p_sha256 and (p_path is null or p_path = v_file.storage_path) then
    -- the second call of the attempt that holds the row: its own path must hold a PDF of the stated size
    select * into v_obj from app.record_file_object(v_file.storage_path);
    if v_obj.present and v_obj.size = v_file.size_bytes and v_obj.mimetype = 'application/pdf' then
      update public.files f set unconfirmed_since = null, upload_checked_at = now()
       where f.organization_id = p_org and f.id = v_file.id;
      return jsonb_build_object('status', 'stored', 'file_id', v_file.id);
    end if;
    if not v_obj.present then
      return jsonb_build_object('status', 'upload', 'path', v_file.storage_path);
    end if;
    -- something else is on the attempt's path: leave it to the cleanup and start a fresh path
  else
    -- another attempt holds the row; a stale caller's own upload is queued for the cleanup
    if p_path is distinct from v_file.storage_path then
      perform app.quote_pdf_abandon(p_org, p_path);
    end if;
    -- after two minutes without its object the row is taken over
    if coalesce(v_file.upload_checked_at, v_file.created_at) > now() - interval '2 minutes' then
      return jsonb_build_object('status', 'busy');
    end if;
  end if;

  -- a fresh path for this attempt; the abandoned one goes to the orphan cleanup once no row uses it
  v_path := p_org::text || '/' || gen_random_uuid()::text;
  update public.files f
     set storage_path = v_path, sha256 = p_sha256, size_bytes = p_size, name = btrim(p_name), uploaded_by = null,
         upload_checked_at = now()
   where f.organization_id = p_org and f.id = v_file.id;
  perform app.quote_pdf_abandon(p_org, v_file.storage_path);
  return jsonb_build_object('status', 'upload', 'path', v_path);
end;
$$;
revoke all on function public.order_pdf_store(uuid, uuid, uuid, bigint, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.order_pdf_store(uuid, uuid, uuid, bigint, text, text, text, timestamptz) to service_role;

-- ----------------------------------------------------------------------------
-- The customer's download: a per-sender window, keyed by the server's IP hash scoped to the order (no hash kept)
-- ----------------------------------------------------------------------------
create table if not exists app.order_pdf_download_counts (
  organization_id uuid not null,
  order_id        uuid not null,
  bucket          integer not null check (bucket between 0 and 1023),
  window_start    timestamptz not null,
  downloads       integer not null,
  primary key (order_id, bucket),
  constraint order_pdf_download_counts_order_fk foreign key (organization_id, order_id)
    references public.orders (organization_id, id) on delete cascade
);
create index if not exists order_pdf_download_counts_order_idx on app.order_pdf_download_counts (organization_id, order_id);
alter table app.order_pdf_download_counts enable row level security;
revoke all on app.order_pdf_download_counts from public, anon, authenticated, service_role;

create or replace function public.order_public_pdf(p_token text, p_ip_hash text default null) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_link    app.order_links;
  v_order   public.orders;
  v_count   integer;
  v_bucket  integer;
  v_file    public.files;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'order not found' using errcode = 'P0002';
  end if;
  select * into v_link from app.order_links l where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found then
    raise exception 'order not found' using errcode = 'P0002';
  end if;
  select * into v_order from public.orders o where o.organization_id = v_link.organization_id and o.id = v_link.order_id;
  -- the one rule for the order's link (order_public)
  if not found or not app.order_link_usable(v_order) then
    raise exception 'order not found' using errcode = 'P0002';
  end if;

  -- the link's own window, shared with the page (120 in 10 minutes), counted first
  update app.order_links l
     set window_started_at = case when l.window_started_at > now() - interval '10 minutes' then l.window_started_at else now() end,
         window_count = case when l.window_started_at > now() - interval '10 minutes' then l.window_count + 1 else 1 end
   where l.order_id = v_link.order_id
  returning l.window_count into v_count;
  if v_count > 120 then
    return jsonb_build_object('rate_limited', true);
  end if;
  -- FXS-11: 20 downloads per sender in 10 minutes, by the server's keyed IP hash scoped to this order (QUO-06 answer 2 (א))
  if p_ip_hash is not null then
    v_bucket := ((hashtextextended(app.order_link_sender(v_order.id, p_ip_hash), 0) % 1024) + 1024) % 1024;
    insert into app.order_pdf_download_counts as dc (organization_id, order_id, bucket, window_start, downloads)
    values (v_order.organization_id, v_order.id, v_bucket, now(), 1)
    on conflict (order_id, bucket) do update
      set window_start = case when dc.window_start > now() - interval '10 minutes' then dc.window_start else now() end,
          downloads = case when dc.window_start > now() - interval '10 minutes' then dc.downloads + 1 else 1 end
    returning dc.downloads into v_count;
    if v_count > 20 then
      return jsonb_build_object('rate_limited', true);
    end if;
  end if;

  -- a cancelled order's page is a status page without prices: no file
  if v_order.status = 'cancelled' then
    return jsonb_build_object('unavailable', true);
  end if;
  select * into v_file from public.files f
   where f.organization_id = v_order.organization_id and f.order_id = v_order.id
     and f.unconfirmed_since is null and f.sha256 is not null;
  if not found then
    return jsonb_build_object('unavailable', true);
  end if;
  return jsonb_build_object('path', v_file.storage_path, 'sha256', v_file.sha256, 'name', v_file.name);
end;
$$;
revoke all on function public.order_public_pdf(text, text) from public, anon, authenticated;
grant execute on function public.order_public_pdf(text, text) to service_role;

-- ----------------------------------------------------------------------------
-- A privacy erasure removes the stored PDF of the erased customer's detached orders (QUO-06 answer (2) א, the same for
-- orders). The removal is the only row removal, so it lives in 20261006021120_order_pdf_erase (pasted by hand in the SQL
-- Editor). Here a no-op, made only while the function does not exist yet, so running this file again never undoes it.
-- ----------------------------------------------------------------------------
do $do$
begin
  if to_regprocedure('app.order_pdf_drop(uuid, uuid[])') is null then
    execute $f$
      create function app.order_pdf_drop(p_org uuid, p_orders uuid[]) returns void
      language plpgsql security definer
      set search_path = ''
      as $b$
      begin
        -- 20261006021120 removes the PDF files rows of these orders (their objects go to the orphan cleanup)
        null;
      end;
      $b$
    $f$;
  end if;
end;
$do$;
revoke all on function app.order_pdf_drop(uuid, uuid[]) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- public.order_public: 021087's body (TAX-02), plus `pdf` (the order has a stored, fingerprinted file) for the page's link
-- ----------------------------------------------------------------------------
create or replace function public.order_public(p_token text, p_ip_hash text default null) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_link app.order_links;
  v_order public.orders;
  v_count integer;
  v_bucket integer;
  v_views integer;
  v_design public.quote_designs;
  v_settings public.org_document_settings;
  v_org public.organizations;
  v_decision public.order_decisions;
  v_show_details boolean;
  v_show_logo boolean;
  -- TAX-02: the bank details stored on the order when it was numbered, when the design shows them
  v_show_bank boolean;
  v_lines jsonb;
  v_schedule jsonb;
  v_built_with boolean;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'order not found' using errcode = 'P0002';
  end if;
  select * into v_link from app.order_links l where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found then
    raise exception 'order not found' using errcode = 'P0002';
  end if;
  select * into v_order from public.orders o where o.organization_id = v_link.organization_id and o.id = v_link.order_id;
  if not found or not app.order_link_usable(v_order) then
    raise exception 'order not found' using errcode = 'P0002';
  end if;

  -- 120 views per link in 10 minutes; counted first, so the limit holds under parallel load
  update app.order_links l
     set window_started_at = case when l.window_started_at > now() - interval '10 minutes' then l.window_started_at else now() end,
         window_count = case when l.window_started_at > now() - interval '10 minutes' then l.window_count + 1 else 1 end
   where l.order_id = v_link.order_id
  returning l.window_count into v_count;
  if v_count > 120 then
    return jsonb_build_object('rate_limited', true);
  end if;
  -- FXS-11: 60 views per sender in 10 minutes, by the server's keyed IP hash scoped to this order
  if p_ip_hash is not null then
    v_bucket := ((hashtextextended(app.order_link_sender(v_order.id, p_ip_hash), 0) % 1024) + 1024) % 1024;
    insert into app.order_link_view_counts as vc (order_id, bucket, window_start, views)
    values (v_order.id, v_bucket, now(), 1)
    on conflict (order_id, bucket) do update
      set window_start = case when vc.window_start > now() - interval '10 minutes' then vc.window_start else now() end,
          views = case when vc.window_start > now() - interval '10 minutes' then vc.views + 1 else 1 end
    returning vc.views into v_views;
    if v_views > 60 then
      return jsonb_build_object('rate_limited', true);
    end if;
  end if;

  select * into v_org from public.organizations o where o.id = v_order.organization_id;
  select * into v_design from public.quote_designs d where d.organization_id = v_order.organization_id;
  select * into v_settings from public.org_document_settings s where s.organization_id = v_order.organization_id;
  -- QUO-05: no design row = the defaults (logo and business details shown)
  v_show_details := coalesce(v_design.show_business_details, true);
  v_show_logo := coalesce(v_design.show_logo, true);
  v_show_bank := coalesce(v_design.show_bank_details_order, true);

  -- a cancelled order: its state only, no prices or lines (the one rule for a sent link)
  if v_order.status = 'cancelled' then
    return jsonb_build_object('status_page', jsonb_build_object(
      'state', 'cancelled',
      'number', v_order.number_display,
      -- documents use the registered name when set (owner)
      'business', coalesce(nullif(btrim(v_settings.legal_name), ''), v_org.name),
      'logo', case when v_show_logo then v_org.logo_path end,
      'color', coalesce(v_design.accent_color, v_org.brand_color),
      'phone', coalesce(nullif(btrim(v_settings.phone), ''), nullif(btrim(v_org.phone), ''))));
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'position', l.position,
           'kind', l.kind,
           'name', l.name,
           'description', l.description,
           'unit_name', l.unit_name,
           'quantity', l.quantity,
           'unit_price_agorot', l.unit_price_agorot,
           'discount_bp', l.discount_bp,
           'discount_agorot', l.discount_agorot,
           'vat_exempt', l.vat_exempt,
           'billing', l.billing,
           'total_agorot', l.total_agorot) order by l.position, l.id), '[]'::jsonb)
    into v_lines
    from public.order_lines l
   where l.organization_id = v_order.organization_id and l.order_id = v_order.id;

  -- ORD-04: each step with its share of the total (cumulative shares, half up, = scheduleAmounts())
  select coalesce(jsonb_agg(jsonb_build_object(
           'name', r.name,
           'percent_bp', r.percent_bp,
           'due_date', r.due_date,
           'milestone', r.milestone,
           'amount_agorot', round(v_order.total_agorot::numeric * r.cum / 10000) - round(v_order.total_agorot::numeric * (r.cum - r.percent_bp) / 10000))
         order by r.position, r.id), '[]'::jsonb)
    into v_schedule
    from (select s.id, s.position, s.name, s.percent_bp, s.due_date, s.milestone,
                 sum(s.percent_bp) over (order by s.position, s.id) as cum
            from public.order_payment_steps s
           where s.organization_id = v_order.organization_id and s.order_id = v_order.id) r;

  select * into v_decision from public.order_decisions d where d.organization_id = v_order.organization_id and d.order_id = v_order.id;

  begin
    v_built_with := coalesce(app.show_built_with(v_order.organization_id), true);
  exception when others then
    v_built_with := true;
  end;

  return jsonb_build_object(
    'order', jsonb_build_object(
      'number', v_order.number_display,
      'status', v_order.status,
      'order_date', v_order.order_date,
      'delivery_date', v_order.delivery_date,
      'shipping_address', v_order.shipping_address,
      'notes', v_order.notes,
      'prices_include_vat', v_order.prices_include_vat,
      'no_vat_reason', v_order.no_vat_reason,
      'no_vat_note', v_order.no_vat_note,
      'discount_bp', v_order.discount_bp,
      'discount_agorot', v_order.discount_agorot,
      'vat_rate_bp', v_order.vat_rate_bp,
      'subtotal_agorot', v_order.subtotal_agorot,
      'discount_total_agorot', v_order.discount_total_agorot,
      'net_total_agorot', v_order.net_total_agorot,
      'vat_agorot', v_order.vat_agorot,
      'total_agorot', v_order.total_agorot,
      'currency', v_order.currency),
    -- the customer as named when the order was numbered (ORD-03); never the live record
    'customer', jsonb_build_object('name', v_order.customer_name),
    'lines', v_lines,
    'schedule', v_schedule,
    'business', jsonb_build_object(
      'name', coalesce(nullif(btrim(v_settings.legal_name), ''), v_org.name),
      'tax_id', case when v_show_details then v_settings.tax_id end,
      'address_line', case when v_show_details then v_settings.address_line end,
      'city', case when v_show_details then v_settings.city end,
      'postal_code', case when v_show_details then v_settings.postal_code end,
      'phone', case when v_show_details then v_settings.phone end,
      'email', case when v_show_details then v_settings.email end),
    'design', jsonb_build_object(
      'header_text', v_design.header_text,
      'footer_text', v_design.footer_text,
      'show_logo', v_show_logo,
      'show_business_details', v_show_details,
      'show_bank_details_order', v_show_bank,
      'accent_color', v_design.accent_color),
    'brand', jsonb_build_object('logo', case when v_show_logo then v_org.logo_path end, 'color', v_org.brand_color),
    'built_with', v_built_with,
    -- TAX-02: the business's bank details for a transfer, as stored on the order when it was numbered (never the live
    -- settings); only when the design shows them and the order has them
    'bank', case when v_show_bank and v_order.bank_details is not null then jsonb_build_object(
                   'bank_name', v_order.bank_details ->> 'bank_name',
                   'bank_branch', v_order.bank_details ->> 'bank_branch',
                   'bank_account', v_order.bank_details ->> 'bank_account',
                   'bank_account_name', v_order.bank_details ->> 'bank_account_name') end,
    -- the customer's answer: what and when only
    'decision', case when v_decision.id is not null
                     then jsonb_build_object('decision', v_decision.decision, 'decided_at', v_decision.decided_at) end,
    -- what an answer must name, while the order waits for one
    'fingerprint', case when v_order.status = 'new' and v_decision.id is null then app.order_fingerprint(v_order) end,
    -- ORD-05 PDF (owner's answer (1) ב): the customer may download the order's stored PDF
    'pdf', exists (select 1 from public.files f
                    where f.organization_id = v_order.organization_id and f.order_id = v_order.id
                      and f.unconfirmed_since is null and f.sha256 is not null));
end;
$$;
revoke all on function public.order_public(text, text) from public, anon, authenticated;
grant execute on function public.order_public(text, text) to service_role;

-- ----------------------------------------------------------------------------
-- Privacy erasure: app.audit_erase_core copied exactly from its latest body (021117, QUO-08) with ONE change, marked ORD-05
-- PDF (inside the ORD-01 block): the detached orders' stored PDF goes through app.order_pdf_drop.
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
