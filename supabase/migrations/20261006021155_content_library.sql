-- =============================================================================
-- LIB-01: the content library (owner, 3 November 2026, answer (69) א: every plan, no plan key, inside the storage quota)
-- =============================================================================
-- "ספריית תוכן: קבצים וקישורים שהצוות שולח ללקוחות (קטלוג, מחירון, מצגת, סרטון), עם קטגוריות ותוקף".
--
-- * public.library_categories: a managed list (12 October rule): name 1..60, position, active. Members read; owners and
--   admins of a writable business write; 50 per business (hint library_categories:max); audited. Seeded with five defaults
--   (mirrored by DEFAULT_LIBRARY_CATEGORIES in src/features/library/categories.ts) for new businesses and for existing ones
--   whose list is empty.
-- * public.library_items: one item of the library: a title (1..120), an optional description (1..500), an optional category
--   (composite FK, on delete set null of the column), kind link | file (set on insert, never changed: no update grant), the
--   link's url (link only; https and the rule of QR links, app.qr_target_url_ok = qrTargetUrlOk), valid_from / valid_until
--   (optional business dates, until on or after from; an item out of its window stays, the screens mark it and pickers leave
--   it out), is_active. Members read every item; owners, admins and managers by role of a writable business write
--   (app.library_writable); 1,000 per business (hint library_items:max). Audited.
-- * A file item's file is a public.files row with files.library_item_id (composite FK on delete cascade, so deleting the
--   item deletes the row and files_after_delete queues its object for the nightly orphan cleanup), uploaded through the one
--   upload path (files_before_insert: the waiting mark, the 20 waiting uploads cap and the plan's storage_gb quota;
--   public.confirm_file_upload reads the real object; app.files_storage_used counts it), of the types every file takes.
--   files_one_subject counts nine columns; files_library_shape: never on a note, never a version, never a field file. An
--   item's current file is its newest confirmed row. Replacing never loses the old file (review of LIB-01): the new row
--   waits beside it, and only after confirm_file_upload answered ok does the app remove the item's confirmed rows made
--   before the new one (with the user's session); a refused or failed upload leaves the old file as it was. So no unique
--   index: two writers replacing at once end with the later file. Trigger files_library_check (definer, outsider guard
--   first): the item exists in the business and is of kind file (hint library:file_kind). Reading follows the item (files_select); adding and removing need app.library_writable (files_insert,
--   files_delete: any library writer removes any library file, not only its uploader or an admin). The object in Storage is
--   uploaded under record_files_insert (the uploader's own waiting row, unchanged) and removed by the uploader of a failed
--   upload, or by the orphan cleanup after the row goes. record_files_delete (021119's text) adds that a library file's object
--   is removed only by a library writer (review: a demoted uploader could delete it under the row).
-- Redefined from their latest bodies: the files_select policy (021122), files_insert, files_delete and the storage policy
-- record_files_delete (021119),
-- app.files_before_insert (020645: its outsider guard adds the library's write rule, RVW-23).
-- No sharing page and no service-key use: sending to customers comes with the message providers.
-- Every statement is safe to run twice. No statement starts with drop; no row removal.

-- ----------------------------------------------------------------------------
-- Who writes the library: owners, admins and managers by role, in a writable business
-- ----------------------------------------------------------------------------
create or replace function app.library_writable(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce(app.role_in(p_org)::text in ('owner', 'admin', 'manager'), false) and app.org_writable(p_org)
$$;
revoke all on function app.library_writable(uuid) from public, anon;
grant execute on function app.library_writable(uuid) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Categories (managed list)
-- ----------------------------------------------------------------------------
create table if not exists public.library_categories (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name            text not null check (char_length(name) between 1 and 60 and name = btrim(name)),
  position        integer not null default 0,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id)
);
create unique index if not exists library_categories_name_idx on public.library_categories (organization_id, lower(name));

alter table public.library_categories enable row level security;
revoke all on public.library_categories from anon, authenticated;
grant select, delete on public.library_categories to authenticated;
grant insert (organization_id, name, position, is_active) on public.library_categories to authenticated;
grant update (name, position, is_active) on public.library_categories to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'library_categories' and policyname = 'library_categories_select') then
    create policy library_categories_select on public.library_categories for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'library_categories' and policyname = 'library_categories_insert') then
    create policy library_categories_insert on public.library_categories for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'library_categories' and policyname = 'library_categories_update') then
    create policy library_categories_update on public.library_categories for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'library_categories' and policyname = 'library_categories_delete') then
    create policy library_categories_delete on public.library_categories for delete to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

create or replace trigger library_categories_touch before update on public.library_categories
  for each row execute function app.touch_row();
create or replace trigger library_categories_audit after insert or update or delete on public.library_categories
  for each row execute function app.audit_row();

create or replace function app.library_categories_cap() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- an outsider gets RLS's plain refusal and learns nothing about the business
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('library_categories:' || new.organization_id::text, 0));
  if (select count(*) from public.library_categories c where c.organization_id = new.organization_id) >= 50 then
    raise exception 'too many library categories' using errcode = 'P0001', hint = 'library_categories:max';
  end if;
  return new;
end;
$$;
revoke all on function app.library_categories_cap() from public, anon, authenticated;

create or replace trigger library_categories_cap before insert on public.library_categories
  for each row execute function app.library_categories_cap();

-- Defaults: a business starts with these and renames or deletes them
create or replace function app.seed_library_categories(p_org uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.library_categories (organization_id, name, position)
  select p_org, d.name, d.pos
    from (values ('קטלוגים', 0), ('מחירונים', 1), ('מצגות', 2), ('סרטונים', 3), ('מסמכים כלליים', 4)) as d(name, pos)
   where not exists (select 1 from public.library_categories c where c.organization_id = p_org)
   order by d.pos;
end;
$$;
revoke all on function app.seed_library_categories(uuid) from public, anon, authenticated;

create or replace function app.organizations_seed_library_categories() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform app.seed_library_categories(new.id);
  return null;
end;
$$;
revoke all on function app.organizations_seed_library_categories() from public, anon, authenticated;

create or replace trigger organizations_seed_library_categories after insert on public.organizations
  for each row execute function app.organizations_seed_library_categories();

-- existing businesses whose list is empty (managed lists rule)
select app.seed_library_categories(o.id) from public.organizations o;

-- ----------------------------------------------------------------------------
-- Items
-- ----------------------------------------------------------------------------
create table if not exists public.library_items (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  category_id     uuid,
  kind            text not null check (kind in ('link', 'file')),
  title           text not null check (char_length(title) between 1 and 120 and title = btrim(title)),
  description     text check (description is null or (char_length(description) between 1 and 500 and description = btrim(description))),
  url             text,
  valid_from      date,
  valid_until     date,
  is_active       boolean not null default true,
  created_by      uuid default auth.uid() references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  constraint library_items_category_fk foreign key (organization_id, category_id)
    references public.library_categories (organization_id, id) on delete set null (category_id),
  constraint library_items_shape check ((kind = 'link' and app.qr_target_url_ok(url)) or (kind = 'file' and url is null)),
  constraint library_items_validity check (valid_from is null or valid_until is null or valid_until >= valid_from)
);
create index if not exists library_items_category_idx on public.library_items (organization_id, category_id);

alter table public.library_items enable row level security;
revoke all on public.library_items from anon, authenticated;
grant select, delete on public.library_items to authenticated;
grant insert (organization_id, category_id, kind, title, description, url, valid_from, valid_until, is_active)
  on public.library_items to authenticated;
grant update (category_id, title, description, url, valid_from, valid_until, is_active) on public.library_items to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'library_items' and policyname = 'library_items_select') then
    create policy library_items_select on public.library_items for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'library_items' and policyname = 'library_items_insert') then
    create policy library_items_insert on public.library_items for insert to authenticated
      with check (app.library_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'library_items' and policyname = 'library_items_update') then
    create policy library_items_update on public.library_items for update to authenticated
      using (app.library_writable(organization_id))
      with check (app.library_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'library_items' and policyname = 'library_items_delete') then
    create policy library_items_delete on public.library_items for delete to authenticated
      using (app.library_writable(organization_id));
  end if;
end;
$$;

create or replace trigger library_items_touch before update on public.library_items
  for each row execute function app.touch_row();
create or replace trigger library_items_audit after insert or update or delete on public.library_items
  for each row execute function app.audit_row();

create or replace function app.library_items_cap() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- an outsider gets RLS's plain refusal and learns nothing about the business
  if auth.uid() is not null and not app.library_writable(new.organization_id) then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('library_items:' || new.organization_id::text, 0));
  if (select count(*) from public.library_items i where i.organization_id = new.organization_id) >= 1000 then
    raise exception 'too many library items' using errcode = 'P0001', hint = 'library_items:max';
  end if;
  return new;
end;
$$;
revoke all on function app.library_items_cap() from public, anon, authenticated;

create or replace trigger library_items_cap before insert on public.library_items
  for each row execute function app.library_items_cap();

-- ----------------------------------------------------------------------------
-- The item's file: a files row of its own subject
-- ----------------------------------------------------------------------------
alter table public.files add column if not exists library_item_id uuid;
grant insert (library_item_id) on public.files to authenticated;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'files_library_item_fk') then
    alter table public.files add constraint files_library_item_fk
      foreign key (organization_id, library_item_id) references public.library_items (organization_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'files_library_shape') then
    alter table public.files add constraint files_library_shape
      check (library_item_id is null or (activity_id is null and previous_id is null and custom_field_key is null));
  end if;
end;
$$;

-- one subject each: a record, a document, a payment, a quote, an order or a library item
alter table public.files drop constraint if exists files_one_subject;
alter table public.files add constraint files_one_subject
  check (num_nonnulls(lead_id, contact_id, company_id, deal_id, accounting_document_id, payment_id, quote_id, order_id,
                      library_item_id) = 1);

create index if not exists files_library_item_idx on public.files (organization_id, library_item_id);

create or replace function app.files_library_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- a person who may not write the library gets RLS's plain 42501 right after (files_insert)
  if auth.uid() is not null and not app.library_writable(new.organization_id) then
    return new;
  end if;
  if not exists (select 1 from public.library_items i
                  where i.organization_id = new.organization_id and i.id = new.library_item_id and i.kind = 'file') then
    raise exception 'a library file belongs to a file item' using errcode = 'P0001', hint = 'library:file_kind';
  end if;
  return new;
end;
$$;
revoke all on function app.files_library_check() from public, anon, authenticated;

create or replace trigger files_library_check before insert on public.files
  for each row when (new.library_item_id is not null) execute function app.files_library_check();

-- ----------------------------------------------------------------------------
-- Policies (021122's files_select, 021119's files_insert and files_delete, with the library added)
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
                       -- LIB-01: whoever writes the library, on an item of its business
                       when library_item_id is not null
                       then app.library_writable(organization_id)
                            and exists (select 1 from public.library_items li
                                         where li.organization_id = files.organization_id and li.id = files.library_item_id)
                       else app.can_read_activity_subject(lead_id, contact_id, company_id, deal_id)
                            and (activity_id is null
                                 or exists (select 1 from public.activities a
                                             where a.organization_id = files.organization_id and a.id = files.activity_id))
                  end);

alter policy files_delete on public.files
  using (app.can_write(organization_id)
         and case when library_item_id is not null
                  -- LIB-01: any library writer removes a library file (replacing it); its object goes with the orphan cleanup
                  then app.library_writable(organization_id)
                  else (uploaded_by = (select auth.uid()) or app.is_admin(organization_id))
                       and case when accounting_document_id is not null or payment_id is not null
                                -- never removed (owner); only the uploader's own upload that never arrived goes
                                then unconfirmed_since is not null and uploaded_by = (select auth.uid())
                                -- a quote's or an order's PDF: likewise, and an owner or admin also removes a server row that
                                -- never got its object (it would block the PDF for good); the prefix above already asks for one
                                when quote_id is not null or order_id is not null
                                then unconfirmed_since is not null
                                else app.can_read_activity_subject(lead_id, contact_id, company_id, deal_id)
                                     and (activity_id is null
                                          or exists (select 1 from public.activities a
                                                      where a.organization_id = files.organization_id and a.id = files.activity_id))
                           end
             end);


-- 021119's record_files_delete, plus: a library file's object is removed only by whoever writes the library
alter policy record_files_delete on storage.objects
  using (bucket_id = 'record-files'
         and exists (select 1 from public.files f
                      where f.storage_path = objects.name and app.can_write(f.organization_id)
                        and (f.uploaded_by = (select auth.uid()) or app.is_admin(f.organization_id))
                        and ((f.accounting_document_id is null and f.payment_id is null and f.quote_id is null and f.order_id is null)
                             or (f.unconfirmed_since is not null and f.uploaded_by = (select auth.uid()))
                             or ((f.quote_id is not null or f.order_id is not null) and f.unconfirmed_since is not null
                                 and app.is_admin(f.organization_id)))
                        and (f.custom_field_key is null or not app.field_file_in_use(f.organization_id, f.id))
                        and (f.library_item_id is null or app.library_writable(f.organization_id))));

-- ----------------------------------------------------------------------------
-- 020645's app.files_before_insert; its outsider guard adds the library's write rule (RVW-23: a person the write policy
-- refuses gets RLS's plain 42501, never this business's quota)
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
                   or (app.can_record_payments(new.organization_id) and app.org_writable(new.organization_id)))
              and (new.library_item_id is null or app.library_writable(new.organization_id))) then
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
