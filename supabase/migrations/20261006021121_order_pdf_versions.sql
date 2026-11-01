-- =============================================================================
-- ORD-05 PDF versions (owner, 1 November 2026, answer (34) ב): a change to a numbered order's delivery date, shipping address
-- or notes makes a new order PDF; the previous one is kept as a version for staff, and the customer gets the latest
-- =============================================================================
-- * orders.pdf_content_changed_at (server only: no client grant; readers of the order see it): stamped by trigger
--   orders_zz_pdf_content when a numbered order's delivery_date, shipping_address or notes change; every other write keeps it.
-- * A file's newer version is the REC-07 chain (files.previous_id, files_one_newer: one newer version per file). An order's
--   files are one line: files_order_pdf_root (021119) allows one first file per order, files_one_newer one newer per file, and
--   trigger files_order_pdf now checks that a new order file names as its earlier version exactly the order's current
--   confirmed file (hint order_pdf:version). files_order_pdf_shape allows previous_id.
-- * public.order_pdf_store (021119's, service_role only): when the order's current file is confirmed and the order's content
--   changed after it was made, the call makes a new version after it (the same checks, the same quota through
--   files_order_pdf / app.pdf_take, the same upload/stored/busy and takeover); otherwise it answers the current file as before.
-- * public.order_public_pdf (021119's): serves the newest confirmed, fingerprinted version.
-- Staff read every version (files_select follows the order). Every statement is safe to run twice. No drops, no row removal.

alter table public.orders add column if not exists pdf_content_changed_at timestamptz;

create or replace function app.orders_pdf_content() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.pdf_content_changed_at := null;
    return new;
  end if;
  if old.status <> 'draft'
     and (new.delivery_date is distinct from old.delivery_date
          or new.shipping_address is distinct from old.shipping_address
          or new.notes is distinct from old.notes) then
    new.pdf_content_changed_at := now();
  else
    new.pdf_content_changed_at := old.pdf_content_changed_at;
  end if;
  return new;
end;
$$;
revoke all on function app.orders_pdf_content() from public, anon, authenticated;

-- named to run after the other BEFORE triggers on orders (orders_zz_owner_transfer included), so it sees the final values
create or replace trigger orders_zz_pdf_content before insert or update on public.orders
  for each row execute function app.orders_pdf_content();

-- an order's file may now name its earlier version
alter table public.files drop constraint if exists files_order_pdf_shape;
alter table public.files add constraint files_order_pdf_shape
  check (order_id is null
         or (activity_id is null and custom_field_key is null and mime_type = 'application/pdf'));

-- ----------------------------------------------------------------------------
-- 021119's app.files_order_pdf, plus the version rule
-- ----------------------------------------------------------------------------
create or replace function app.files_order_pdf() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_prev  public.files;
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
  -- answer (34) ב: a newer version follows the order's current confirmed file, and only it
  if new.previous_id is not null then
    select * into v_prev from public.files f where f.organization_id = new.organization_id and f.id = new.previous_id;
    if v_prev.id is null or v_prev.order_id is distinct from new.order_id or v_prev.unconfirmed_since is not null
       or exists (select 1 from public.files n where n.organization_id = v_prev.organization_id and n.previous_id = v_prev.id) then
      raise exception 'an order''s new PDF follows its current file' using errcode = 'P0001', hint = 'order_pdf:version';
    end if;
  end if;
  if not app.org_has_feature(new.organization_id, 'orders') then
    raise exception 'orders are not in the plan' using errcode = 'P0001', hint = 'feature:orders';
  end if;
  perform app.pdf_take(new.organization_id);
  return new;
end;
$$;
revoke all on function app.files_order_pdf() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 021119's public.order_pdf_store, on the order's current file (the one no other file names as its earlier version), with a
-- new version when the order's content changed after that file was made
-- ----------------------------------------------------------------------------
create or replace function public.order_pdf_store(p_org uuid, p_order uuid, p_user uuid, p_size bigint, p_sha256 text, p_name text,
                                                  p_path text default null)
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
  -- the order's current file: its files are one line (files_order_pdf_root, files_one_newer)
  select * into v_file from public.files f
   where f.organization_id = p_org and f.order_id = p_order
     and not exists (select 1 from public.files n where n.organization_id = f.organization_id and n.previous_id = f.id)
     for update;
  if found and v_file.unconfirmed_since is null
     and not (v_order.pdf_content_changed_at is not null and v_order.pdf_content_changed_at > v_file.created_at) then
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

  if v_file.id is null or v_file.unconfirmed_since is null then
    -- the first file, or (answer (34) ב) a new version after the confirmed current one whose order changed since; the
    -- triggers set the path and no uploader, check the line and take the quota
    insert into public.files (organization_id, order_id, name, mime_type, size_bytes, unconfirmed_since, sha256, previous_id)
    values (p_org, p_order, btrim(p_name), 'application/pdf', p_size, now(), p_sha256, v_file.id)
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
revoke all on function public.order_pdf_store(uuid, uuid, uuid, bigint, text, text, text) from public, anon, authenticated;
grant execute on function public.order_pdf_store(uuid, uuid, uuid, bigint, text, text, text) to service_role;

-- ----------------------------------------------------------------------------
-- 021119's public.order_public_pdf, serving the newest confirmed, fingerprinted version
-- ----------------------------------------------------------------------------
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
  -- answer (34) ב: the newest confirmed version (a newer one still waiting for its object is not served yet)
  select * into v_file from public.files f
   where f.organization_id = v_order.organization_id and f.order_id = v_order.id
     and f.unconfirmed_since is null and f.sha256 is not null
   order by f.created_at desc, f.id desc
   limit 1;
  if not found then
    return jsonb_build_object('unavailable', true);
  end if;
  return jsonb_build_object('path', v_file.storage_path, 'sha256', v_file.sha256, 'name', v_file.name);
end;
$$;
revoke all on function public.order_public_pdf(text, text) from public, anon, authenticated;
grant execute on function public.order_public_pdf(text, text) to service_role;
