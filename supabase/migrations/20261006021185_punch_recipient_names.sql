-- =============================================================================
-- PKG-06 follow-ups: the service recipient on the customer's pages and PDFs, as sent (owner (156) א, 9 November 2026)
-- =============================================================================
-- (156) א: the customer's quote page and order page (/f/quote/<token>, /f/order/<token>) and the customer's PDFs of the
-- quote and the order show a punch card line's service recipient as "עבור: <name as sent>". The signed quote PDF (QUO-09)
-- does not print it (lead's interim choice until the owner answers; the app leaves it out). "As sent" is a snapshot, never
-- read live: a later rename or purge of the contact does not change what the customer was shown; a privacy erasure replaces
-- the name with a neutral text and removes the stored PDFs that printed it.
--
-- * quote_lines.recipient_name, order_lines.recipient_name (text, server only: no client grant) and
--   recipient_named_contact_id (uuid, no foreign key, like quotes.former_contact_id: the contact the name was taken from, so
--   the erasure finds the line after the purge emptied recipient_contact_id). Trigger *_lines_recipient_snapshot
--   (app.document_line_recipient_name, definer; named to run after *_lines_recipient, which sets or copies the recipient):
--   every writer's value is put back, except the snapshot below, the erasure and the merge (transaction settings).
--   On a draft a changed recipient clears the name; on a sent quote or a numbered order the name stays (a purge's set-null,
--   a merge's move). A copy (a quote version, QUO-12, and an order made from a quote) takes the name of the line it copied
--   the recipient from (same place, same product, same recipient), as PRD-09's bundle_items.
--   An order made from a quote is numbered when it is made: a line of it whose quote line has no name (a quote sent before
--   this migration, or a quote line whose recipient was the payer) takes the recipient's LIVE name at that moment, when the
--   recipient is not the order's payer contact (review LOW 5).
-- * The snapshot: AFTER update of status, a quote going draft -> sent and an order getting its number
--   (app.document_recipient_snapshot) fill every line with a recipient other than the payer contact and no name yet with the
--   contact's full name (else "ללא שם"). A line whose recipient is the payer contact itself shows nothing (owner (165) א).
-- * public.quote_public and public.order_public: the bodies of 021136 with only `recipient` added to each line of the full
--   page; not-found rules, limits and status pages unchanged (test 253 pins the md5).
-- * The erasure (app.punch_cards_erase, the body of 021183 plus this; run by app.audit_erase_core for a contact):
--   - the erased contact's name on other customers' lines (found by recipient_named_contact_id) becomes
--     "השם נמחק (מחיקת פרטיות)";
--   - every log entry of those lines, and of deleted lines whose entries name the person as recipient_named_contact_id,
--     loses recipient_name (`{"erased": true}`), and the existing step replaces the person's id;
--   - review HIGH 1: the stored PDFs of the payer's quotes and orders that held such a line are removed through the existing
--     app.quote_pdf_drop / app.order_pdf_drop (020960 / 021120: every files row of the document; the objects follow through
--     the orphan cleanup), so the next request makes the PDF again from the neutral stored data. quote_pdf_drop also removes
--     the quote's signed PDF (which does not print the name); an owner or admin can make it again from the decision
--     (quote_signed_pdf_allowed). A quote's PDF as sent is made only while the quote is sent or viewed, an order's while it
--     is numbered and not cancelled: after the erasure an accepted quote, or a cancelled order, has no PDF until then.
-- * Merge (app.merge_recipient_names on the `merged` entry): a name taken from the duplicate is the kept contact's: the lines'
--   recipient_named_contact_id and the same key in the lines' log entries (a delete entry's value, an update entry's old/new)
--   move to the kept contact, so the kept contact's erasure reaches deleted draft lines too (review LOW 2).
-- * punch_cards.opened_for_other_payer (server only, review LOW 3): true once the card has a payer other than its holder
--   (payer_contact_id or payer_company_id set; trigger punch_cards_other_payer), never cleared, so a purge of the payer
--   (the foreign keys' set-null) keeps the person's export mark (owner (159) ב, (164) ב). The one exception: a contact merge
--   that makes the payer the card's holder (app.merge_punch_recipients, redefined here from 021183's body with the
--   transaction-local setting app.punch_payer_merge around its two card updates) clears it, so the holder's own purchase
--   stays in their export (second review LOW). No backfill: no such card exists on the hosted project.
-- Lines of documents sent or numbered before this migration have no name (nothing is filled back: none exist on hosted).
-- The fingerprints (app.quote_fingerprint, app.order_fingerprint) are unchanged: the name is frozen with the document.
-- Every statement is safe to run twice. No drop statement and no delete in this file (the PDF removal is the existing pasted
-- functions'); the lines' and the log entries' updates are the erasure's and the merge's own.

alter table public.quote_lines add column if not exists recipient_name text;
alter table public.quote_lines add column if not exists recipient_named_contact_id uuid;
alter table public.order_lines add column if not exists recipient_name text;
alter table public.order_lines add column if not exists recipient_named_contact_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'quote_lines_recipient_name_len' and conrelid = 'public.quote_lines'::regclass) then
    alter table public.quote_lines add constraint quote_lines_recipient_name_len check (recipient_name is null or char_length(recipient_name) <= 300);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'order_lines_recipient_name_len' and conrelid = 'public.order_lines'::regclass) then
    alter table public.order_lines add constraint order_lines_recipient_name_len check (recipient_name is null or char_length(recipient_name) <= 300);
  end if;
end;
$$;

create index if not exists quote_lines_recipient_named_idx on public.quote_lines (organization_id, recipient_named_contact_id)
  where recipient_named_contact_id is not null;
create index if not exists order_lines_recipient_named_idx on public.order_lines (organization_id, recipient_named_contact_id)
  where recipient_named_contact_id is not null;

-- Review LOW 3: a card opened for a holder other than its payer keeps saying so after the payer is purged
alter table public.punch_cards add column if not exists opened_for_other_payer boolean not null default false;

create or replace function app.punch_cards_other_payer() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    -- a merge that makes the payer the holder (app.merge_punch_recipients, transaction-local setting set around its card
    -- updates only; clients have no write on punch_cards): the card is the holder's own purchase again
    if coalesce(current_setting('app.punch_payer_merge', true), '') = 'on'
       and new.payer_contact_id is null and new.payer_company_id is null and old.payer_contact_id is not null then
      new.opened_for_other_payer := false;
      return new;
    end if;
    -- otherwise never cleared, for every writer (the payer's set-null at its purge keeps it)
    new.opened_for_other_payer := old.opened_for_other_payer;
  else
    new.opened_for_other_payer := false;
  end if;
  if new.payer_contact_id is not null or new.payer_company_id is not null then
    new.opened_for_other_payer := true;
  end if;
  return new;
end;
$$;
revoke all on function app.punch_cards_other_payer() from public, anon, authenticated, service_role;

create or replace trigger punch_cards_other_payer before insert or update on public.punch_cards
  for each row execute function app.punch_cards_other_payer();

-- app.merge_punch_recipients: the body of 021183, plus the setting app.punch_payer_merge around its two card updates
create or replace function app.merge_punch_recipients() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_merged uuid;
  v_before text := coalesce(current_setting('app.punch_recipient_server', true), '');
  v_order_before text := coalesce(current_setting('app.order_server', true), '');
  v_payer_before text := coalesce(current_setting('app.punch_payer_merge', true), '');
begin
  if (new.metadata ->> 'merged_id') !~ '^[0-9a-fA-F-]{36}$' then
    return null;
  end if;
  v_merged := (new.metadata ->> 'merged_id')::uuid;
  -- review finding 6: a company merge moves the cards the duplicate company paid for
  if new.contact_id is null and new.company_id is not null and v_merged <> new.company_id then
    update public.punch_cards c set payer_company_id = new.company_id
     where c.organization_id = new.organization_id and c.payer_company_id = v_merged;
    return null;
  end if;
  if new.contact_id is null or v_merged = new.contact_id then
    return null;
  end if;
  perform set_config('app.punch_recipient_server', 'on', true);
  perform set_config('app.order_server', 'on', true);
  update public.quote_lines l set recipient_contact_id = new.contact_id
   where l.organization_id = new.organization_id and l.recipient_contact_id = v_merged;
  update public.order_lines l set recipient_contact_id = new.contact_id
   where l.organization_id = new.organization_id and l.recipient_contact_id = v_merged;
  perform set_config('app.punch_recipient_server', v_before, true);
  perform set_config('app.order_server', v_order_before, true);
  -- 021185 (second review LOW): a card whose payer becomes its own holder by this merge is the holder's own purchase again,
  -- so app.punch_cards_other_payer clears opened_for_other_payer for these two updates only
  perform set_config('app.punch_payer_merge', 'on', true);
  -- a card the duplicate paid for: the kept contact paid; when it now holds the card itself, it is no separate payer
  update public.punch_cards c
     set payer_contact_id = case when c.contact_id = new.contact_id then null else new.contact_id end
   where c.organization_id = new.organization_id and c.payer_contact_id = v_merged;
  -- a card the kept contact paid for that the duplicate held came to it with the merge (app.merge_punch_cards)
  update public.punch_cards c set payer_contact_id = null
   where c.organization_id = new.organization_id and c.contact_id = new.contact_id and c.payer_contact_id = new.contact_id;
  perform set_config('app.punch_payer_merge', v_payer_before, true);
  return null;
end;
$$;
revoke all on function app.merge_punch_recipients() from public, anon, authenticated, service_role;

-- The name a line shows for its recipient (the contact's full name as it is now; the callers keep it)
create or replace function app.recipient_display_name(p_org uuid, p_contact uuid) returns text
language sql stable security definer
set search_path = ''
as $$
  select left(coalesce(nullif(btrim(c.full_name), ''), 'ללא שם'), 300)
    from public.contacts c where c.organization_id = p_org and c.id = p_contact;
$$;
revoke all on function app.recipient_display_name(uuid, uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The line trigger (one function for both tables; the document id read from the row's json)
-- ----------------------------------------------------------------------------
create or replace function app.document_line_recipient_name() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_quote boolean := tg_table_name = 'quote_lines';
  v_doc uuid := coalesce(to_jsonb(new) ->> 'quote_id', to_jsonb(new) ->> 'order_id')::uuid;
  v_status text;
  v_payer uuid;
  v_previous uuid;
  v_source text;
  v_from_quote uuid;
  v_name text;
  v_named uuid;
begin
  if tg_op = 'UPDATE' then
    -- the snapshot of this document (app.document_recipient_snapshot), the erasure and the merge write the name
    if coalesce(current_setting('app.recipient_snapshot', true), '') = (case when v_quote then 'quote:' else 'order:' end) || v_doc::text
       or coalesce(current_setting('app.recipient_name_server', true), '') = 'on' then
      return new;
    end if;
    if new.recipient_contact_id is distinct from old.recipient_contact_id then
      if v_quote then
        select q.status into v_status from public.quotes q where q.organization_id = new.organization_id and q.id = v_doc;
      else
        select o.status into v_status from public.orders o where o.organization_id = new.organization_id and o.id = v_doc;
      end if;
      -- a draft's recipient changed: the name is taken again when it is sent or numbered
      if v_status = 'draft' then
        new.recipient_name := null;
        new.recipient_named_contact_id := null;
        return new;
      end if;
    end if;
    -- a sent or numbered document keeps the name it was sent with (a purge's set-null, a merge's move), for every writer
    new.recipient_name := old.recipient_name;
    new.recipient_named_contact_id := old.recipient_named_contact_id;
    return new;
  end if;

  -- an insert: no writer brings a name of its own
  new.recipient_name := null;
  new.recipient_named_contact_id := null;
  if new.recipient_contact_id is null then
    return new;
  end if;
  if v_quote then
    select q.status, q.contact_id, q.previous_id into v_status, v_payer, v_previous
      from public.quotes q where q.organization_id = new.organization_id and q.id = v_doc;
  else
    select o.status, o.contact_id, o.source, o.quote_id into v_status, v_payer, v_source, v_from_quote
      from public.orders o where o.organization_id = new.organization_id and o.id = v_doc;
  end if;
  -- a copy keeps the name the customer already saw on the line it copied the recipient from
  if v_quote and v_previous is not null and coalesce(current_setting('app.quote_version_copy', true), '') = v_doc::text then
    select l.recipient_name, l.recipient_named_contact_id into v_name, v_named from public.quote_lines l
     where l.organization_id = new.organization_id and l.quote_id = v_previous
       and l.position = new.position and l.product_id is not distinct from new.product_id
       and l.recipient_contact_id = new.recipient_contact_id and l.recipient_name is not null
     order by l.id limit 1;
  elsif not v_quote and v_source = 'quote' and v_from_quote is not null then
    select l.recipient_name, l.recipient_named_contact_id into v_name, v_named from public.quote_lines l
     where l.organization_id = new.organization_id and l.quote_id = v_from_quote
       and l.position = new.position and l.product_id is not distinct from new.product_id
       and l.recipient_contact_id = new.recipient_contact_id and l.recipient_name is not null
     order by l.id limit 1;
  end if;
  if v_name is not null then
    new.recipient_name := v_name;
    new.recipient_named_contact_id := v_named;
    return new;
  end if;
  -- a line made on a document that is already sent or numbered (an order made from a quote): the name now
  if v_status is distinct from 'draft' and new.recipient_contact_id is distinct from v_payer then
    new.recipient_name := app.recipient_display_name(new.organization_id, new.recipient_contact_id);
    new.recipient_named_contact_id := new.recipient_contact_id;
  end if;
  return new;
end;
$$;
revoke all on function app.document_line_recipient_name() from public, anon, authenticated, service_role;

create or replace trigger quote_lines_recipient_snapshot before insert or update on public.quote_lines
  for each row execute function app.document_line_recipient_name();
create or replace trigger order_lines_recipient_snapshot before insert or update on public.order_lines
  for each row execute function app.document_line_recipient_name();

-- ----------------------------------------------------------------------------
-- The snapshot: when a quote is sent or an order gets its number (server writes inside that transaction)
-- ----------------------------------------------------------------------------
create or replace function app.document_recipient_snapshot() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_before text := coalesce(current_setting('app.recipient_snapshot', true), '');
  v_order_before text := coalesce(current_setting('app.order_server', true), '');
begin
  if tg_table_name = 'quotes' then
    perform set_config('app.recipient_snapshot', 'quote:' || new.id::text, true);
    update public.quote_lines l
       set recipient_name = app.recipient_display_name(l.organization_id, l.recipient_contact_id),
           recipient_named_contact_id = l.recipient_contact_id
     where l.organization_id = new.organization_id and l.quote_id = new.id
       and l.recipient_contact_id is not null and l.recipient_name is null
       and l.recipient_contact_id is distinct from new.contact_id;
  else
    perform set_config('app.recipient_snapshot', 'order:' || new.id::text, true);
    -- a server write: a numbered order's lines otherwise refuse every change (order_lines_check)
    perform set_config('app.order_server', 'on', true);
    update public.order_lines l
       set recipient_name = app.recipient_display_name(l.organization_id, l.recipient_contact_id),
           recipient_named_contact_id = l.recipient_contact_id
     where l.organization_id = new.organization_id and l.order_id = new.id
       and l.recipient_contact_id is not null and l.recipient_name is null
       and l.recipient_contact_id is distinct from new.contact_id;
    perform set_config('app.order_server', v_order_before, true);
  end if;
  perform set_config('app.recipient_snapshot', v_before, true);
  return null;
end;
$$;
revoke all on function app.document_recipient_snapshot() from public, anon, authenticated, service_role;

create or replace trigger quotes_recipient_snapshot after update of status on public.quotes
  for each row when (old.status = 'draft' and new.status = 'sent')
  execute function app.document_recipient_snapshot();
create or replace trigger orders_recipient_snapshot after update of status on public.orders
  for each row when (old.status = 'draft' and new.status not in ('draft', 'cancelled'))
  execute function app.document_recipient_snapshot();

-- ----------------------------------------------------------------------------
-- Merge: a name taken from the duplicate is now the kept contact's (its erasure reaches it)
-- ----------------------------------------------------------------------------
create or replace function app.merge_recipient_names() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_merged uuid;
  v_before text := coalesce(current_setting('app.recipient_name_server', true), '');
  v_order_before text := coalesce(current_setting('app.order_server', true), '');
begin
  if (new.metadata ->> 'merged_id') !~ '^[0-9a-fA-F-]{36}$' then
    return null;
  end if;
  v_merged := (new.metadata ->> 'merged_id')::uuid;
  if v_merged = new.contact_id then
    return null;
  end if;
  perform set_config('app.recipient_name_server', 'on', true);
  perform set_config('app.order_server', 'on', true);
  update public.quote_lines l set recipient_named_contact_id = new.contact_id
   where l.organization_id = new.organization_id and l.recipient_named_contact_id = v_merged;
  update public.order_lines l set recipient_named_contact_id = new.contact_id
   where l.organization_id = new.organization_id and l.recipient_named_contact_id = v_merged;
  -- review LOW 2: the log entries of the lines (deleted draft lines included) that name the duplicate as the contact a name
  -- was taken from now name the kept contact, so its erasure reaches them; only that key moves
  update public.audit_log a
     set changes = case
                     when jsonb_typeof(a.changes -> 'recipient_named_contact_id') = 'string'
                       then jsonb_set(a.changes, '{recipient_named_contact_id}', to_jsonb(new.contact_id::text))
                     else jsonb_set(a.changes, '{recipient_named_contact_id}',
                                    (a.changes -> 'recipient_named_contact_id')
                                    || case when a.changes -> 'recipient_named_contact_id' ->> 'old' = v_merged::text
                                            then jsonb_build_object('old', new.contact_id::text) else '{}'::jsonb end
                                    || case when a.changes -> 'recipient_named_contact_id' ->> 'new' = v_merged::text
                                            then jsonb_build_object('new', new.contact_id::text) else '{}'::jsonb end)
                   end
   where a.organization_id = new.organization_id and a.entity_type in ('quote_lines', 'order_lines')
     and a.changes ? 'recipient_named_contact_id'
     and (a.changes ->> 'recipient_named_contact_id' = v_merged::text
          or a.changes -> 'recipient_named_contact_id' ->> 'old' = v_merged::text
          or a.changes -> 'recipient_named_contact_id' ->> 'new' = v_merged::text);
  perform set_config('app.recipient_name_server', v_before, true);
  perform set_config('app.order_server', v_order_before, true);
  return null;
end;
$$;
revoke all on function app.merge_recipient_names() from public, anon, authenticated, service_role;

create or replace trigger activities_merge_recipient_names after insert on public.activities
  for each row
  when (new.type = 'system' and new.contact_id is not null and new.metadata ? 'merged_id')
  execute function app.merge_recipient_names();

-- ----------------------------------------------------------------------------
-- The customer's pages: quote_public and order_public, the bodies of 021136 with `recipient` on each line of the full page
-- ----------------------------------------------------------------------------
create or replace function public.quote_public(p_token text) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_link app.quote_links;
  v_quote public.quotes;
  v_count integer;
  v_design public.quote_designs;
  v_settings public.org_document_settings;
  v_org public.organizations;
  v_show_details boolean;
  v_show_logo boolean;
  -- TAX-02: the bank details stored on the quote when it was sent, when the design shows them
  v_show_bank boolean;
  v_lines jsonb;
  v_built_with boolean;
  v_schedule jsonb;
  -- QUO-12: the quote the link was made for, when the page shows a newer version of it
  v_opened public.quotes;
  v_next public.quotes;
  -- OPS-02 (owner (41) ב): the per-sender view limit
  v_sender text;
  v_bucket integer;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_link from app.quote_links l where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_quote from public.quotes q where q.organization_id = v_link.organization_id and q.id = v_link.quote_id;

  -- owner, 19 October 2026: the link of a quote that was sent never answers not found. Not found only for a token that does
  -- not exist or was revoked (its hash cleared), a draft, a customer erased or purged (customer_deleted_at), a business whose
  -- public pages are closed, or one without quotes
  if not app.quote_link_usable(v_quote) then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;

  -- 120 views per link in 10 minutes; counted first, so the limit holds under parallel load
  update app.quote_links l
     set window_started_at = case when l.window_started_at > now() - interval '10 minutes' then l.window_started_at else now() end,
         window_count = case when l.window_started_at > now() - interval '10 minutes' then l.window_count + 1 else 1 end
   where l.quote_id = v_link.quote_id
  returning l.window_count into v_count;
  if v_count > 120 then
    return jsonb_build_object('rate_limited', true);
  end if;
  -- OPS-02 (owner, 2 November 2026, answer (41) ב): 60 views per sender in 10 minutes, as order_public and statement_public,
  -- counted after the token lookup and the link's window. The sender is the server's keyed IP hash (FXS-11 scope 'quote'),
  -- handed over in the request header x-crm-sender (app.public_sender_header, 021127) and scoped to the link's quote by
  -- app.quote_link_sender; no header = not counted (the signed PDF's own read, quote_public_answer, a page older than this file).
  -- Only a bucket number is kept, never the hash.
  v_sender := app.quote_link_sender(v_link.quote_id, app.public_sender_header());
  if v_sender is not null then
    v_bucket := ((hashtextextended(v_sender, 0) % 1024) + 1024) % 1024;
    insert into app.quote_link_view_counts as vc (organization_id, quote_id, bucket, window_start, views)
    values (v_link.organization_id, v_link.quote_id, v_bucket, now(), 1)
    on conflict (quote_id, bucket) do update
      set window_start = case when vc.window_start > now() - interval '10 minutes' then vc.window_start else now() end,
          views = case when vc.window_start > now() - interval '10 minutes' then vc.views + 1 else 1 end
    returning vc.views into v_count;
    if v_count > 60 then
      return jsonb_build_object('rate_limited', true);
    end if;
  end if;

  -- the newest version of the chain that was ever sent (QUO-12, the QUO-11 review rule), whether or not it has a link of its
  -- own; never an older one
  v_next := app.quote_shown_version(v_quote);
  if v_next.customer_deleted_at is not null then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  if v_next.id is distinct from v_quote.id then
    v_opened := v_quote;
    v_quote := v_next;
  end if;

  -- declined, cancelled, or past its date: a status page with no prices, lines or a way to sign (owner, 19 October 2026: an
  -- accepted quote is shown in full, with the day it was accepted and no way to decide)
  if not app.quote_offer_open(v_quote) and v_quote.status <> 'accepted' then
    select * into v_org from public.organizations o where o.id = v_quote.organization_id;
    select * into v_design from public.quote_designs d where d.organization_id = v_quote.organization_id;
    select * into v_settings from public.org_document_settings s where s.organization_id = v_quote.organization_id;
    return jsonb_build_object('status_page', jsonb_build_object(
      'state', case when v_quote.status in ('rejected', 'cancelled') then v_quote.status else 'expired' end,
      'number', v_quote.number_display,
      'title', v_quote.title,
      'valid_until', v_quote.valid_until,
      -- documents use the registered name when set (owner)
      'business', coalesce(nullif(btrim(v_settings.legal_name), ''), v_org.name),
      'logo', case when coalesce(v_design.show_logo, true) then v_org.logo_path end,
      'color', coalesce(v_design.accent_color, v_org.brand_color),
      'phone', coalesce(nullif(btrim(v_settings.phone), ''), nullif(btrim(v_org.phone), '')),
      'replaced', case when v_opened.id is not null then jsonb_build_object('number', v_opened.number_display) end,
      -- a newer version is being prepared (QUO-12 answer 7)
      'draft_version', exists (select 1 from public.quotes d
                                where d.organization_id = v_quote.organization_id and d.previous_id = v_quote.id
                                  and d.status = 'draft')));
  end if;

  -- QUO-10: the customer opened the quote shown; count the view, and the first one marks it viewed and tells its owner
  if app.quote_mark_viewed(v_quote) then
    v_quote.status := 'viewed';
  end if;

  select * into v_org from public.organizations o where o.id = v_quote.organization_id;
  select * into v_design from public.quote_designs d where d.organization_id = v_quote.organization_id;
  select * into v_settings from public.org_document_settings s where s.organization_id = v_quote.organization_id;
  -- QUO-05: no design row = the defaults (logo and business details shown)
  v_show_details := coalesce(v_design.show_business_details, true);
  v_show_logo := coalesce(v_design.show_logo, true);
  v_show_bank := coalesce(v_design.show_bank_details_quote, true);

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
           'is_optional', l.is_optional,
           'optional_selected', l.optional_selected,
           'total_agorot', l.total_agorot,
           -- PRD-09: an itemised bundle lists its parts as kept on the line when it was added (names and quantities, no prices)
           'components', case when l.bundle_display = 'itemised' then l.bundle_items end,
           -- PKG-06 (owner (156) א): a punch card line's service recipient, the name as sent (null on every other line)
           'recipient', l.recipient_name) order by l.position, l.id), '[]'::jsonb)
    into v_lines
    from public.quote_lines l
   where l.organization_id = v_quote.organization_id and l.quote_id = v_quote.id;

  -- GAP-09: the payment schedule, with each row's share of the total (the shares add up to the total)
  v_schedule := app.quote_schedule(v_quote.organization_id, v_quote.id, v_quote.total_agorot);

  begin
    v_built_with := coalesce(app.show_built_with(v_quote.organization_id), true);
  exception when others then
    v_built_with := true;
  end;

  return jsonb_build_object(
    'quote', jsonb_build_object(
      'number', v_quote.number_display,
      'title', v_quote.title,
      'status', v_quote.status,
      'quote_date', v_quote.quote_date,
      'valid_until', v_quote.valid_until,
      'sent_at', v_quote.sent_at,
      'prices_include_vat', v_quote.prices_include_vat,
      'no_vat_reason', v_quote.no_vat_reason,
      'no_vat_note', v_quote.no_vat_note,
      'discount_bp', v_quote.discount_bp,
      'discount_agorot', v_quote.discount_agorot,
      'notes', v_quote.notes,
      'terms', v_quote.terms,
      'vat_rate_bp', v_quote.vat_rate_bp,
      'subtotal_agorot', v_quote.subtotal_agorot,
      'discount_total_agorot', v_quote.discount_total_agorot,
      'net_total_agorot', v_quote.net_total_agorot,
      'vat_agorot', v_quote.vat_agorot,
      'total_agorot', v_quote.total_agorot,
      'currency', v_quote.currency),
    -- the customer as printed when the quote was sent (QUO-07); never the live record
    'customer', jsonb_build_object('name', v_quote.customer_name, 'contact', v_quote.customer_contact_name),
    'lines', v_lines,
    'schedule', v_schedule,
    -- documents use the registered name when set (owner); the rest only when the design shows the details
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
      'show_bank_details_quote', v_show_bank,
      'accent_color', v_design.accent_color),
    'brand', jsonb_build_object('logo', case when v_show_logo then v_org.logo_path end, 'color', v_org.brand_color),
    'built_with', v_built_with,
    -- TAX-02: the business's bank details for a transfer, as stored on the quote when it was sent (never the live settings);
    -- only when the design shows them and the quote has them
    'bank', case when v_show_bank and v_quote.bank_details is not null then jsonb_build_object(
                   'bank_name', v_quote.bank_details ->> 'bank_name',
                   'bank_branch', v_quote.bank_details ->> 'bank_branch',
                   'bank_account', v_quote.bank_details ->> 'bank_account',
                   'bank_account_name', v_quote.bank_details ->> 'bank_account_name') end,
    -- QUO-12: the number the customer's link was made for, when this is a newer version of it (else null)
    'replaced', case when v_opened.id is not null then jsonb_build_object('number', v_opened.number_display) end,
    -- owner, 19 October 2026: the day an accepted quote was accepted, in the business's zone (null otherwise)
    'accepted_on', case when v_quote.status = 'accepted' then
                     (select (d.decided_at at time zone app.intake_zone(v_org.timezone))::date
                        from public.quote_decisions d
                       where d.organization_id = v_quote.organization_id and d.quote_id = v_quote.id and d.decision = 'accepted') end,
    -- QUO-12 (owner, 19 October 2026): a newer version is being prepared (a draft after the quote shown); no id or content
    'draft_version', exists (select 1 from public.quotes d
                              where d.organization_id = v_quote.organization_id and d.previous_id = v_quote.id
                                and d.status = 'draft'),
    -- GAP-10: the quote this one adds to (its number), and the accepted addenda of this one; numbers, titles and totals only
    'addendum', (select jsonb_build_object('number', o.number_display) from public.quotes o
                  where v_quote.addendum_of is not null and o.organization_id = v_quote.organization_id and o.id = v_quote.addendum_of),
    -- QUO-06 (owner's answer 1): the customer may download the stored PDF of the version shown
    'pdf', exists (select 1 from public.files f
                    where f.organization_id = v_quote.organization_id and f.quote_id = v_quote.id
                      and f.unconfirmed_since is null and f.sha256 is not null),
    'addenda', coalesce((select jsonb_agg(jsonb_build_object('number', a.number_display, 'title', a.title, 'total_agorot', a.total_agorot)
                                          order by a.sent_at, a.number)
                           from public.quotes a
                          where a.organization_id = v_quote.organization_id and a.addendum_of = v_quote.id and a.status = 'accepted'),
                        '[]'::jsonb));
end;
$$;
revoke all on function public.quote_public(text) from public, anon, authenticated;
grant execute on function public.quote_public(text) to service_role;

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
           'total_agorot', l.total_agorot,
           -- PRD-09: an itemised bundle lists its parts as kept on the line when it was added (names and quantities, no prices)
           'components', case when l.bundle_display = 'itemised' then l.bundle_items end,
           -- PKG-06 (owner (156) א): a punch card line's service recipient, the name as sent (null on every other line)
           'recipient', l.recipient_name) order by l.position, l.id), '[]'::jsonb)
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
-- app.punch_cards_erase: the body of 021183, plus the name as sent on the lines that named the person
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
  -- PKG-06 (owner (156) א): the person's name as sent on the lines of other customers' documents that named them as the
  -- service recipient (found by the id the snapshot was taken from; the foreign key emptied recipient_contact_id at the
  -- purge) becomes a neutral text, and the log entries that carried the name lose it
  v_before := coalesce(current_setting('app.recipient_name_server', true), '');
  v_order_before := coalesce(current_setting('app.order_server', true), '');
  perform set_config('app.recipient_name_server', 'on', true);
  perform set_config('app.order_server', 'on', true);
  with q as (
    update public.quote_lines l set recipient_name = 'השם נמחק (מחיקת פרטיות)', recipient_named_contact_id = null
     where l.organization_id = p_org and l.recipient_named_contact_id = p_contact
    returning l.id, l.quote_id)
  select coalesce(array_agg(q.id), '{}'), coalesce(array_agg(distinct q.quote_id), '{}') into v_lines, v_quotes from q;
  with o as (
    update public.order_lines l set recipient_name = 'השם נמחק (מחיקת פרטיות)', recipient_named_contact_id = null
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
  -- review HIGH 1: the stored PDFs of the payer's documents that printed the name go (made again from the neutral data)
  perform app.quote_pdf_drop(p_org, v_quotes);
  perform set_config('app.order_server', 'on', true);
  perform app.order_pdf_drop(p_org, v_orders);
  perform set_config('app.order_server', v_order_before, true);
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

notify pgrst, 'reload schema';
