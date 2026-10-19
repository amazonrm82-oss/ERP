-- =============================================================================
-- Replacing a deal's lines with an accepted quote's (QUO-13 part one)
-- =============================================================================
-- Runs by hand in the SQL Editor (the connector stops on a migration that holds a delete statement). Belongs to
-- 20261006020485_quote_accept_deal.sql; it only creates a function, so it may run before or after that one. Until this one
-- runs, the automatic step of an accepted quote
-- still moves the deal to won and its notice says the lines were not updated (the call fails into its own savepoint), and
-- public.quote_lines_to_deal and public.quote_win_deal answer an error (42883).
--
-- app.quote_deal_lines_replace(quote, deal) (definer, no grants; called only by app.quote_accept_deal and
-- public.quote_lines_to_deal, which check the deal first): removes the deal's lines and writes the quote's item lines in
-- their order, the selected optional lines only (headings and unselected options are left out), priced as on the quote:
-- quantity, unit price, line discount, the quote's VAT mode, exemption, billing, price source and list. The deal line's
-- text is the quote line's name, then " – " and its description, up to 1,000 characters. The document discount of the
-- quote is not a line and is not carried. deal_lines_check judges every line as for any writer (the person's rules when a
-- person calls through quote_lines_to_deal; the plan's flags and the deal's VAT mode for everyone); a refusal raises and
-- the caller's savepoint keeps the old lines. The deal's value follows its lines by the DLI-03 rule (statement triggers).
-- Answers how many lines were written. Safe to run twice.

create or replace function app.quote_deal_lines_replace(p_quote public.quotes, p_deal uuid) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.deal_lines l where l.organization_id = p_quote.organization_id and l.deal_id = p_deal;

  insert into public.deal_lines (organization_id, deal_id, position, product_id, description, quantity, unit_price_agorot,
                                 discount_bp, discount_agorot, price_includes_vat, vat_exempt, billing, price_source,
                                 price_list_id, currency)
  select ql.organization_id, p_deal, row_number() over (order by ql.position, ql.id), ql.product_id,
         left(btrim(ql.name) || coalesce(' – ' || nullif(btrim(ql.description), ''), ''), 1000),
         ql.quantity, ql.unit_price_agorot, ql.discount_bp, ql.discount_agorot, p_quote.prices_include_vat, ql.vat_exempt,
         ql.billing,
         -- a list deleted since keeps the price, as typed
         case when ql.price_source = 'price_list' and ql.price_list_id is null then 'manual' else ql.price_source end,
         ql.price_list_id, ql.currency
    from public.quote_lines ql
   where ql.organization_id = p_quote.organization_id and ql.quote_id = p_quote.id
     and ql.kind = 'item' and (not ql.is_optional or ql.optional_selected)
   order by ql.position, ql.id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function app.quote_deal_lines_replace(public.quotes, uuid) from public, anon, authenticated, service_role;
