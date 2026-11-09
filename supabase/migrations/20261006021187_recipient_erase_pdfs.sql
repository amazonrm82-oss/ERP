-- =============================================================================
-- PKG-06, owner's answer (167) ב (9 November 2026): a service recipient's privacy erasure removes only the payer's quote PDF
-- as sent and the order's PDF; the signed quote PDF stays
-- =============================================================================
-- Until now app.punch_cards_erase (021185) removed the stored PDFs of the payer's quotes and orders whose lines named the
-- erased recipient through app.quote_pdf_drop / app.order_pdf_drop, which remove every files row of the document, the
-- signed quote PDF (QUO-09) included. The signed PDF never prints the recipient (owner (166) א, signed-pdf.ts leaves
-- recipientName out), so it is evidence of the signature and stays.
--
-- * app.recipient_pdf_drop(org, quotes, orders): removes a quote's files rows that are not signed (the PDF as sent) and every
--   files row of an order (all its versions printed the name). Its body, which holds the row removal, is in the pasted
--   20261006021188_recipient_erase_pdfs_delete (the connector does not carry a row removal). Here a placeholder, made only
--   while the function does not exist yet, so running this file again never undoes the pasted body. The placeholder keeps
--   021185's behaviour until 021188 is pasted (review 1): it calls the existing app.quote_pdf_drop / app.order_pdf_drop, which
--   remove every files row of these documents, the signed quote PDF included (function calls only, no row removal here).
--   Its objects go to the orphan cleanup as before (files_after_delete -> app.orphan_files). Removing the as-sent row while a
--   signed one follows it makes the signed row the quote's first file (the REC-07 relink, A_files_relink_versions), which
--   files_quote_pdf_root allows: an accepted quote never makes a PDF as sent again (quote_pdf:closed), so the two never meet.
-- * The name: the erasure now EMPTIES recipient_name (null) on the lines that named the person, instead of 021185's neutral
--   text, so the page (quote_public, order_public: `recipient` null) and the PDF made again (servedForText(null) = nothing)
--   show no "עבור" line at all, as the owner asked ("בלי השורה"). recipient_named_contact_id was already emptied.
--   app.document_line_recipient_name keeps a sent or numbered line's name for every writer, so nothing fills it again (the
--   purge already emptied recipient_contact_id, and the snapshot runs only on draft -> sent / numbering).
-- * Made again (owner (172) ב): only through the staff paths with the person's own session, never by itself and never from
--   the customer's route (the page and the download serve what is stored; no new service-key use). The PDF button and the
--   app's own store calls on the staff screens ask public.quote_pdf_allowed / public.order_pdf_allowed as before; for a quote
--   that is accepted, declined, expired or cancelled, public.quote_pdf_recipient_remake_allowed (the same rule without the
--   status) lets the PDF as sent be made again, and public.quote_pdf_store / files_quote_pdf let it through quote_pdf:closed
--   only while the quote has a credit not used yet (its PDF as sent was removed by this erasure) and its customer is not
--   erased; never otherwise. When the quote keeps its signed PDF, the PDF as sent made again follows it as its newer file
--   (files_quote_pdf_root keeps one first file); the signed PDF is untouched and is still what the customer downloads. A
--   cancelled order is not made again (order_pdf:closed, unchanged). Every PDF made again with a credit carries the footer
--   "נוצר מחדש ב-<date> מהנתונים השמורים" (021015's remadeNote, the app asks public.recipient_pdf_remake_pending), and its
--   confirmation writes one audit entry pdf_remake (entity files, recipient_erasure and the size only; trigger
--   files_recipient_remake_audit). Path rules, SHA-256, the waiting mark and the confirmation are unchanged.
--   Second review M1 (lead's choice until owner question 175): an accepted quote's remade file is rendered from the stored
--   data as it is now, so when the customer's choice changed the quote (optional lines, a different accepted total) the app
--   renders the accepted state with the accepted wording, the footer adds ", לפי מה שאושר", and the staff screen names the
--   file "הורדת PDF (כפי שאושר)" (public.recipient_pdf_remade tells it the file is such a remake).
-- * Quota (021015's rule for a remake: made again from the stored data, never counted in max_pdf_per_month): the erasure
--   writes one credit per document whose confirmed file the removal really took (judged after it, for both bodies of
--   app.recipient_pdf_drop; a signed PDF is never a reason for a credit) into app.recipient_pdf_credits (no grants; cascades with the
--   quote or the order); the next PDF as sent of that quote, or the next PDF of that order, uses it instead of app.pdf_take
--   (no count, no rate, no 80% notice). A waiting row made with a credit that is removed before it is confirmed gives the
--   credit back instead of a count (files_quote_pdf_return / files_order_pdf_return). A signed PDF never uses a credit. Each
--   later erasure that removes the remade file grants it again; a credit a still-waiting file holds is left as it is (review
--   4: its removal gives it back). A credit not used stays (one row per document).
-- * A render started before the erasure (review 5): for an order, the erasure stamps orders.pdf_content_changed_at of the
--   affected orders (app.orders_pdf_content takes a server stamp while the transaction-local setting app.order_pdf_restamp
--   names the business), so a render that read the old stamp answers `changed` and stores nothing. For a quote there is no such
--   stamp: a render that read the name before the erasure and stores after it can keep the name in that one PDF until the
--   next erasure or remake. Accepted (rare: the render and the erasure must overlap within seconds).
--
-- Redefined from their latest bodies: app.files_quote_pdf (021122), app.files_order_pdf (021121),
-- app.files_quote_pdf_return (020955), app.files_order_pdf_return (021119), app.orders_pdf_content (021121),
-- public.quote_pdf_store (021122) and app.punch_cards_erase (021185).
-- app.quote_pdf_drop / app.order_pdf_drop (the erased customer's own detached documents, signed PDF included) are unchanged.
-- Every statement is safe to run twice. No drop statement and no row removal in this file.

create table if not exists app.recipient_pdf_credits (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  quote_id        uuid,
  order_id        uuid,
  granted_at      timestamptz not null default now(),
  -- set when the PDF made again took it (that files row); cleared when that row is removed while still waiting
  used_at         timestamptz,
  used_file_id    uuid,
  constraint recipient_pdf_credits_one_document check ((quote_id is null) <> (order_id is null)),
  constraint recipient_pdf_credits_quote_fk foreign key (organization_id, quote_id)
    references public.quotes (organization_id, id) on delete cascade,
  constraint recipient_pdf_credits_order_fk foreign key (organization_id, order_id)
    references public.orders (organization_id, id) on delete cascade
);
create unique index if not exists recipient_pdf_credits_quote_idx on app.recipient_pdf_credits (organization_id, quote_id)
  where quote_id is not null;
create unique index if not exists recipient_pdf_credits_order_idx on app.recipient_pdf_credits (organization_id, order_id)
  where order_id is not null;
create index if not exists recipient_pdf_credits_file_idx on app.recipient_pdf_credits (organization_id, used_file_id)
  where used_file_id is not null;
alter table app.recipient_pdf_credits enable row level security;
revoke all on app.recipient_pdf_credits from public, anon, authenticated, service_role;

-- The PDF a files row is about to be made of takes the document's credit, once (true = taken, do not count it)
create or replace function app.recipient_pdf_credit_use(p_org uuid, p_quote uuid, p_order uuid, p_file uuid) returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if p_org is null or p_file is null or (p_quote is null and p_order is null) then
    return false;
  end if;
  update app.recipient_pdf_credits c
     set used_at = now(), used_file_id = p_file
   where c.organization_id = p_org and c.used_at is null
     and ((p_quote is not null and c.quote_id = p_quote) or (p_order is not null and c.order_id = p_order));
  return found;
end;
$$;
revoke all on function app.recipient_pdf_credit_use(uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- A waiting row that took a credit is removed: the credit comes back (true = it was a credit, give no count back)
create or replace function app.recipient_pdf_credit_return(p_org uuid, p_file uuid) returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if p_org is null or p_file is null then
    return false;
  end if;
  update app.recipient_pdf_credits c
     set used_at = null, used_file_id = null
   where c.organization_id = p_org and c.used_file_id = p_file;
  return found;
end;
$$;
revoke all on function app.recipient_pdf_credit_return(uuid, uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Owner (172) ב: the PDF of a document whose file this erasure removed is made again by the staff paths, whatever the
-- quote's status, with the footer "נוצר מחדש ... מהנתונים השמורים". A credit not used yet is the marker.
-- ----------------------------------------------------------------------------
-- the server's read (definer callers and triggers only; no grants): the document has a credit not used yet
create or replace function app.recipient_pdf_credit_open(p_org uuid, p_quote uuid, p_order uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_org is not null and (p_quote is not null or p_order is not null)
     and exists (select 1 from app.recipient_pdf_credits c
                  where c.organization_id = p_org and c.used_at is null
                    and ((p_quote is not null and c.quote_id = p_quote) or (p_order is not null and c.order_id = p_order)))
$$;
revoke all on function app.recipient_pdf_credit_open(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- the server's read: this files row is the one a credit was used for (a remake still waiting, or made)
create or replace function app.recipient_pdf_credit_holds(p_org uuid, p_file uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from app.recipient_pdf_credits c where c.organization_id = p_org and c.used_file_id = p_file)
$$;
revoke all on function app.recipient_pdf_credit_holds(uuid, uuid) from public, anon, authenticated, service_role;

-- a member's question about one document of their business (a boolean), for the invoker functions below
create or replace function app.recipient_pdf_remake_pending(p_org uuid, p_quote uuid, p_order uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select app.is_member(p_org) and app.recipient_pdf_credit_open(p_org, p_quote, p_order)
$$;
revoke all on function app.recipient_pdf_remake_pending(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function app.recipient_pdf_remake_pending(uuid, uuid, uuid) to authenticated;

-- With the person's own session: is the next PDF of this quote or order (one the caller reads) a remake after a recipient's
-- erasure? The app prints the footer then.
create or replace function public.recipient_pdf_remake_pending(p_org uuid, p_quote uuid default null, p_order uuid default null)
returns boolean
language sql stable security invoker
set search_path = ''
as $$
  select case
           when p_quote is not null then
             exists (select 1 from public.quotes q where q.organization_id = p_org and q.id = p_quote)
             and app.recipient_pdf_remake_pending(p_org, p_quote, null)
           when p_order is not null then
             exists (select 1 from public.orders o where o.organization_id = p_org and o.id = p_order)
             and app.recipient_pdf_remake_pending(p_org, null, p_order)
           else false
         end
$$;
revoke all on function public.recipient_pdf_remake_pending(uuid, uuid, uuid) from public, anon;
grant execute on function public.recipient_pdf_remake_pending(uuid, uuid, uuid) to authenticated;

-- With the person's own session: is this stored file (one the caller reads) a PDF made again after a recipient's erasure?
-- The staff screen names an accepted quote's remade file by what it shows (second review M1).
create or replace function app.recipient_pdf_remade_check(p_org uuid, p_file uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select app.is_member(p_org) and app.recipient_pdf_credit_holds(p_org, p_file)
$$;
revoke all on function app.recipient_pdf_remade_check(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function app.recipient_pdf_remade_check(uuid, uuid) to authenticated;

create or replace function public.recipient_pdf_remade(p_org uuid, p_file uuid) returns boolean
language sql stable security invoker
set search_path = ''
as $$
  select exists (select 1 from public.files f where f.organization_id = p_org and f.id = p_file)
     and app.recipient_pdf_remade_check(p_org, p_file)
$$;
revoke all on function public.recipient_pdf_remade(uuid, uuid) from public, anon;
grant execute on function public.recipient_pdf_remade(uuid, uuid) to authenticated;

-- With the person's own session: may this person have the PDF as sent of a quote that is no longer sent or viewed made again
-- after a recipient's erasure? public.quote_pdf_allowed's rule without the status (keep in step), the customer not erased,
-- and a credit not used yet. public.quote_pdf_store checks the user again (app.quote_pdf_user_may) and the same marker.
create or replace function public.quote_pdf_recipient_remake_allowed(p_org uuid, p_quote uuid) returns boolean
language sql stable security invoker
set search_path = ''
as $$
  select exists (
    select 1 from public.quotes q
     where q.organization_id = p_org and q.id = p_quote
       and q.status <> 'draft'
       and q.customer_deleted_at is null
       and app.can_write(q.organization_id)
       and app.org_writable(q.organization_id)
       and app.org_has_feature(q.organization_id, 'quotes')
       and app.quote_editable(q.organization_id, q.deal_id, q.contact_id))
     and app.recipient_pdf_remake_pending(p_org, p_quote, null)
$$;
revoke all on function public.quote_pdf_recipient_remake_allowed(uuid, uuid) from public, anon;
grant execute on function public.quote_pdf_recipient_remake_allowed(uuid, uuid) to authenticated;

-- One audit entry per PDF made again (action pdf_remake, entity files, as 021015; no name, sizes only), when it is confirmed
create or replace function app.files_recipient_remake_audit() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if old.unconfirmed_since is not null and new.unconfirmed_since is null
     and exists (select 1 from app.recipient_pdf_credits c where c.organization_id = new.organization_id and c.used_file_id = new.id) then
    insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
    values (new.organization_id, null, 'pdf_remake', 'files', new.id,
            jsonb_build_object('recipient_erasure', true, 'new_size', new.size_bytes));
  end if;
  return null;
end;
$$;
revoke all on function app.files_recipient_remake_audit() from public, anon, authenticated, service_role;

create or replace trigger files_recipient_remake_audit after update of unconfirmed_since on public.files
  for each row when (old.unconfirmed_since is not null and new.unconfirmed_since is null and (new.quote_id is not null or new.order_id is not null))
  execute function app.files_recipient_remake_audit();

-- ----------------------------------------------------------------------------
-- 021122's public.quote_pdf_store, with the recipient remake (above)
-- ----------------------------------------------------------------------------
create or replace function public.quote_pdf_store(p_org uuid, p_quote uuid, p_user uuid, p_size bigint, p_sha256 text, p_name text,
                                                  p_path text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_quote public.quotes;
  v_file  public.files;
  v_obj   record;
  v_path  text;
begin
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' or p_size is null or p_size < 1 or p_size > 26214400
     or coalesce(btrim(p_name), '') = '' or char_length(p_name) > 200 or p_name ~ '[/\\]' or lower(p_name) !~ '\.pdf$' then
    raise exception 'invalid PDF details' using errcode = '22023', hint = 'quote_pdf:invalid';
  end if;
  select * into v_quote from public.quotes q where q.organization_id = p_org and q.id = p_quote;
  if not found or not app.quote_pdf_user_may(p_org, p_user, v_quote.deal_id, v_quote.contact_id) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  -- one render at a time per quote
  perform pg_advisory_xact_lock(hashtextextended('quote_pdf:' || p_quote::text, 0));
  -- QUO-09: the PDF as sent (a signed version after it is written by app.quote_signed_pdf_write only)
  select * into v_file from public.files f
   where f.organization_id = p_org and f.quote_id = p_quote and f.quote_signed is null
     for update;
  if found and v_file.unconfirmed_since is null then
    -- QUO-06 follow-up (owner, 26 October 2026, answer 1 (ג)): a PDF kept before the fingerprint existed is made again by
    -- the server, once (app.quote_pdf_remake); never counted in the quota (no new row, so files_quote_pdf never fires)
    if v_file.sha256 is null then
      return app.quote_pdf_remake(v_quote, v_file, p_user, p_size, p_sha256, btrim(p_name), p_path);
    end if;
    -- a stale render that uploaded to its own path: that object is not the file
    if p_path is distinct from v_file.storage_path then
      perform app.quote_pdf_abandon(p_org, p_path);
    end if;
    return jsonb_build_object('status', 'stored', 'file_id', v_file.id);
  end if;
  if v_quote.status = 'draft' then
    raise exception 'a draft quote has no PDF' using errcode = 'P0001', hint = 'quote_pdf:draft';
  end if;
  -- 021187 (owner (172) ב): a quote whose PDF as sent a service recipient's erasure removed is made again whatever its status
  if v_quote.status not in ('sent', 'viewed')
     and not (v_quote.customer_deleted_at is null
              and (app.recipient_pdf_credit_open(p_org, p_quote, null)
                   -- the second call of the remake: its waiting row holds the credit
                   or (v_file.id is not null and app.recipient_pdf_credit_holds(p_org, v_file.id)))) then
    raise exception 'a quote''s PDF is made while it is sent or viewed' using errcode = 'P0001', hint = 'quote_pdf:closed';
  end if;
  if not app.org_has_feature(p_org, 'quotes') then
    raise exception 'quotes are not in the plan' using errcode = 'P0001', hint = 'feature:quotes';
  end if;

  if v_file.id is null then
    -- files_before_insert sets the path (`<org>/<file id>`, this attempt's own) and no uploader (no session);
    -- files_quote_pdf takes the quota and the rate
    -- 021187: after a recipient's erasure the quote's signed PDF (when kept) is its first file; the PDF as sent made again
    -- follows it (files_quote_pdf_root holds one first file per quote)
    insert into public.files (organization_id, quote_id, name, mime_type, size_bytes, unconfirmed_since, sha256, previous_id)
    values (p_org, p_quote, btrim(p_name), 'application/pdf', p_size, now(), p_sha256,
            (select f.id from public.files f
              where f.organization_id = p_org and f.quote_id = p_quote and f.quote_signed
                and app.recipient_pdf_credit_open(p_org, p_quote, null)))
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
    -- after two minutes without its object the row is taken over (an earlier session's waiting row, from before this
    -- change, is taken over the same way and loses its uploader)
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
revoke all on function public.quote_pdf_store(uuid, uuid, uuid, bigint, text, text, text) from public, anon, authenticated;
grant execute on function public.quote_pdf_store(uuid, uuid, uuid, bigint, text, text, text) to service_role;

-- ----------------------------------------------------------------------------
-- The removal (body in the pasted 20261006021188). Here a no-op, made only while the function does not exist yet.
-- ----------------------------------------------------------------------------
do $do$
begin
  if to_regprocedure('app.recipient_pdf_drop(uuid, uuid[], uuid[])') is null then
    execute $f$
      create function app.recipient_pdf_drop(p_org uuid, p_quotes uuid[], p_orders uuid[]) returns void
      language plpgsql security definer
      set search_path = ''
      as $b$
      begin
        -- until 20261006021188 is pasted: 021185's behaviour (every files row of these documents, the signed PDF included);
        -- 021188 then removes the quotes' PDF as sent only (never the signed one) and the orders' files rows
        if p_org is null then
          return;
        end if;
        perform app.quote_pdf_drop(p_org, coalesce(p_quotes, '{}'::uuid[]));
        perform app.order_pdf_drop(p_org, coalesce(p_orders, '{}'::uuid[]));
      end;
      $b$
    $f$;
  end if;
end;
$do$;
revoke all on function app.recipient_pdf_drop(uuid, uuid[], uuid[]) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 021122's app.files_quote_pdf, plus the credit for a PDF as sent made again after a recipient's erasure
-- ----------------------------------------------------------------------------
create or replace function app.files_quote_pdf() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_quote public.quotes;
  v_sent  public.files;
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
  if coalesce(new.quote_signed, false) then
    -- QUO-09 (answer (33) ב): the signed PDF of an accepted quote whose acceptance was not erased
    if v_quote.status <> 'accepted' or v_quote.customer_deleted_at is not null
       or not exists (select 1 from public.quote_decisions d
                       where d.organization_id = v_quote.organization_id and d.quote_id = v_quote.id
                         and d.decision = 'accepted' and d.erased_at is null) then
      raise exception 'a signed PDF is made for an accepted quote' using errcode = 'P0001', hint = 'quote_pdf:not_accepted';
    end if;
    -- it follows the quote's as-sent file when there is one (else it is the first file)
    select * into v_sent from public.files f
     where f.organization_id = new.organization_id and f.quote_id = new.quote_id and f.quote_signed is null;
    if new.previous_id is distinct from v_sent.id then
      raise exception 'a signed PDF follows the quote''s PDF as sent' using errcode = 'P0001', hint = 'quote_pdf:version';
    end if;
  else
    -- a PDF as sent is never a version, but (021187, owner (172) ב) one made again after a recipient's erasure follows the
    -- quote's signed PDF, which that erasure left as the first file
    if new.previous_id is not null
       and not (app.recipient_pdf_credit_open(new.organization_id, new.quote_id, null)
                and exists (select 1 from public.files f
                             where f.organization_id = new.organization_id and f.id = new.previous_id
                               and f.quote_id = new.quote_id and f.quote_signed)) then
      raise exception 'a quote''s PDF as sent is its first file' using errcode = 'P0001', hint = 'quote_pdf:version';
    end if;
    -- review L3: made later only while the quote is still the open offer that was sent (sent or viewed), so a file made
    -- after an answer, an expiry or a cancel is never taken for the version that was sent; 021187: except the remake after a
    -- service recipient's erasure (a credit not used yet, the customer not erased)
    if v_quote.status not in ('sent', 'viewed')
       and not (v_quote.customer_deleted_at is null and app.recipient_pdf_credit_open(new.organization_id, new.quote_id, null)) then
      raise exception 'a quote''s PDF is made while it is sent or viewed' using errcode = 'P0001', hint = 'quote_pdf:closed';
    end if;
  end if;
  if not app.org_has_feature(new.organization_id, 'quotes') then
    raise exception 'quotes are not in the plan' using errcode = 'P0001', hint = 'feature:quotes';
  end if;
  -- 021187 (owner (167) ב): the PDF as sent made again after a service recipient's erasure is not counted (021015's rule)
  if not coalesce(new.quote_signed, false)
     and app.recipient_pdf_credit_use(new.organization_id, new.quote_id, null, new.id) then
    return new;
  end if;
  perform app.pdf_take(new.organization_id);
  return new;
end;
$$;
revoke all on function app.files_quote_pdf() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 021121's app.files_order_pdf, plus the credit
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
  -- 021187 (owner (167) ב): the PDF made again after a service recipient's erasure is not counted (021015's rule)
  if app.recipient_pdf_credit_use(new.organization_id, null, new.order_id, new.id) then
    return new;
  end if;
  perform app.pdf_take(new.organization_id);
  return new;
end;
$$;
revoke all on function app.files_order_pdf() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 020955's / 021119's count return, plus the credit: a waiting row that took a credit gives the credit back, not a count
-- ----------------------------------------------------------------------------
create or replace function app.files_quote_pdf_return() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if old.quote_id is not null and old.unconfirmed_since is not null then
    if app.recipient_pdf_credit_return(old.organization_id, old.id) then
      return old;
    end if;
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

create or replace function app.files_order_pdf_return() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if old.order_id is not null and old.unconfirmed_since is not null then
    if app.recipient_pdf_credit_return(old.organization_id, old.id) then
      return old;
    end if;
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

-- ----------------------------------------------------------------------------
-- 021121's app.orders_pdf_content, plus the erasure's stamp (review 5): a render that read the content before the erasure
-- is refused as `changed` by public.order_pdf_store
-- ----------------------------------------------------------------------------
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
          or new.notes is distinct from old.notes
          -- 021187: app.punch_cards_erase, for the orders whose lines named the erased recipient
          or coalesce(current_setting('app.order_pdf_restamp', true), '') = new.organization_id::text) then
    new.pdf_content_changed_at := now();
  else
    new.pdf_content_changed_at := old.pdf_content_changed_at;
  end if;
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- app.punch_cards_erase: the body of 021185, with the name emptied (no "עבור" line) and only the PDF as sent and the
-- order's PDF removed, with a credit for the PDF made again
-- ----------------------------------------------------------------------------
create or replace function app.punch_cards_erase(p_org uuid, p_contact uuid, p_children text[]) returns text[]
language plpgsql security definer
set search_path = ''
as $$
declare
  v_card record;
  v_periods tstzrange[];
  v_unknown boolean;
  v_zero constant text := '00000000-0000-0000-0000-000000000000';
  v_gone text[];
  v_more text[] := '{}';
  v_lines uuid[] := '{}';
  v_quotes uuid[] := '{}';
  v_orders uuid[] := '{}';
  v_before text;
  v_order_before text;
  v_qf uuid[];
  v_qd uuid[];
  v_of uuid[];
  v_od uuid[];
  v_restamp_before text;
begin
  for v_card in
    select c.id, c.created_at, c.cancelled_at, c.holder_history from public.punch_cards c
     where c.organization_id = p_org and p_contact = any (c.former_contact_ids)
     order by c.id
     for update
  loop
    v_periods := app.punch_card_holder_periods(v_card.created_at, v_card.holder_history, p_contact);
    v_unknown := cardinality(v_periods) = 0;
    update public.punch_cards c
       set cancel_reason = case when c.cancel_reason is not null
                                 and (v_unknown or app.punch_card_in_periods(c.cancelled_at, v_periods))
                                then 'הסיבה נמחקה (מחיקת פרטיות)' else c.cancel_reason end,
           former_contact_ids = array_remove(c.former_contact_ids, p_contact),
           holder_history = (select coalesce(jsonb_agg(case when x.e ->> 'contact' = p_contact::text then x.e - 'contact' else x.e end
                                                       order by x.o), '[]'::jsonb)
                               from jsonb_array_elements(c.holder_history) with ordinality as x(e, o))
     where c.organization_id = p_org and c.id = v_card.id;
    update public.punch_card_uses u set return_reason = 'הנימוק נמחק (מחיקת פרטיות)'
     where u.organization_id = p_org and u.card_id = v_card.id and u.return_reason is not null
       and (v_unknown or app.punch_card_in_periods(u.returned_at, v_periods));
    if not v_unknown then
      update public.audit_log a set changes = '{"erased": true}'::jsonb
       where a.organization_id = p_org and a.action <> 'erase' and a.changes is distinct from '{"erased": true}'::jsonb
         and app.punch_card_in_periods(a.created_at, v_periods)
         and ((a.entity_type = 'punch_cards' and a.entity_id = v_card.id)
              or (a.entity_type = 'punch_card_uses'
                  and a.entity_id in (select u.id from public.punch_card_uses u where u.organization_id = p_org and u.card_id = v_card.id)));
    end if;
    update public.audit_log a set changes = replace(a.changes::text, p_contact::text, v_zero)::jsonb
     where a.organization_id = p_org and a.action <> 'erase' and strpos(a.changes::text, p_contact::text) > 0
       and ((a.entity_type = 'punch_cards' and a.entity_id = v_card.id)
            or (a.entity_type = 'punch_card_uses'
                and a.entity_id in (select u.id from public.punch_card_uses u where u.organization_id = p_org and u.card_id = v_card.id)));
    -- the log entries this erasure just wrote keep the old reasons: they go too
    update public.audit_log a set changes = '{"erased": true}'::jsonb
     where a.organization_id = p_org and a.created_at = now() and a.action = 'update'
       and (a.changes ? 'cancel_reason' or a.changes ? 'return_reason')
       and ((a.entity_type = 'punch_cards' and a.entity_id = v_card.id)
            or (a.entity_type = 'punch_card_uses'
                and a.entity_id in (select u.id from public.punch_card_uses u where u.organization_id = p_org and u.card_id = v_card.id)));
  end loop;
  -- PKG-06: the person's name as sent on the lines of other customers' documents that named them as the service recipient
  -- (found by the id the snapshot was taken from; the foreign key emptied recipient_contact_id at the purge) is emptied
  -- (owner (167) ב: the page and the PDF made again show no "עבור" line), and the log entries that carried the name lose it
  v_before := coalesce(current_setting('app.recipient_name_server', true), '');
  v_order_before := coalesce(current_setting('app.order_server', true), '');
  perform set_config('app.recipient_name_server', 'on', true);
  perform set_config('app.order_server', 'on', true);
  with q as (
    update public.quote_lines l set recipient_name = null, recipient_named_contact_id = null
     where l.organization_id = p_org and l.recipient_named_contact_id = p_contact
    returning l.id, l.quote_id)
  select coalesce(array_agg(q.id), '{}'), coalesce(array_agg(distinct q.quote_id), '{}') into v_lines, v_quotes from q;
  with o as (
    update public.order_lines l set recipient_name = null, recipient_named_contact_id = null
     where l.organization_id = p_org and l.recipient_named_contact_id = p_contact
    returning l.id, l.order_id)
  select v_lines || coalesce(array_agg(o.id), '{}'), coalesce(array_agg(distinct o.order_id), '{}') into v_lines, v_orders from o;
  perform set_config('app.recipient_name_server', v_before, true);
  perform set_config('app.order_server', v_order_before, true);
  -- the lines whose log names the person as the contact a name was taken from (deleted draft lines included)
  v_lines := v_lines || array(select distinct a.entity_id from public.audit_log a
                               where a.organization_id = p_org and a.entity_type in ('quote_lines', 'order_lines')
                                 and a.entity_id is not null and a.changes ? 'recipient_named_contact_id'
                                 and (a.changes ->> 'recipient_named_contact_id' = p_contact::text
                                      or a.changes -> 'recipient_named_contact_id' ->> 'old' = p_contact::text
                                      or a.changes -> 'recipient_named_contact_id' ->> 'new' = p_contact::text));
  update public.audit_log a set changes = jsonb_set(a.changes, '{recipient_name}', '{"erased": true}'::jsonb)
   where a.organization_id = p_org and a.entity_type in ('quote_lines', 'order_lines') and a.action <> 'erase'
     and a.changes ? 'recipient_name' and a.changes -> 'recipient_name' is distinct from '{"erased": true}'::jsonb
     and a.entity_id = any (v_lines);
  -- owner (167) ב: the stored PDF as sent of the payer's quotes and the PDF of the payer's orders that printed the name go
  -- (app.recipient_pdf_drop, the pasted 021188); the signed quote PDF, which never prints it, stays. The PDF made again from
  -- the emptied data is not counted in the quota: one credit per document that loses a confirmed file.
  -- the confirmed files that may go (a quote's PDF as sent, an order's files), judged again after the removal
  select coalesce(array_agg(f.id order by f.id), '{}'), coalesce(array_agg(f.quote_id order by f.id), '{}') into v_qf, v_qd
    from public.files f
   where f.organization_id = p_org and f.quote_id = any (v_quotes) and f.quote_signed is null and f.unconfirmed_since is null;
  select coalesce(array_agg(f.id order by f.id), '{}'), coalesce(array_agg(f.order_id order by f.id), '{}') into v_of, v_od
    from public.files f
   where f.organization_id = p_org and f.order_id = any (v_orders) and f.unconfirmed_since is null;
  perform set_config('app.order_server', 'on', true);
  -- review 5: a render of these orders that read the old content stamp is refused as `changed`
  if cardinality(v_orders) > 0 then
    v_restamp_before := coalesce(current_setting('app.order_pdf_restamp', true), '');
    perform set_config('app.order_pdf_restamp', p_org::text, true);
    update public.orders o set pdf_content_changed_at = now()
     where o.organization_id = p_org and o.id = any (v_orders) and o.status <> 'draft';
    perform set_config('app.order_pdf_restamp', v_restamp_before, true);
  end if;
  perform app.recipient_pdf_drop(p_org, v_quotes, v_orders);
  perform set_config('app.order_server', v_order_before, true);
  -- a credit only for a document whose confirmed file the removal really took; a credit a still-waiting file holds stays
  insert into app.recipient_pdf_credits as c (organization_id, quote_id)
  select distinct p_org, x.doc from unnest(v_qf, v_qd) as x(file_id, doc)
   where not exists (select 1 from public.files f where f.organization_id = p_org and f.id = x.file_id)
  on conflict (organization_id, quote_id) where quote_id is not null
  do update set granted_at = now(), used_at = null, used_file_id = null
   where not exists (select 1 from public.files f
                      where f.organization_id = c.organization_id and f.id = c.used_file_id and f.unconfirmed_since is not null);
  insert into app.recipient_pdf_credits as c (organization_id, order_id)
  select distinct p_org, x.doc from unnest(v_of, v_od) as x(file_id, doc)
   where not exists (select 1 from public.files f where f.organization_id = p_org and f.id = x.file_id)
  on conflict (organization_id, order_id) where order_id is not null
  do update set granted_at = now(), used_at = null, used_file_id = null
   where not exists (select 1 from public.files f
                      where f.organization_id = c.organization_id and f.id = c.used_file_id and f.unconfirmed_since is not null);
  -- PKG-06: the person's id leaves the log entries of the cards they paid for and of the document lines that named them
  -- as the service recipient (the foreign keys emptied the columns when the person was purged)
  update public.audit_log a set changes = replace(a.changes::text, p_contact::text, v_zero)::jsonb
   where a.organization_id = p_org and a.entity_type in ('punch_cards', 'quote_lines', 'order_lines')
     and a.action <> 'erase' and strpos(a.changes::text, p_contact::text) > 0;
  -- the used entries of the person's gone cards (their delete entries carry card_id)
  v_gone := array(select substr(c, length('punch_cards:') + 1) from unnest(p_children) c where c like 'punch_cards:%');
  if cardinality(v_gone) > 0 then
    select coalesce(array_agg(distinct 'punch_card_uses:' || a.entity_id), '{}') into v_more
      from public.audit_log a
     where a.organization_id = p_org and a.entity_type = 'punch_card_uses' and a.entity_id is not null
       and coalesce(a.changes ->> 'card_id', a.changes -> 'card_id' ->> 'old') = any (v_gone)
       and not exists (select 1 from public.punch_card_uses u where u.organization_id = p_org and u.id = a.entity_id);
  end if;
  return v_more;
end;
$$;
revoke all on function app.punch_cards_erase(uuid, uuid, text[]) from public, anon, authenticated, service_role;
