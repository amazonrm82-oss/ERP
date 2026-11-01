-- QUO-08 rest (owner, 1 November 2026, answers (27) (א) and (28) (א)): on the customer's page of a sent quote the customer ticks
-- the optional lines they want before accepting, and may send a short question to the business.
--
-- (1) Optional lines. Quote lines already carry is_optional and optional_selected (QUO-02, 020105): the rep marks a line optional
--     on a draft, may preselect it, and both are frozen with the quote once it is sent (the lines policies write drafts only). The
--     stored totals of a sent quote count the items that are not optional plus the preselected optional ones, as before; that is
--     the figure the rep sent and the PDF shows. On the page every optional line starts UNTICKED, whatever the rep preselected
--     (owner's answer: "ברירת מחדל: לא מסומנות"), so the starting total is the quote without its optional lines and the page says
--     "הסכום כולל רק את מה שסימנתם"; it shows the total of the customer's choice by the same rule (quoteTotals = app.document_totals).
--   * public.quote_public_answer is quote_public_decide with two more arguments: p_optional_keys, the 1-based places of the ticked optional lines in
--     the order quote_public lists them (position, id; quote_public answers no ids), and p_accepted_total_agorot, the total the
--     page showed for that choice. A key that is unknown, repeated, or names a heading or a line that is not optional answers
--     'invalid'; a total that is not the total of that choice answers 'changed' (nothing is decided either way). An acceptance
--     with no choice (a page older than this migration, or the thin public.quote_public_decide wrapper) keeps meaning the rep's
--     preselected lines, as before; only the new page starts unticked. quote_public_decide keeps its 12-argument
--     signature as that wrapper (a new name rather than an overload, see below).
--   * public.quote_decisions keeps, for an acceptance: optional_line_ids (the lines ticked), choice_sha256 (SHA-256 of the
--     version's fingerprint and the sorted ticked ids: app.quote_choice_fingerprint), the totals as sent and the accepted totals
--     (app.quote_counted_totals over the items that are not optional plus the ticked ones, by app.document_totals at the quote's
--     stored rate). Server only, like the rest of the row (owners and admins read it).
--   * The accepted quote then holds the accepted figures: in the same transaction the server writes the choice into the lines'
--     optional_selected and app.quotes_check works the quote's totals out again from the lines, at its stored rate, only while
--     the transaction setting app.quote_accept_choice names the quote, the caller is not a person (auth.uid() is null) and the
--     quote is still sent or viewed. Every reader of an accepted quote's amount already reads the stored totals and the counted
--     lines (not optional, or optional and selected): QUO-13's deal step (app.quote_accept_deal, app.quote_deal_lines_replace,
--     public.quote_win_deal, deals.amount_quote_id), order_from_quote, report_quotes, the commercial trigger quote_accepted's
--     min_agorot, the DSC-01 discount split, the payment schedule's shares and the customer's page; so none of them changes.
--     What was sent stays in the decision row (sent totals, the version's fingerprint) and in the stored PDF.
--
-- (2) A question to the rep. public.quote_public_question(token, ip_hash, text) (security definer, service_role only; the quote
--     page's approved pattern, hard rule 5): the same link rule as quote_public (app.quote_link_usable, then the version the page
--     shows, app.quote_shown_version), only while the page shows the quote in full (open, or accepted). Text 1..500 characters
--     after trimming (control characters but line breaks become spaces). Counted first: in the link's view window (120 in 10
--     minutes, shared with the page), 20 questions per link in 24 hours (app.quote_links.question_*), and 5 per sender in 10
--     minutes by the server's keyed IP hash scoped to the quote (FXS-11 scope 'quote', app.quote_link_sender; 1,024 reused
--     buckets in app.quote_question_counts, no hash kept). It writes one `system` entry with no author on the quote's deal and
--     contact (metadata kind quote_question, quote_id, number; the text in the body) and tells app.quote_notice_recipients with
--     kind `quote` (title with the quote's title, body with the number and the text). A person never writes, changes or deletes
--     that entry: app.activities_quote_entry_guard already refuses every quote_* kind (hint activity:quote_entry), and
--     activities_zz_quote_system_author clears the author. Answers {status: sent|invalid|closed|rate_limited}; not found raises
--     P0002 like the page.
--   * Privacy erasure (app.audit_erase_core, copied from 021104 with the two QUO-08 changes marked): the question entries of the
--     erased customer's quotes keep only "שאלה מהלקוח על הצעת מחיר <number> (הטקסט נמחק)", and the question leaves the notices'
--     body (as the decline reason does); the entries' audit history is erased with the rest.
--
-- Shared functions redefined from their latest bodies: app.quotes_check (020270), public.quote_public_decide (020550),
-- app.audit_erase_core (021104). Every statement is safe to run twice. No drops, no row removal.

-- ----------------------------------------------------------------------------
-- (1) Optional lines: the decision's record of the choice
-- ----------------------------------------------------------------------------
alter table public.quote_decisions add column if not exists optional_line_ids uuid[];
alter table public.quote_decisions add column if not exists choice_sha256 text;
alter table public.quote_decisions add column if not exists sent_net_total_agorot bigint;
alter table public.quote_decisions add column if not exists sent_total_agorot bigint;
alter table public.quote_decisions add column if not exists accepted_subtotal_agorot bigint;
alter table public.quote_decisions add column if not exists accepted_discount_total_agorot bigint;
alter table public.quote_decisions add column if not exists accepted_net_total_agorot bigint;
alter table public.quote_decisions add column if not exists accepted_vat_agorot bigint;
alter table public.quote_decisions add column if not exists accepted_total_agorot bigint;
-- every amount has its currency next to it (TAX-06; ILS only until DEAL-12)
alter table public.quote_decisions add column if not exists currency text not null default 'ILS' constraint quote_decisions_currency_ils check (currency = 'ILS');
alter table public.quote_decisions drop constraint if exists quote_decisions_choice_shape;
alter table public.quote_decisions add constraint quote_decisions_choice_shape check (
  (choice_sha256 is null or choice_sha256 ~ '^[0-9a-f]{64}$')
  and (optional_line_ids is null or cardinality(optional_line_ids) <= 200)
  -- a refusal carries no choice; an acceptance made through this migration carries all of it (older rows carry none)
  and (decision = 'accepted' or (optional_line_ids is null and choice_sha256 is null and accepted_total_agorot is null))
  and ((choice_sha256 is null) = (accepted_total_agorot is null))
  and ((choice_sha256 is null) = (optional_line_ids is null)));

-- The totals of a quote over its counted lines: items that are not optional, and the optional ones that are chosen (p_choice,
-- or the lines' optional_selected when p_choice is null), by the one totals rule (TAX-05) at the given rate and the quote's mode
-- and document discount. Raises totals:invalid like app.document_totals (a fixed document discount above the chosen lines).
create or replace function app.quote_counted_totals(p_quote public.quotes, p_rate_bp integer, p_choice uuid[] default null)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select app.document_totals(
    coalesce((select jsonb_agg(jsonb_build_object(
                       'quantity', l.quantity,
                       'unit_price_agorot', l.unit_price_agorot,
                       'discount_bp', l.discount_bp,
                       'discount_agorot', l.discount_agorot,
                       'vat_exempt', l.vat_exempt) order by l.position, l.id)
                from public.quote_lines l
               where l.organization_id = p_quote.organization_id and l.quote_id = p_quote.id and l.kind = 'item'
                 and (not l.is_optional
                      or (p_choice is null and l.optional_selected)
                      or (p_choice is not null and l.id = any (p_choice)))), '[]'::jsonb),
    coalesce(p_rate_bp, 0), p_quote.prices_include_vat, p_quote.discount_bp, p_quote.discount_agorot);
$$;
revoke all on function app.quote_counted_totals(public.quotes, integer, uuid[]) from public, anon, authenticated, service_role;

-- What the customer agreed to: the version's fingerprint (app.quote_fingerprint) and the ticked optional lines, sorted
create or replace function app.quote_choice_fingerprint(p_fingerprint text, p_choice uuid[]) returns text
language sql immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(
    coalesce(p_fingerprint, '') || ':'
      || coalesce((select string_agg(c::text, ',' order by c::text) from unnest(p_choice) c), ''), 'UTF8')), 'hex');
$$;
revoke all on function app.quote_choice_fingerprint(text, uuid[]) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The quote trigger: app.quotes_check of 020270 with one QUO-08 branch (marked)
-- ----------------------------------------------------------------------------
create or replace function app.quotes_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_zone text;
  v_deal_contact uuid;
  v_deal_company uuid;
  v_rate integer;
  v_lines jsonb;
  v_totals jsonb;
begin
  -- outsider guard: a person who may not edit the quote's parent is refused by RLS (42501)
  if auth.uid() is not null and not app.quote_editable(new.organization_id, new.deal_id, new.contact_id) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if auth.uid() is not null and not app.org_has_feature(new.organization_id, 'quotes') then
      raise exception 'quotes are not in this plan' using errcode = 'P0001', hint = 'feature:quotes';
    end if;
    select o.timezone into v_zone from public.organizations o where o.id = new.organization_id;
    new.quote_date := (now() at time zone coalesce(v_zone, 'Asia/Jerusalem'))::date;
    if auth.uid() is not null then
      new.status := 'draft';
      new.owner_id := auth.uid();
      new.prices_include_vat := coalesce((select s.prices_include_vat from public.org_document_settings s
                                           where s.organization_id = new.organization_id), false)
                                and new.no_vat_reason is null;
    end if;
    -- the customer of the deal, else the contact's company
    if new.deal_id is not null then
      select d.contact_id, d.company_id into v_deal_contact, v_deal_company
        from public.deals d where d.organization_id = new.organization_id and d.id = new.deal_id;
      new.contact_id := coalesce(new.contact_id, v_deal_contact);
      new.company_id := coalesce(new.company_id, v_deal_company);
    end if;
    if new.company_id is null and new.contact_id is not null then
      new.company_id := (select c.company_id from public.contacts c
                          where c.organization_id = new.organization_id and c.id = new.contact_id);
    end if;
  else
    new.organization_id := old.organization_id;
    -- the deal stays fixed (no client grant); the server may only detach it (QUO-07, a purged deal)
    new.deal_id := case when new.deal_id is null then null else old.deal_id end;
    new.quote_date := old.quote_date;
    new.owner_id := old.owner_id;
    new.created_by := old.created_by;
    -- a quote that is no longer a draft keeps the inputs its amounts were worked out from, for
    -- every writer (the amounts themselves are kept below), so they never disagree
    if old.status <> 'draft'
       and (new.discount_bp is distinct from old.discount_bp
            or new.discount_agorot is distinct from old.discount_agorot
            or new.prices_include_vat is distinct from old.prices_include_vat
            or new.no_vat_reason is distinct from old.no_vat_reason) then
      raise exception 'the prices of a quote that is no longer a draft cannot change' using errcode = 'P0001', hint = 'quote:frozen';
    end if;
    if new.prices_include_vat is distinct from old.prices_include_vat
       and exists (select 1 from public.quote_lines l
                    where l.organization_id = new.organization_id and l.quote_id = new.id and l.kind = 'item') then
      raise exception 'the VAT mode of a quote with lines cannot change' using errcode = 'P0001', hint = 'quote:vat_locked';
    end if;
  end if;

  if (new.discount_bp is not null or new.discount_agorot is not null)
     and (tg_op = 'INSERT' or new.discount_bp is distinct from old.discount_bp
          or new.discount_agorot is distinct from old.discount_agorot)
     and auth.uid() is not null
     and not app.org_has_feature(new.organization_id, 'discounts') then
    raise exception 'discounts are not in this plan' using errcode = 'P0001', hint = 'feature:discounts';
  end if;

  -- a quote that is no longer a draft keeps the amounts and rate it was sent with; a later
  -- change of the business's VAT, or a server update such as detaching a purged contact,
  -- never rewrites them. Drafts (and the update that sends one) are worked out again.
  if tg_op = 'UPDATE' and old.status <> 'draft' then
    -- QUO-08 (owner, 1 November 2026): the customer's acceptance on the quote's page wrote the optional lines they ticked
    -- into the lines (public.quote_public_decide, the only writer of the setting); the accepted quote's totals are worked out
    -- again from its lines at the rate it was sent with. Never for a person, never after the quote was decided.
    if auth.uid() is null and old.status in ('sent', 'viewed')
       and coalesce(current_setting('app.quote_accept_choice', true), '') = new.id::text then
      v_totals := app.quote_counted_totals(new, old.vat_rate_bp);
      new.vat_rate_bp := old.vat_rate_bp;
      new.subtotal_agorot := (v_totals ->> 'subtotal_agorot')::bigint;
      new.discount_total_agorot := (v_totals ->> 'document_discount_agorot')::bigint;
      new.net_total_agorot := (v_totals ->> 'net_total_agorot')::bigint;
      new.vat_agorot := (v_totals ->> 'vat_agorot')::bigint;
      new.total_agorot := (v_totals ->> 'total_agorot')::bigint;
      return new;
    end if;
    new.vat_rate_bp := old.vat_rate_bp;
    new.subtotal_agorot := old.subtotal_agorot;
    new.discount_total_agorot := old.discount_total_agorot;
    new.net_total_agorot := old.net_total_agorot;
    new.vat_agorot := old.vat_agorot;
    new.total_agorot := old.total_agorot;
    return new;
  end if;

  -- totals by the one totals rule (TAX-05)
  v_rate := case when new.no_vat_reason is not null then 0
                 else app.org_document_vat_rate(new.organization_id, new.quote_date) end;
  if tg_op = 'INSERT' then
    v_lines := '[]'::jsonb;
  else
    select coalesce(jsonb_agg(jsonb_build_object(
             'quantity', l.quantity,
             'unit_price_agorot', l.unit_price_agorot,
             'discount_bp', l.discount_bp,
             'discount_agorot', l.discount_agorot,
             'vat_exempt', l.vat_exempt) order by l.position, l.id), '[]'::jsonb)
      into v_lines
      from public.quote_lines l
     where l.organization_id = new.organization_id and l.quote_id = new.id
       and l.kind = 'item' and (not l.is_optional or l.optional_selected);
  end if;
  v_totals := app.document_totals(v_lines, coalesce(v_rate, 0), new.prices_include_vat, new.discount_bp, new.discount_agorot);
  new.vat_rate_bp := v_rate;
  new.subtotal_agorot := (v_totals ->> 'subtotal_agorot')::bigint;
  new.discount_total_agorot := (v_totals ->> 'document_discount_agorot')::bigint;
  new.net_total_agorot := (v_totals ->> 'net_total_agorot')::bigint;
  new.vat_agorot := (v_totals ->> 'vat_agorot')::bigint;
  new.total_agorot := (v_totals ->> 'total_agorot')::bigint;
  return new;
end;
$$;
revoke all on function app.quotes_check() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Deciding: public.quote_public_answer is public.quote_public_decide of 020550 with the customer's choice of optional lines
-- (QUO-08, marked). public.quote_public_decide keeps its signature (a page older than this migration still calls it) and
-- answers through it with no choice: the rep's preselection. A new name rather than two more arguments, because a re-run of
-- an older file would bring the old signature back as a second overload, and a function is never dropped here.
-- ----------------------------------------------------------------------------
create or replace function public.quote_public_answer(
  p_token text, p_decision text, p_fingerprint text,
  p_signer_name text default null, p_id_number text default null,
  p_signature_kind text default null, p_signature_image text default null,
  p_wording_version text default null, p_agreed boolean default false,
  p_decline_reason text default null, p_ip text default null, p_user_agent text default null,
  p_optional_keys integer[] default null, p_accepted_total_agorot bigint default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_link app.quote_links;
  v_quote public.quotes;
  v_views integer;
  v_tries integer;
  v_shown public.quotes;
  v_name text := nullif(btrim(coalesce(p_signer_name, '')), '');
  v_id text := nullif(regexp_replace(coalesce(p_id_number, ''), '[^0-9]', '', 'g'), '');
  v_reason text := nullif(btrim(coalesce(p_decline_reason, '')), '');
  v_deal_note text;
  -- QUO-08: the ticked optional lines, and the totals of that choice
  v_choice uuid[];
  v_matched integer;
  v_totals jsonb;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_link from app.quote_links l where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_quote from public.quotes q where q.organization_id = v_link.organization_id and q.id = v_link.quote_id;
  -- owner, 19 October 2026: the link of a sent quote never answers not found (app.quote_link_usable)
  if not found or not app.quote_link_usable(v_quote) then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;

  -- counted first, in the link's view window and in a window of its own (10 tries in 10 minutes)
  update app.quote_links l
     set window_started_at = case when l.window_started_at > now() - interval '10 minutes' then l.window_started_at else now() end,
         window_count = case when l.window_started_at > now() - interval '10 minutes' then l.window_count + 1 else 1 end,
         decide_window_started_at = case when l.decide_window_started_at > now() - interval '10 minutes' then l.decide_window_started_at else now() end,
         decide_count = case when l.decide_window_started_at > now() - interval '10 minutes' then l.decide_count + 1 else 1 end
   where l.quote_id = v_link.quote_id
  returning l.window_count, l.decide_count into v_views, v_tries;
  if v_views > 120 or v_tries > 10 then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  -- the version the page shows: the newest that was ever sent (QUO-12, QUO-11 review), locked against a second decision in
  -- parallel; the superseded quote is never decided on
  v_shown := app.quote_shown_version(v_quote);
  select * into v_quote from public.quotes q where q.organization_id = v_shown.organization_id and q.id = v_shown.id for update;
  if v_quote.customer_deleted_at is not null then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  -- re-read after the lock: a newer version sent while this call waited (its send held this quote FOR SHARE) means the page
  -- the customer answered is no longer the one shown
  if (app.quote_shown_version(v_quote)).id is distinct from v_quote.id then
    return jsonb_build_object('status', 'changed');
  end if;
  if v_quote.status in ('accepted', 'rejected') then
    return jsonb_build_object('status', 'already_decided', 'decision', v_quote.status);
  end if;
  -- owner, 19 October 2026: deciding only on an open newest version (a cancelled or expired one shows its status page)
  if not app.quote_offer_open(v_quote) then
    return jsonb_build_object('status', 'closed');
  end if;
  if p_fingerprint is distinct from app.quote_fingerprint(v_quote) then
    return jsonb_build_object('status', 'changed');
  end if;

  if p_decision = 'accepted' then
    if not coalesce(p_agreed, false) or v_name is null or char_length(v_name) not between 2 and 120
       or coalesce(p_wording_version, '') !~ '^[a-z0-9-]{1,40}$'
       or p_signature_kind not in ('drawn', 'typed')
       or (p_signature_kind = 'drawn' and (p_signature_image is null or char_length(p_signature_image) > 300000
                                           or p_signature_image !~ '^data:image/png;base64,[A-Za-z0-9+/]+=*$'))
       or (v_id is not null and not app.valid_israeli_id(v_id)) then
      return jsonb_build_object('status', 'invalid');
    end if;

    -- QUO-08 (owner, 1 November 2026): the optional lines the customer ticked, by their place in the page's list (quote_public
    -- lists the lines by position, id and answers no ids). Every key names an optional item line of this version, once;
    -- anything else is refused. No keys sent (an older page): the rep's preselection, as before.
    if p_optional_keys is null then
      if p_accepted_total_agorot is not null then
        return jsonb_build_object('status', 'invalid');
      end if;
      select coalesce(array_agg(l.id order by l.position, l.id), '{}') into v_choice
        from public.quote_lines l
       where l.organization_id = v_quote.organization_id and l.quote_id = v_quote.id
         and l.kind = 'item' and l.is_optional and l.optional_selected;
    else
      if p_accepted_total_agorot is null or cardinality(p_optional_keys) > 200 or array_position(p_optional_keys, null) is not null
         or cardinality(p_optional_keys) <> (select count(distinct k) from unnest(p_optional_keys) k) then
        return jsonb_build_object('status', 'invalid');
      end if;
      select coalesce(array_agg(o.id order by o.place), '{}'), count(*) into v_choice, v_matched
        from (select l.id, l.kind, l.is_optional, row_number() over (order by l.position, l.id) as place
                from public.quote_lines l
               where l.organization_id = v_quote.organization_id and l.quote_id = v_quote.id) o
       where o.place = any (p_optional_keys) and o.kind = 'item' and o.is_optional;
      if v_matched <> cardinality(p_optional_keys) then
        return jsonb_build_object('status', 'invalid');
      end if;
    end if;
    begin
      v_totals := app.quote_counted_totals(v_quote, v_quote.vat_rate_bp, v_choice);
    exception when sqlstate '22023' then
      -- a fixed document discount larger than the chosen lines
      return jsonb_build_object('status', 'invalid');
    end;
    -- the total the page showed for that choice; another one means the page and the choice disagree
    if p_accepted_total_agorot is not null and p_accepted_total_agorot is distinct from (v_totals ->> 'total_agorot')::bigint then
      return jsonb_build_object('status', 'changed');
    end if;

    insert into public.quote_decisions (organization_id, quote_id, decision, signer_name, signer_id_number, signature_kind,
                                        signature_image, wording_version, content_sha256, ip, user_agent,
                                        optional_line_ids, choice_sha256, sent_net_total_agorot, sent_total_agorot,
                                        accepted_subtotal_agorot, accepted_discount_total_agorot, accepted_net_total_agorot,
                                        accepted_vat_agorot, accepted_total_agorot)
    values (v_quote.organization_id, v_quote.id, 'accepted', v_name, v_id, p_signature_kind,
            case when p_signature_kind = 'drawn' then p_signature_image end, p_wording_version, p_fingerprint,
            left(nullif(btrim(coalesce(p_ip, '')), ''), 64), left(nullif(btrim(coalesce(p_user_agent, '')), ''), 500),
            v_choice, app.quote_choice_fingerprint(p_fingerprint, v_choice), v_quote.net_total_agorot, v_quote.total_agorot,
            (v_totals ->> 'subtotal_agorot')::bigint, (v_totals ->> 'document_discount_agorot')::bigint,
            (v_totals ->> 'net_total_agorot')::bigint, (v_totals ->> 'vat_agorot')::bigint, (v_totals ->> 'total_agorot')::bigint);

    -- the choice becomes the accepted quote's: its lines say which optional ones count, and app.quotes_check works its totals
    -- out again from them (only while this setting names it), so every reader of an accepted quote reads what was accepted
    perform set_config('app.quote_accept_choice', v_quote.id::text, true);
    update public.quote_lines l
       set optional_selected = (l.id = any (v_choice))
     where l.organization_id = v_quote.organization_id and l.quote_id = v_quote.id
       and l.kind = 'item' and l.is_optional and l.optional_selected is distinct from (l.id = any (v_choice));
  elsif p_decision = 'rejected' then
    if (v_reason is not null and char_length(v_reason) > 1000) or (v_name is not null and char_length(v_name) not between 2 and 120) then
      return jsonb_build_object('status', 'invalid');
    end if;
    insert into public.quote_decisions (organization_id, quote_id, decision, signer_name, content_sha256, ip, user_agent, decline_reason)
    values (v_quote.organization_id, v_quote.id, 'rejected', v_name, p_fingerprint,
            left(nullif(btrim(coalesce(p_ip, '')), ''), 64), left(nullif(btrim(coalesce(p_user_agent, '')), ''), 500), v_reason);
  else
    return jsonb_build_object('status', 'invalid');
  end if;

  update public.quotes q set status = p_decision
   where q.organization_id = v_quote.organization_id and q.id = v_quote.id;
  perform set_config('app.quote_accept_choice', '', true);
  -- QUO-08: the accepted figures, for the deal step below
  select * into v_quote from public.quotes q where q.organization_id = v_quote.organization_id and q.id = v_quote.id;

  -- QUO-13: the deal of an accepted quote, by the business's setting. Never fails the decision: a failure is logged and
  -- said in the notice, and the quote page keeps offering the move while the deal is open.
  if p_decision = 'accepted' then
    begin
      v_deal_note := app.quote_accept_deal(v_quote);
    exception when others then
      raise warning 'QUO-13: the deal step of quote % failed: % (%)', v_quote.id, sqlerrm, sqlstate;
      v_deal_note := 'לא הצלחנו לטפל בעסקה של ההצעה. אפשר להעביר אותה לזכייה מדף ההצעה.';
    end;
  end if;

  -- the quote's owner hears of it (kind `quote`, coordinator 18 October 2026): number and title, no amounts
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select v_quote.organization_id, r.user_id, 'quote',
         left(case when p_decision = 'accepted' then 'הצעת מחיר אושרה: ' else 'הצעת מחיר נדחתה: ' end || v_quote.title, 200),
         nullif(concat_ws(' · ', case when v_quote.number_display is not null then 'הצעה ' || v_quote.number_display end, v_deal_note), ''),
         'quote', v_quote.id
    from app.quote_notice_recipients(v_quote) r(user_id);
  return jsonb_build_object('status', p_decision);
end;
$$;
revoke all on function public.quote_public_answer(text, text, text, text, text, text, text, text, boolean, text, text, text, integer[], bigint) from public, anon, authenticated;
grant execute on function public.quote_public_answer(text, text, text, text, text, text, text, text, boolean, text, text, text, integer[], bigint) to service_role;

-- QUO-09's entry point, unchanged for its callers: no choice sent = the rep's preselection
create or replace function public.quote_public_decide(
  p_token text, p_decision text, p_fingerprint text,
  p_signer_name text default null, p_id_number text default null,
  p_signature_kind text default null, p_signature_image text default null,
  p_wording_version text default null, p_agreed boolean default false,
  p_decline_reason text default null, p_ip text default null, p_user_agent text default null)
returns jsonb
language sql volatile security definer
set search_path = ''
as $$
  select public.quote_public_answer(p_token, p_decision, p_fingerprint, p_signer_name, p_id_number, p_signature_kind,
                                    p_signature_image, p_wording_version, p_agreed, p_decline_reason, p_ip, p_user_agent,
                                    null, null);
$$;
revoke all on function public.quote_public_decide(text, text, text, text, text, text, text, text, boolean, text, text, text) from public, anon, authenticated;
grant execute on function public.quote_public_decide(text, text, text, text, text, text, text, text, boolean, text, text, text) to service_role;

-- ----------------------------------------------------------------------------
-- (2) A question to the rep from the customer's page
-- ----------------------------------------------------------------------------
-- 20 questions per link in 24 hours
alter table app.quote_links add column if not exists question_window_started_at timestamptz;
alter table app.quote_links add column if not exists question_count integer not null default 0;

-- 5 per sender in 10 minutes, by the server's keyed IP hash scoped to the quote (no hash kept, 1,024 reused buckets)
create table if not exists app.quote_question_counts (
  organization_id uuid not null,
  quote_id        uuid not null,
  bucket          integer not null check (bucket between 0 and 1023),
  window_start    timestamptz not null,
  questions       integer not null,
  primary key (quote_id, bucket),
  constraint quote_question_counts_quote_fk foreign key (organization_id, quote_id)
    references public.quotes (organization_id, id) on delete cascade
);
create index if not exists quote_question_counts_quote_idx on app.quote_question_counts (organization_id, quote_id);
alter table app.quote_question_counts enable row level security;
revoke all on app.quote_question_counts from public, anon, authenticated, service_role;

create or replace function public.quote_public_question(p_token text, p_ip_hash text default null, p_text text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_link    app.quote_links;
  v_quote   public.quotes;
  v_shown   public.quotes;
  v_count   integer;
  v_asked   integer;
  v_bucket  integer;
  v_text    text;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_link from app.quote_links l where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_quote from public.quotes q where q.organization_id = v_link.organization_id and q.id = v_link.quote_id;
  -- the one rule for a sent quote's link (quote_public)
  if not app.quote_link_usable(v_quote) then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;

  -- counted first: the link's own window, shared with the page (120 in 10 minutes), and 20 questions per link in 24 hours
  update app.quote_links l
     set window_started_at = case when l.window_started_at > now() - interval '10 minutes' then l.window_started_at else now() end,
         window_count = case when l.window_started_at > now() - interval '10 minutes' then l.window_count + 1 else 1 end,
         question_window_started_at = case when l.question_window_started_at > now() - interval '24 hours'
                                           then l.question_window_started_at else now() end,
         question_count = case when l.question_window_started_at > now() - interval '24 hours' then l.question_count + 1 else 1 end
   where l.quote_id = v_link.quote_id
  returning l.window_count, l.question_count into v_count, v_asked;
  if v_count > 120 or v_asked > 20 then
    return jsonb_build_object('status', 'rate_limited');
  end if;
  -- FXS-11: 5 per sender in 10 minutes, by the server's keyed IP hash scoped to this quote
  if p_ip_hash is not null then
    v_bucket := ((hashtextextended(app.quote_link_sender(v_quote.id, p_ip_hash), 0) % 1024) + 1024) % 1024;
    insert into app.quote_question_counts as qc (organization_id, quote_id, bucket, window_start, questions)
    values (v_quote.organization_id, v_quote.id, v_bucket, now(), 1)
    on conflict (quote_id, bucket) do update
      set window_start = case when qc.window_start > now() - interval '10 minutes' then qc.window_start else now() end,
          questions = case when qc.window_start > now() - interval '10 minutes' then qc.questions + 1 else 1 end
    returning qc.questions into v_count;
    if v_count > 5 then
      return jsonb_build_object('status', 'rate_limited');
    end if;
  end if;

  -- the version the page shows (quote_public's chain walk), only while the page shows it in full (open, or accepted)
  v_shown := app.quote_shown_version(v_quote);
  if v_shown.customer_deleted_at is not null then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  if not (app.quote_offer_open(v_shown) or v_shown.status = 'accepted') then
    return jsonb_build_object('status', 'closed');
  end if;

  -- 1..500 characters after trimming; control characters other than a line break become spaces
  v_text := replace(replace(coalesce(p_text, ''), chr(13) || chr(10), chr(10)), chr(13), chr(10));
  v_text := btrim(regexp_replace(v_text, '[' || chr(1) || '-' || chr(9) || chr(11) || '-' || chr(31) || chr(127) || ']', ' ', 'g'));
  if char_length(v_text) not between 1 and 500 then
    return jsonb_build_object('status', 'invalid');
  end if;

  -- one system entry with no author on the quote's deal and contact (activities_zz_quote_system_author; a person never writes
  -- or changes a quote_* entry: app.activities_quote_entry_guard)
  if v_shown.deal_id is not null or v_shown.contact_id is not null then
    insert into public.activities (organization_id, type, deal_id, contact_id, body, metadata)
    values (v_shown.organization_id, 'system', v_shown.deal_id, v_shown.contact_id,
            'שאלה מהלקוח על הצעת מחיר' || coalesce(' ' || v_shown.number_display, '') || ': ' || v_text,
            jsonb_build_object('kind', 'quote_question', 'quote_id', v_shown.id, 'number', v_shown.number_display));
  end if;

  -- the quote's owner, else the deal's or contact's, else the owners and admins (RVW-34), with kind `quote`
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select v_shown.organization_id, r.user_id, 'quote',
         left('שאלה על הצעת מחיר: ' || v_shown.title, 200),
         concat_ws(' · ', case when v_shown.number_display is not null then 'הצעה ' || v_shown.number_display end, 'שאלה: ' || v_text),
         'quote', v_shown.id
    from app.quote_notice_recipients(v_shown) r(user_id);
  return jsonb_build_object('status', 'sent');
end;
$$;
revoke all on function public.quote_public_question(text, text, text) from public, anon, authenticated;
grant execute on function public.quote_public_question(text, text, text) to service_role;

-- ----------------------------------------------------------------------------
-- Privacy erasure: app.audit_erase_core copied exactly from its latest body (021104) with the two QUO-08 changes marked
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
