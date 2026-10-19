-- =============================================================================
-- An accepted quote and its deal (QUO-13 part one, without orders)
-- =============================================================================
-- A per-business setting says what happens to the quote's deal when the customer accepts on the quote's page:
--
-- * org_document_settings.quote_accept_deal: 'auto' | 'ask' | 'none', default 'ask' (owners/admins of a writable business
--   write it through the table's existing policies; the table is audited). No row = 'ask'.
-- * app.quote_accept_deal(quote) (definer, no grants), called by public.quote_public_decide after the status update of an
--   accepted quote. It touches only the quote's own deal, of the same business, while the deal is open and not in the bin;
--   a quote with no deal, and an addendum (GAP-10: it adds to work already accepted, so its lines never replace the deal's),
--   do nothing. It answers one sentence for the accepted notice, or null:
--     auto: the deal's lines are replaced by the quote's (app.quote_deal_lines_replace, in its own savepoint: when a deal
--           lines rule refuses, e.g. the deal's VAT mode, the old lines stay and the sentence says so), then the deal moves to
--           its pipeline's first won stage by position, by a plain stage update, so the DEAL-04 close date (now), the stage
--           history entry and every other deals trigger run as for any move. When the move fails, the lines are rolled back
--           with it and the sentence says that nothing was done. The automatic move asks no FLD-09 required fields and
--           makes no onboarding task (the setting's help text says so).
--     ask:  the question "להעביר את העסקה לזכייה ולעדכן את השורות?"; the quote page offers the existing won window to the
--           people who may edit the deal, and its confirmation runs public.quote_win_deal: the lines and the move in one
--           transaction, so cancelling the window changes nothing.
--     none: nothing.
-- * public.quote_public_decide (the body of 020455): the accepted notice body is "הצעה <number> · <sentence>". The step runs
--   inside an exception block: the customer's decision is never lost because of it. A failure is logged (raise warning)
--   and surfaced in the notice ("לא הצלחנו לטפל בעסקה של ההצעה…"), and the quote page keeps offering the move while the deal
--   is open.
-- * public.quote_lines_to_deal(org, quote) (definer, authenticated): an accepted quote (not an addendum) whose deal is open,
--   not in the bin, and editable by the caller (app.quote_editable), quotes flag; replaces the deal's lines with the quote's
--   under the caller's rules (app.quote_deal_lines_replace; deal_lines_check judges the person: offerable products, flags,
--   VAT mode). Answers {lines: n}. Hints quote_deal:not_accepted | no_deal | closed.
-- * public.quote_win_deal(org, quote, stage, amount, closed_at, custom_fields, columns) (security INVOKER, authenticated):
--   the won window's save for an accepted quote. `columns` (DEAL-05) is a jsonb object of the won stage's other required
--   built-in fields asked in the window, expected_close_date and contact_id only; any other key, or a value that is not an
--   object, is refused first (22023, hint quote_win:columns); so is an expected_close_date that is not a YYYY-MM-DD
--   string of a real day (null, 'today', 'infinity', 2026-02-30). In one transaction: quote_lines_to_deal in a savepoint (a deal lines refusal,
--   hints deal_lines:* or the products/discounts/price_lists flags, keeps the old lines and is answered as `lines`), then the
--   person's own update of the deal (stage, amount, close date, the asked required fields), under RLS and every
--   person-write trigger, only while the deal is open and out of the bin (else hint quote_deal:closed and nothing changes).
--   Answers {deal, lines: 'updated' | <the refusal's hint>}.
--
-- app.quote_deal_lines_replace holds a delete statement, so it lives in its own file, pasted by hand (it only creates a
-- function, so before or after this one): 20261006020480_quote_deal_lines_replace.sql. Until it runs, the automatic step still moves the deal and its notice says
-- the lines were not updated (the lines call fails into its own savepoint); quote_lines_to_deal and quote_win_deal answer
-- an error (42883).

alter table public.org_document_settings
  add column if not exists quote_accept_deal text not null default 'ask'
    constraint org_document_settings_quote_accept_deal check (quote_accept_deal in ('auto', 'ask', 'none'));
grant insert (quote_accept_deal), update (quote_accept_deal) on public.org_document_settings to authenticated;

-- ----------------------------------------------------------------------------
-- The step itself
-- ----------------------------------------------------------------------------
create or replace function app.quote_accept_deal(p_quote public.quotes) returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_mode text;
  v_deal public.deals;
  v_won uuid;
  v_lines_ok boolean := true;
begin
  if p_quote.deal_id is null or p_quote.addendum_of is not null then
    return null;
  end if;
  v_mode := coalesce((select s.quote_accept_deal from public.org_document_settings s
                       where s.organization_id = p_quote.organization_id), 'ask');
  if v_mode = 'none' then
    return null;
  end if;
  select * into v_deal from public.deals d
   where d.organization_id = p_quote.organization_id and d.id = p_quote.deal_id
   for update;
  if not found or v_deal.deleted_at is not null or v_deal.status <> 'open' then
    return null;
  end if;
  if v_mode = 'ask' then
    return 'להעביר את העסקה לזכייה ולעדכן את השורות?';
  end if;

  -- auto
  select s.id into v_won from public.stages s
   where s.organization_id = v_deal.organization_id and s.pipeline_id = v_deal.pipeline_id and s.kind = 'won'
   order by s.position, s.id
   limit 1;
  if v_won is null then
    return 'בתהליך המכירה של העסקה אין שלב זכייה, ולכן העסקה לא הועברה והשורות לא עודכנו.';
  end if;

  begin
    -- the lines first, so a deal whose value follows its lines is won at the quote's amount
    begin
      perform app.quote_deal_lines_replace(p_quote, v_deal.id);
    exception when others then
      v_lines_ok := false;
      raise warning 'QUO-13: deal % kept its lines; quote % could not replace them: % (%)', v_deal.id, p_quote.id, sqlerrm, sqlstate;
    end;
    update public.deals d set stage_id = v_won
     where d.organization_id = v_deal.organization_id and d.id = v_deal.id;
  exception when others then
    raise warning 'QUO-13: deal % was not moved to won for quote %: % (%)', v_deal.id, p_quote.id, sqlerrm, sqlstate;
    return 'העסקה לא הועברה לזכייה והשורות לא עודכנו. אפשר לעשות זאת מדף ההצעה.';
  end;
  return case when v_lines_ok then 'העסקה עברה לזכייה והשורות עודכנו לפי ההצעה.'
              else 'העסקה עברה לזכייה, אבל השורות לא עודכנו לפי ההצעה. אפשר לעדכן אותן בעסקה.' end;
end;
$$;
revoke all on function app.quote_accept_deal(public.quotes) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The "ask" flow: a person replaces the deal's lines, then closes it through the won window
-- ----------------------------------------------------------------------------
create or replace function public.quote_lines_to_deal(p_org uuid, p_quote uuid) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_quote public.quotes;
  v_deal public.deals;
begin
  select * into v_quote from public.quotes q where q.organization_id = p_org and q.id = p_quote;
  if not found or not app.quote_editable(p_org, v_quote.deal_id, v_quote.contact_id) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not app.org_has_feature(p_org, 'quotes') then
    raise exception 'quotes are not in this plan' using errcode = 'P0001', hint = 'feature:quotes';
  end if;
  if v_quote.status <> 'accepted' then
    raise exception 'only an accepted quote updates its deal' using errcode = 'P0001', hint = 'quote_deal:not_accepted';
  end if;
  if v_quote.deal_id is null or v_quote.addendum_of is not null then
    raise exception 'the quote has no deal to update' using errcode = 'P0001', hint = 'quote_deal:no_deal';
  end if;
  select * into v_deal from public.deals d where d.organization_id = p_org and d.id = v_quote.deal_id for update;
  if not found or v_deal.deleted_at is not null or v_deal.status <> 'open' then
    raise exception 'the deal is closed' using errcode = 'P0001', hint = 'quote_deal:closed';
  end if;
  return jsonb_build_object('lines', app.quote_deal_lines_replace(v_quote, v_deal.id));
end;
$$;
revoke all on function public.quote_lines_to_deal(uuid, uuid) from public, anon;
grant execute on function public.quote_lines_to_deal(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The won window of an accepted quote: the lines and the move in one transaction, with the person's rights
-- ----------------------------------------------------------------------------
create or replace function public.quote_win_deal(p_org uuid, p_quote uuid, p_stage uuid, p_amount_agorot bigint,
                                                 p_closed_at timestamptz, p_custom_fields jsonb default null,
                                                 p_columns jsonb default null)
returns jsonb
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_deal uuid;
  v_lines text := 'updated';
  v_hint text;
  v_count integer;
  v_close_date date;
begin
  -- DEAL-05: only the two built-in fields the won window may ask besides the amount
  if p_columns is not null then
    if jsonb_typeof(p_columns) <> 'object' then
      raise exception 'only the expected close date and the contact may be sent' using errcode = '22023', hint = 'quote_win:columns';
    end if;
    if exists (select 1 from jsonb_object_keys(p_columns) k where k not in ('expected_close_date', 'contact_id')) then
      raise exception 'only the expected close date and the contact may be sent' using errcode = '22023', hint = 'quote_win:columns';
    end if;
    -- a calendar date only, as YYYY-MM-DD: never null, 'today', 'infinity' or an impossible day
    if p_columns ? 'expected_close_date' then
      if jsonb_typeof(p_columns -> 'expected_close_date') <> 'string'
         or (p_columns ->> 'expected_close_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise exception 'the expected close date is not a date' using errcode = '22023', hint = 'quote_win:columns';
      end if;
      begin
        v_close_date := (p_columns ->> 'expected_close_date')::date;
      exception when invalid_datetime_format or datetime_field_overflow then
        raise exception 'the expected close date is not a date' using errcode = '22023', hint = 'quote_win:columns';
      end;
    end if;
  end if;
  select q.deal_id into v_deal from public.quotes q where q.organization_id = p_org and q.id = p_quote;
  if v_deal is null then
    raise exception 'the quote has no deal to update' using errcode = 'P0001', hint = 'quote_deal:no_deal';
  end if;
  begin
    perform public.quote_lines_to_deal(p_org, p_quote);
  exception when sqlstate 'P0001' then
    get stacked diagnostics v_hint = pg_exception_hint;
    if v_hint like 'deal_lines:%' or v_hint in ('feature:products', 'feature:discounts', 'feature:price_lists') then
      v_lines := v_hint;
    else
      raise;
    end if;
  end;
  update public.deals d
     set stage_id = p_stage,
         amount_agorot = p_amount_agorot,
         closed_at = p_closed_at,
         expected_close_date = case when p_columns ? 'expected_close_date' then v_close_date else d.expected_close_date end,
         contact_id = case when p_columns ? 'contact_id' then (p_columns ->> 'contact_id')::uuid else d.contact_id end,
         custom_fields = case when p_custom_fields is null then d.custom_fields else p_custom_fields end
   where d.organization_id = p_org and d.id = v_deal and d.deleted_at is null and d.status = 'open';
  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'the deal is no longer open' using errcode = 'P0001', hint = 'quote_deal:closed';
  end if;
  return jsonb_build_object('deal', v_deal, 'lines', v_lines);
end;
$$;
revoke all on function public.quote_win_deal(uuid, uuid, uuid, bigint, timestamptz, jsonb, jsonb) from public, anon;
grant execute on function public.quote_win_deal(uuid, uuid, uuid, bigint, timestamptz, jsonb, jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- The customer's answer (the body of 020455; the deal step and the notice body are new)
-- ----------------------------------------------------------------------------
create or replace function public.quote_public_decide(
  p_token text, p_decision text, p_fingerprint text,
  p_signer_name text default null, p_id_number text default null,
  p_signature_kind text default null, p_signature_image text default null,
  p_wording_version text default null, p_agreed boolean default false,
  p_decline_reason text default null, p_ip text default null, p_user_agent text default null)
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
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_link from app.quote_links l where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_quote from public.quotes q where q.organization_id = v_link.organization_id and q.id = v_link.quote_id;
  if not found or not app.quote_link_open(v_quote)
     or not app.org_public_pages_open(v_quote.organization_id)
     or not app.org_has_feature(v_quote.organization_id, 'quotes') then
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

  -- the version the page shows (QUO-12), locked against a second decision in parallel; a newer version that was sent and is
  -- now closed closes the old link too (QUO-11 review): the superseded quote is never decided on
  v_shown := app.quote_shown_version(v_quote);
  if not app.quote_link_shows(v_quote, v_shown) then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_quote from public.quotes q where q.organization_id = v_shown.organization_id and q.id = v_shown.id for update;
  if not app.quote_link_open(v_quote) then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  -- re-read after the lock: a newer version sent while this call waited (its send held this quote FOR SHARE) means the page
  -- the customer answered is no longer the one shown
  if (app.quote_shown_version(v_quote)).id is distinct from v_quote.id then
    return jsonb_build_object('status', 'changed');
  end if;
  if v_quote.status not in ('sent', 'viewed') then
    return jsonb_build_object('status', 'already_decided', 'decision', v_quote.status);
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
    insert into public.quote_decisions (organization_id, quote_id, decision, signer_name, signer_id_number, signature_kind,
                                        signature_image, wording_version, content_sha256, ip, user_agent)
    values (v_quote.organization_id, v_quote.id, 'accepted', v_name, v_id, p_signature_kind,
            case when p_signature_kind = 'drawn' then p_signature_image end, p_wording_version, p_fingerprint,
            left(nullif(btrim(coalesce(p_ip, '')), ''), 64), left(nullif(btrim(coalesce(p_user_agent, '')), ''), 500));
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
revoke all on function public.quote_public_decide(text, text, text, text, text, text, text, text, boolean, text, text, text) from public, anon, authenticated;
grant execute on function public.quote_public_decide(text, text, text, text, text, text, text, text, boolean, text, text, text) to service_role;
