-- =============================================================================
-- QUO-06: the PDF of every sent quote version, kept as a file; and the business's monthly PDF quota
-- =============================================================================
-- The PDF is made on our own server (owner, 13 October 2026, DECISIONS.md "PDF") from the quote's stored values, once per
-- sent version, and kept in the private bucket record-files under the files rules (no new bucket, no service-role use): the
-- server writes the row, the object and the confirmation with the session of the person who sent the quote.
-- * files.quote_id: a file may belong to one quote instead of a record, a document or a payment (files_one_subject counts it;
--   composite foreign key, on delete cascade: a sent quote is never deleted, only a draft goes with its record, and a draft
--   never has a PDF). One file per quote (files_quote_pdf_one), a PDF (files_quote_pdf_shape, which also holds on the real
--   object: confirm_file_upload writes the object's type into mime_type), never on a note, never a version or a field file.
-- * Reading follows the quote (quotes_select: its deal, else its contact, else owners/admins/managers for a detached quote), so
--   whoever reads the quote downloads its PDF through /o/[org]/files/[file]. Adding needs a writable business with the
--   `quotes` flag and a quote that is no longer a draft whose deal or contact the caller may edit (app.quote_editable).
-- * Kept: nobody deletes a quote's PDF (the rule of 020640 for documents and payments): the files policy, the Storage delete
--   policy and trigger files_keep_attached refuse it for every writer, with the same two exceptions (the business's own
--   deletion; the uploader's own upload that never arrived, which the app removes when an upload fails).
-- * The quota (owner, 13 October 2026, DECISIONS.md "max_pdf_per_month"): every new PDF file counts one production in
--   app.pdf_months (per business and month in its own time zone; app.automation_run_month). At the plan's
--   max_pdf_per_month a new PDF is refused (hint limit:max_pdf_per_month); a link, a view and a signature never pass here.
--   At most 30 a minute per business (hint rate:pdf). Once a month, at 80%, one `system` notice to the active owners and
--   admins. A refused production is not counted (the same statement rolls back). Downloads and views read the stored file
--   and count nothing.
-- * Review follow-ups (lead, 26 October 2026): a PDF is made later only while the quote is sent or viewed (L3, hint
--   quote_pdf:closed); an owner or admin may remove someone else's upload that never arrived (L1); removing a waiting row gives
--   its count back (M2); confirm_file_upload answers a non-PDF object instead of raising (L2); a privacy erasure removes the
--   detached quote's PDF through app.quote_pdf_drop, whose body is in 20261006020960_quote_pdf_erase (pasted; H1).
-- Every statement is safe to run twice. No drops, no row removal.

alter table public.files add column if not exists quote_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'files_quote_fk') then
    alter table public.files add constraint files_quote_fk
      foreign key (organization_id, quote_id) references public.quotes (organization_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'files_quote_pdf_shape') then
    alter table public.files add constraint files_quote_pdf_shape
      check (quote_id is null
             or (activity_id is null and previous_id is null and custom_field_key is null and mime_type = 'application/pdf'));
  end if;
end;
$$;

-- one subject each: a record, a document, a payment or a quote (every existing row has exactly one of the first six)
alter table public.files drop constraint if exists files_one_subject;
alter table public.files add constraint files_one_subject
  check (num_nonnulls(lead_id, contact_id, company_id, deal_id, accounting_document_id, payment_id, quote_id) = 1);

create index if not exists files_quote_idx on public.files (organization_id, quote_id);
-- one PDF per quote (a sent version never changes, so its file is made once)
create unique index if not exists files_quote_pdf_one on public.files (organization_id, quote_id) where quote_id is not null;

grant insert (quote_id) on public.files to authenticated;

-- ----------------------------------------------------------------------------
-- Policies: a quote's PDF follows the quote; the other branches keep the rules of 020645
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
                       when quote_id is not null
                       then app.org_writable(organization_id) and app.org_has_feature(organization_id, 'quotes')
                            and exists (select 1 from public.quotes qu
                                         where qu.organization_id = files.organization_id and qu.id = files.quote_id
                                           and qu.status in ('sent', 'viewed')
                                           and app.quote_editable(qu.organization_id, qu.deal_id, qu.contact_id))
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
                  -- a quote's PDF: likewise, and an owner or admin also removes someone else's upload that never arrived
                  -- (review L1: it would block the quote's PDF for good); the prefix above already asks for one of the two
                  when quote_id is not null
                  then unconfirmed_since is not null
                  else app.can_read_activity_subject(lead_id, contact_id, company_id, deal_id)
                       and (activity_id is null
                            or exists (select 1 from public.activities a
                                        where a.organization_id = files.organization_id and a.id = files.activity_id))
             end);

-- Storage keeps the object of a document's, a payment's or a quote's file (020905's rule for a field's file stays)
alter policy record_files_delete on storage.objects
  using (bucket_id = 'record-files'
         and exists (select 1 from public.files f
                      where f.storage_path = objects.name and app.can_write(f.organization_id)
                        and (f.uploaded_by = (select auth.uid()) or app.is_admin(f.organization_id))
                        and ((f.accounting_document_id is null and f.payment_id is null and f.quote_id is null)
                             or (f.unconfirmed_since is not null and f.uploaded_by = (select auth.uid()))
                             or (f.quote_id is not null and f.unconfirmed_since is not null and app.is_admin(f.organization_id)))
                        and (f.custom_field_key is null or not app.field_file_in_use(f.organization_id, f.id))));

-- For every writer, definer paths included (020645, plus quotes)
create or replace function app.files_keep_attached() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- a privacy erasure removes a detached quote's PDF (review H1): only app.quote_pdf_drop sets this, inside the erasure's
  -- transaction, naming the business; a person's delete is refused by the files policy before it gets here
  if old.quote_id is not null and current_setting('app.quote_pdf_erase', true) = old.organization_id::text then
    return old;
  end if;
  if (old.accounting_document_id is not null or old.payment_id is not null or old.quote_id is not null)
     and old.unconfirmed_since is null and app.org_exists(old.organization_id) then
    raise exception 'a document''s, a payment''s or a quote''s file is kept' using errcode = 'P0001', hint = 'file:kept';
  end if;
  return old;
end;
$$;
revoke all on function app.files_keep_attached() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The quota: one row per business and month (its own time zone), no grants
-- ----------------------------------------------------------------------------
create table if not exists app.pdf_months (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  month           date not null,
  produced        integer not null default 0 check (produced >= 0),
  warned_80_at    timestamptz,
  -- the rate window: the productions of the minute that started at minute_start
  minute_start    timestamptz,
  minute_count    integer not null default 0 check (minute_count >= 0),
  primary key (organization_id, month)
);
alter table app.pdf_months enable row level security;
revoke all on app.pdf_months from public, anon, authenticated, service_role;

-- Counts one new PDF of the business, or refuses it (limit:max_pdf_per_month, rate:pdf). Called inside the statement that
-- stores the file, so a refused or failed store counts nothing.
create or replace function app.pdf_take(p_org uuid) returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_month date := app.automation_run_month(p_org);
  v_limit numeric := app.org_limit(p_org, 'max_pdf_per_month');
  v_row   app.pdf_months;
  v_now   integer;
begin
  insert into app.pdf_months (organization_id, month) values (p_org, v_month) on conflict (organization_id, month) do nothing;
  select * into v_row from app.pdf_months where organization_id = p_org and month = v_month for update;
  if v_limit is not null and v_row.produced >= v_limit then
    raise exception 'monthly PDF limit reached (%)', v_limit using errcode = 'P0001', hint = 'limit:max_pdf_per_month';
  end if;
  if v_row.minute_start is not null and v_row.minute_start > now() - interval '1 minute' and v_row.minute_count >= 30 then
    raise exception 'too many PDF files this minute' using errcode = 'P0001', hint = 'rate:pdf';
  end if;
  update app.pdf_months
     set produced = produced + 1,
         minute_start = case when minute_start is not null and minute_start > now() - interval '1 minute' then minute_start else now() end,
         minute_count = case when minute_start is not null and minute_start > now() - interval '1 minute' then minute_count + 1 else 1 end
   where organization_id = p_org and month = v_month
  returning produced into v_now;
  -- once a month, at 80%: the active owners and admins
  if v_limit is not null and v_limit > 0 and v_now >= ceil(v_limit * 0.8) and v_row.warned_80_at is null then
    update app.pdf_months set warned_80_at = now() where organization_id = p_org and month = v_month and warned_80_at is null;
    if found then
      insert into public.notifications (organization_id, user_id, type, title, body)
      select p_org, m.user_id, 'system', 'קובצי ה-PDF הגיעו ל-80% מהמכסה החודשית',
             'הופקו ' || v_now || ' מתוך ' || v_limit || ' קובצי PDF החודש. כשהמכסה תתמלא לא יופקו קובצי PDF חדשים עד תחילת החודש הבא; הקישור להצעה, הצפייה והחתימה של הלקוח ממשיכים לעבוד.'
        from public.memberships m
       where m.organization_id = p_org and m.role in ('owner', 'admin') and m.status = 'active';
    end if;
  end if;
  return v_now;
end;
$$;
revoke all on function app.pdf_take(uuid) from public, anon, authenticated, service_role;

-- A quote's PDF: a sent quote whose deal or contact the person may edit, the flag, then the quota. Security definer (it
-- counts in app.pdf_months); a person the write policy refuses gets RLS's plain 42501 first, never this business's quota.
create or replace function app.files_quote_pdf() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_quote public.quotes;
begin
  if new.quote_id is null then
    return new;
  end if;
  select * into v_quote from public.quotes q where q.organization_id = new.organization_id and q.id = new.quote_id;
  if auth.uid() is not null
     and not (found and app.can_write(new.organization_id) and app.org_writable(new.organization_id)
              and v_quote.status in ('sent', 'viewed')
              and app.quote_editable(v_quote.organization_id, v_quote.deal_id, v_quote.contact_id)) then
    return new;
  end if;
  if v_quote.id is null or v_quote.status = 'draft' then
    raise exception 'a draft quote has no PDF' using errcode = 'P0001', hint = 'quote_pdf:draft';
  end if;
  -- review L3: made later only while the quote is still the open offer that was sent (sent or viewed), so a file made
  -- after an answer, an expiry or a cancel is never taken for the version that was sent
  if v_quote.status not in ('sent', 'viewed') then
    raise exception 'a quote''s PDF is made while it is sent or viewed' using errcode = 'P0001', hint = 'quote_pdf:closed';
  end if;
  if not app.org_has_feature(new.organization_id, 'quotes') then
    raise exception 'quotes are not in the plan' using errcode = 'P0001', hint = 'feature:quotes';
  end if;
  perform app.pdf_take(new.organization_id);
  return new;
end;
$$;
revoke all on function app.files_quote_pdf() from public, anon, authenticated;

-- named to run after files_before_insert, files_field_check and files_links_check, so a row they refuse is never counted
create or replace trigger files_quote_pdf before insert on public.files
  for each row when (new.quote_id is not null) execute function app.files_quote_pdf();

-- ----------------------------------------------------------------------------
-- Review M2: the quota counts files made, not attempts. A waiting row (its upload never arrived, or the object was refused)
-- that its uploader or an owner/admin removes gives its count back to the month it was counted in.
-- ----------------------------------------------------------------------------
create or replace function app.files_quote_pdf_return() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if old.quote_id is not null and old.unconfirmed_since is not null then
    update app.pdf_months m
       set produced = greatest(m.produced - 1, 0)
     where m.organization_id = old.organization_id
       and m.month = date_trunc('month', old.created_at at time zone coalesce(
             (select nullif(o.timezone, '') from public.organizations o where o.id = old.organization_id), 'Asia/Jerusalem'))::date;
  end if;
  return old;
end;
$$;
revoke all on function app.files_quote_pdf_return() from public, anon, authenticated;

create or replace trigger files_quote_pdf_return after delete on public.files
  for each row when (old.quote_id is not null) execute function app.files_quote_pdf_return();

-- ----------------------------------------------------------------------------
-- Review L2: the real object of a quote's PDF must be a PDF, answered as {ok:false, reason:'type'} like a document's
-- (the bodies of 020645 with the quote lines added)
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
  -- QUO-06 (review L2): a quote's PDF must really be a PDF; answered, never raised (files_quote_pdf_shape)
  if v_problem is null and v_file.quote_id is not null and v_obj.mimetype is distinct from 'application/pdf' then
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
    select f.organization_id, f.id, f.storage_path, f.accounting_document_id, f.payment_id, f.quote_id
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
-- Review H1: a privacy erasure removes the stored PDF of the erased customer's detached quotes (lead's choice until the
-- owner answers; DECISIONS.md, QUO-06). The removal holds the only row removal, so it lives in
-- 20261006020960_quote_pdf_erase (pasted by hand in the SQL Editor). Here a no-op, made only while the function does not
-- exist yet, so running this file again never undoes the pasted body.
-- ----------------------------------------------------------------------------
do $do$
begin
  if to_regprocedure('app.quote_pdf_drop(uuid, uuid[])') is null then
    execute $f$
      create function app.quote_pdf_drop(p_org uuid, p_quotes uuid[]) returns void
      language plpgsql security definer
      set search_path = ''
      as $b$
      begin
        -- 20261006020960 removes the PDF files rows of these quotes (their objects go to the orphan cleanup)
        null;
      end;
      $b$
    $f$;
  end if;
end;
$do$;
revoke all on function app.quote_pdf_drop(uuid, uuid[]) from public, anon, authenticated;

-- Privacy erasure: 020815's app.audit_erase_core, plus the call above where the detached quotes are cleaned
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
                       else nullif(regexp_replace(n.body, '( · )?סיבה: .*$', ''), '') end
     where n.organization_id = p_org and n.entity_type = 'quote'
       and n.entity_id = any (select substr(c, length('quotes:') + 1)::uuid from unnest(v_children) c where c like 'quotes:%')
       and (n.type = 'quote_viewed' or (n.type = 'quote' and (n.title like '%: %' or n.body like '%סיבה: %')));
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
  if p_type in ('contacts', 'deals') then
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
    perform set_config('app.document_server', '', true);
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

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, p_actor, 'erase', p_type, p_id, jsonb_build_object('entries', v_count));
  return v_count;
end;
$$;
revoke all on function app.audit_erase_core(uuid, text, uuid, uuid) from public, anon, authenticated;