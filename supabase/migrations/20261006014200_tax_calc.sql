-- =============================================================================
-- Document totals: discounts, VAT, rounding (TAX-05, wave 2)
-- =============================================================================
-- app.document_totals(lines, rate_bp, prices_include_vat, discount_bp,
-- discount_agorot, round_to_shekel) computes the totals of a quote, order or
-- document. It mirrors documentTotals() in src/features/tax/calc.ts exactly
-- (test 94-document-totals compares the two on many cases): change both
-- together. The method is written out in that file; in short:
--   * integer agorot and basis points only; every rounding is half up;
--   * line amount = round(unit price x quantity) (quantity: up to 3 decimals),
--     then the line discount (basis points OR agorot, not both);
--   * document discount on the sum of the lines (basis points OR agorot),
--     split between taxable and exempt lines in proportion (taxable share
--     rounded, exempt share = the rest); discounts come before VAT;
--   * VAT once, on the taxable sum after all discounts, rounded at document
--     level. Line with vat_exempt = true carries no VAT (product exempt or
--     zero rate). There is no whole-document exemption: a business that charges
--     no VAT passes rate 0 (app.org_document_vat_rate());
--   * prices including VAT (TAX-04): discounts come off the gross prices; the
--     taxable gross G is what the customer pays; taxable = round(G x 10000 /
--     (10000 + rate)), VAT = G - taxable. Line nets: floor of gross x 10000 /
--     (10000 + rate), and the agorot left go to the largest remainders
--     (earlier line first on a tie);
--   * optional rounding line to a whole shekel, after VAT.
-- Lines: a jsonb array (at most 500) of objects
--   {quantity, unit_price_agorot, discount_bp?, discount_agorot?, vat_exempt?}.
-- Errors: SQLSTATE 22023, hint 'totals:invalid', message
--   'invalid document totals: <code>[ at line <0-based index>]', where <code> is
--   rate | lines | quantity | price | amount | discount | discount_too_large.
-- Pure (immutable, reads no table), security invoker. The document modules call
-- it when they save, so stored totals come from the database, never from the
-- browser.
--
-- app.org_document_vat_rate(org, date): the rate a document of that day uses:
-- 0 when the business charges no VAT (TAX-01), the day's rate when it does
-- (app.document_vat_rate(), TAX-03, which refuses a day before the table), and
-- null while the VAT status is not set (the document asks; owner, 13 October
-- 2026). Mirrors documentVatRateBp(documentVat(...)) in the app.
-- Every statement is safe to run twice.

create or replace function app.document_totals(
  p_lines jsonb,
  p_rate_bp integer,
  p_prices_include_vat boolean,
  p_discount_bp integer default null,
  p_discount_agorot bigint default null,
  p_round_to_shekel boolean default false
) returns jsonb
language plpgsql immutable
set search_path = ''
as $$
declare
  c_max_lines constant integer := 500;
  c_max_qty constant numeric := 1000000;
  c_max_amount constant numeric := 1000000000000;
  c_max_price constant numeric := 9007199254740991;
  v_gross boolean := coalesce(p_prices_include_vat, false);
  v_line jsonb;
  v_index integer;
  v_qty numeric;
  v_price numeric;
  v_amount numeric;
  v_discount numeric;
  v_dbp jsonb;
  v_dag jsonb;
  v_exempt boolean;
  v_amounts numeric[] := '{}';
  v_discounts numeric[] := '{}';
  v_totals numeric[] := '{}';
  v_nets numeric[] := '{}';
  v_exempts boolean[] := '{}';
  v_taxable_sum numeric := 0;
  v_exempt_sum numeric := 0;
  v_subtotal numeric;
  v_doc_discount numeric := 0;
  v_discount_taxable numeric;
  v_discount_exempt numeric;
  v_taxable_after numeric;
  v_exempt_after numeric;
  v_taxable numeric;
  v_vat numeric;
  v_net_before numeric;
  v_den numeric;
  v_left numeric;
  v_pick record;
  v_total_before numeric;
  v_total numeric;
  v_lines_out jsonb := '[]';
  i integer;
begin
  if p_rate_bp is null or p_rate_bp < 0 or p_rate_bp > 10000 then
    raise exception 'invalid document totals: rate' using errcode = '22023', hint = 'totals:invalid';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) > c_max_lines then
    raise exception 'invalid document totals: lines' using errcode = '22023', hint = 'totals:invalid';
  end if;

  for v_line, v_index in select e.value, (e.n - 1)::integer from jsonb_array_elements(p_lines) with ordinality as e(value, n)
  loop
    if jsonb_typeof(v_line) <> 'object'
       or (v_line ? 'vat_exempt' and jsonb_typeof(v_line -> 'vat_exempt') not in ('boolean', 'null')) then
      raise exception 'invalid document totals: lines at line %', v_index using errcode = '22023', hint = 'totals:invalid';
    end if;
    v_exempt := coalesce((v_line ->> 'vat_exempt')::boolean, false);

    -- quantity: a positive number with at most 3 decimals, at most 1,000,000
    if jsonb_typeof(v_line -> 'quantity') is distinct from 'number' then
      raise exception 'invalid document totals: quantity at line %', v_index using errcode = '22023', hint = 'totals:invalid';
    end if;
    v_qty := (v_line ->> 'quantity')::numeric;
    if v_qty <= 0 or v_qty > c_max_qty or v_qty * 1000 <> trunc(v_qty * 1000) then
      raise exception 'invalid document totals: quantity at line %', v_index using errcode = '22023', hint = 'totals:invalid';
    end if;

    if jsonb_typeof(v_line -> 'unit_price_agorot') is distinct from 'number' then
      raise exception 'invalid document totals: price at line %', v_index using errcode = '22023', hint = 'totals:invalid';
    end if;
    v_price := (v_line ->> 'unit_price_agorot')::numeric;
    if v_price < 0 or v_price > c_max_price or v_price <> trunc(v_price) then
      raise exception 'invalid document totals: price at line %', v_index using errcode = '22023', hint = 'totals:invalid';
    end if;

    -- round half up: div() rounds toward zero, and everything here is >= 0
    v_amount := div(2 * v_price * (v_qty * 1000) + 1000, 2000);
    if v_amount > c_max_amount then
      raise exception 'invalid document totals: amount at line %', v_index using errcode = '22023', hint = 'totals:invalid';
    end if;

    v_dbp := nullif(v_line -> 'discount_bp', 'null'::jsonb);
    v_dag := nullif(v_line -> 'discount_agorot', 'null'::jsonb);
    if v_dbp is not null and v_dag is not null then
      raise exception 'invalid document totals: discount at line %', v_index using errcode = '22023', hint = 'totals:invalid';
    elsif v_dbp is not null then
      if jsonb_typeof(v_dbp) <> 'number' or (v_dbp #>> '{}')::numeric not between 0 and 10000
         or (v_dbp #>> '{}')::numeric <> trunc((v_dbp #>> '{}')::numeric) then
        raise exception 'invalid document totals: discount at line %', v_index using errcode = '22023', hint = 'totals:invalid';
      end if;
      v_discount := div(2 * v_amount * (v_dbp #>> '{}')::numeric + 10000, 20000);
    elsif v_dag is not null then
      if jsonb_typeof(v_dag) <> 'number' or (v_dag #>> '{}')::numeric not between 0 and c_max_amount
         or (v_dag #>> '{}')::numeric <> trunc((v_dag #>> '{}')::numeric) then
        raise exception 'invalid document totals: discount at line %', v_index using errcode = '22023', hint = 'totals:invalid';
      end if;
      v_discount := (v_dag #>> '{}')::numeric;
      if v_discount > v_amount then
        raise exception 'invalid document totals: discount_too_large at line %', v_index using errcode = '22023', hint = 'totals:invalid';
      end if;
    else
      v_discount := 0;
    end if;

    v_amounts := v_amounts || v_amount;
    v_discounts := v_discounts || v_discount;
    v_totals := v_totals || (v_amount - v_discount);
    v_nets := v_nets || (v_amount - v_discount);
    v_exempts := v_exempts || v_exempt;
    if v_exempt then
      v_exempt_sum := v_exempt_sum + (v_amount - v_discount);
    else
      v_taxable_sum := v_taxable_sum + (v_amount - v_discount);
    end if;
  end loop;

  v_subtotal := v_taxable_sum + v_exempt_sum;

  if p_discount_bp is not null and p_discount_agorot is not null then
    raise exception 'invalid document totals: discount' using errcode = '22023', hint = 'totals:invalid';
  elsif p_discount_bp is not null then
    if p_discount_bp not between 0 and 10000 then
      raise exception 'invalid document totals: discount' using errcode = '22023', hint = 'totals:invalid';
    end if;
    v_doc_discount := div(2 * v_subtotal * p_discount_bp + 10000, 20000);
  elsif p_discount_agorot is not null then
    if p_discount_agorot not between 0 and c_max_amount then
      raise exception 'invalid document totals: discount' using errcode = '22023', hint = 'totals:invalid';
    end if;
    if p_discount_agorot > v_subtotal then
      raise exception 'invalid document totals: discount_too_large' using errcode = '22023', hint = 'totals:invalid';
    end if;
    v_doc_discount := p_discount_agorot;
  end if;

  v_discount_taxable := case when v_subtotal > 0
                             then div(2 * v_doc_discount * v_taxable_sum + v_subtotal, 2 * v_subtotal)
                             else 0 end;
  v_discount_exempt := v_doc_discount - v_discount_taxable;
  v_taxable_after := v_taxable_sum - v_discount_taxable;
  v_exempt_after := v_exempt_sum - v_discount_exempt;

  if v_gross then
    v_den := 10000 + p_rate_bp;
    v_taxable := div(2 * v_taxable_after * 10000 + v_den, 2 * v_den);
    v_vat := v_taxable_after - v_taxable;
    v_net_before := div(2 * v_taxable_sum * 10000 + v_den, 2 * v_den);
    -- each taxable line: the floor of its net; the agorot left go to the largest remainders
    v_left := v_net_before;
    for i in 1 .. coalesce(array_length(v_totals, 1), 0) loop
      if not v_exempts[i] then
        v_nets[i] := div(v_totals[i] * 10000, v_den);
        v_left := v_left - v_nets[i];
      end if;
    end loop;
    for v_pick in
      select t.n
        from unnest(v_totals, v_exempts) with ordinality as t(total, exempt, n)
       where not t.exempt
       order by mod(t.total * 10000, v_den) desc, t.n
       limit greatest(v_left, 0)::bigint
    loop
      v_nets[v_pick.n] := v_nets[v_pick.n] + 1;
    end loop;
  else
    v_taxable := v_taxable_after;
    v_vat := div(2 * v_taxable * p_rate_bp + 10000, 20000);
    v_net_before := v_taxable_sum;
  end if;

  v_total_before := v_taxable + v_exempt_after + v_vat;
  v_total := case when coalesce(p_round_to_shekel, false) then div(2 * v_total_before + 100, 200) * 100 else v_total_before end;

  for i in 1 .. coalesce(array_length(v_totals, 1), 0) loop
    v_lines_out := v_lines_out || jsonb_build_array(jsonb_build_object(
      'amount_agorot', v_amounts[i],
      'discount_agorot', v_discounts[i],
      'total_agorot', v_totals[i],
      'net_agorot', v_nets[i],
      'vat_exempt', v_exempts[i]));
  end loop;

  return jsonb_build_object(
    'lines', v_lines_out,
    'subtotal_agorot', v_subtotal,
    'document_discount_agorot', v_doc_discount,
    'net_subtotal_agorot', v_net_before + v_exempt_sum,
    'net_discount_agorot', v_net_before - v_taxable + v_discount_exempt,
    'taxable_agorot', v_taxable,
    'exempt_agorot', v_exempt_after,
    'net_total_agorot', v_taxable + v_exempt_after,
    'vat_agorot', v_vat,
    'total_before_rounding_agorot', v_total_before,
    'rounding_agorot', v_total - v_total_before,
    'total_agorot', v_total,
    'rate_bp', p_rate_bp,
    'prices_include_vat', v_gross);
end;
$$;
revoke all on function app.document_totals(jsonb, integer, boolean, integer, bigint, boolean) from public, anon;
grant execute on function app.document_totals(jsonb, integer, boolean, integer, bigint, boolean) to authenticated, service_role;

-- The rate a document of this organization and day uses: 0 = no VAT (the
-- business does not charge it), null = the VAT status is not set yet.
-- Security invoker, like app.org_charges_vat(): the caller's rights decide.
create or replace function app.org_document_vat_rate(p_org uuid, p_date date) returns integer
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_charges boolean := app.org_charges_vat(p_org);
begin
  if v_charges is null then
    return null;
  end if;
  if not v_charges then
    return 0;
  end if;
  return app.document_vat_rate(p_date);
end;
$$;
revoke all on function app.org_document_vat_rate(uuid, date) from public, anon;
grant execute on function app.org_document_vat_rate(uuid, date) to authenticated, service_role;
