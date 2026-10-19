-- QUO-15 (duplicating only; orders are not built yet): copy any quote, whatever its status, into a new draft on the
-- same deal and contact.
--
-- * public.quote_duplicate(org, quote) (definer): whoever may edit the quote's record (app.quote_editable), quotes flag.
--   The copy is a plain draft: title "עותק של …", the same deal, contact and company, the original's VAT mode, no-VAT
--   reason, document discount, notes and terms, and every line and payment step. previous_id and addendum_of are not
--   copied (a copy is neither a version nor an addendum). Validity keeps the original's span, counted from today.
-- * A line the rules no longer allow (a product that is no longer offerable, a product or a line discount or a price list
--   the plan no longer holds, a price list that was deleted) is left out, never turned into a free line; its name is
--   returned in `skipped` so the screen can say so. A document discount the plan no longer holds is left out too
--   (`discount_dropped`). Each line is written in its own savepoint, so one refused line never fails the copy; only the
--   expected refusals are caught (P0001, class 23, 42501), and any other error fails the copy as a whole.
-- * Payment steps are copied as they are (they are only names, shares and dates).
-- Answers {quote: <new id>, skipped: [line names], discount_dropped: bool}.

create or replace function public.quote_duplicate(p_org uuid, p_quote uuid) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_quote public.quotes;
  v_new uuid;
  v_today date;
  v_valid date;
  v_line public.quote_lines;
  v_skipped jsonb := '[]'::jsonb;
  v_discounts boolean;
  v_dropped boolean := false;
begin
  select * into v_quote from public.quotes q where q.organization_id = p_org and q.id = p_quote;
  if not found or not app.quote_editable(p_org, v_quote.deal_id, v_quote.contact_id) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not app.org_has_feature(p_org, 'quotes') then
    raise exception 'quotes are not in this plan' using errcode = 'P0001', hint = 'feature:quotes';
  end if;

  select (now() at time zone app.intake_zone(o.timezone))::date into v_today
    from public.organizations o where o.id = p_org;
  -- the original's validity span, from today
  v_valid := case when v_quote.valid_until is null then null else v_today + (v_quote.valid_until - v_quote.quote_date) end;

  v_discounts := app.org_has_feature(p_org, 'discounts');
  v_dropped := not v_discounts and (v_quote.discount_bp is not null or v_quote.discount_agorot is not null);

  insert into public.quotes (organization_id, title, deal_id, contact_id, company_id, valid_until, prices_include_vat,
                             no_vat_reason, no_vat_note, discount_bp, discount_agorot, notes, terms, currency)
  values (p_org, left('עותק של ' || v_quote.title, 200), v_quote.deal_id, v_quote.contact_id, v_quote.company_id, v_valid,
          v_quote.prices_include_vat, v_quote.no_vat_reason, v_quote.no_vat_note,
          case when v_discounts then v_quote.discount_bp end, case when v_discounts then v_quote.discount_agorot end,
          v_quote.notes, v_quote.terms, v_quote.currency)
  returning id into v_new;
  -- a new quote takes the business's VAT mode; the copy keeps the original's, before any line is added
  update public.quotes q set prices_include_vat = v_quote.prices_include_vat
   where q.organization_id = p_org and q.id = v_new and q.prices_include_vat is distinct from v_quote.prices_include_vat;

  for v_line in
    select * from public.quote_lines l where l.organization_id = p_org and l.quote_id = p_quote order by l.position, l.id
  loop
    begin
      insert into public.quote_lines (organization_id, quote_id, position, kind, product_id, name, description, quantity,
                                      unit_price_agorot, discount_bp, discount_agorot, vat_exempt, billing, is_optional,
                                      optional_selected, price_source, price_list_id, currency)
      values (p_org, v_new, v_line.position, v_line.kind, v_line.product_id, v_line.name, v_line.description, v_line.quantity,
              v_line.unit_price_agorot, v_line.discount_bp, v_line.discount_agorot, v_line.vat_exempt, v_line.billing,
              v_line.is_optional, v_line.optional_selected, v_line.price_source, v_line.price_list_id, v_line.currency);
    exception when sqlstate 'P0001' or integrity_constraint_violation or insufficient_privilege then
      -- the rules refuse this line today (quote_lines_check: P0001; a constraint or a foreign key: class 23; RLS: 42501):
      -- leave it out and name it. Anything else is not a refusal and fails the whole copy.
      v_skipped := v_skipped || to_jsonb(v_line.name);
    end;
  end loop;

  insert into public.quote_payment_steps (organization_id, quote_id, position, name, percent_bp, due_date, milestone)
  select s.organization_id, v_new, s.position, s.name, s.percent_bp, s.due_date, s.milestone
    from public.quote_payment_steps s
   where s.organization_id = p_org and s.quote_id = p_quote
   order by s.position, s.id;

  return jsonb_build_object('quote', v_new, 'skipped', v_skipped, 'discount_dropped', v_dropped);
end;
$$;
revoke all on function public.quote_duplicate(uuid, uuid) from public, anon;
grant execute on function public.quote_duplicate(uuid, uuid) to authenticated;
