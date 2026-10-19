-- =============================================================================
-- QUO-13: the deal's amount follows the accepted quote's total (owner, 19 October 2026, answer (ב))
-- =============================================================================
-- Deal lines carry no document discount, so a deal valued by its lines came out above what the customer accepted.
-- When an accepted quote moves its deal (the automatic step, or the won window of the "ask" flow), the deal's amount is
-- the quote's net_total_agorot: its total BEFORE VAT, after the document discount. Deal values are before VAT
-- everywhere (DLI-03 sums the lines before VAT; the amount hint says so), so the total with VAT would not compare.
-- The amount is a typed value under DEAL-07/DLI-03: amount_auto turns off and amount_source is null; emptying it in the
-- deal form brings the computed value back, as for any typed amount.
--
-- The mark "(לפי הצעה מס' X)" survives a refresh as one nullable column, the smallest shape that can say which quote:
-- * deals.amount_quote_id: composite FK to quotes, on delete set null of the column; indexed.
-- * trigger deals_amount_quote (definer, before insert or update, fires after deals_amount_auto by name, so it sees the
--   final amount) keeps the mark only while it is true: on insert it is always null; on update a mark is kept only when
--   the quote is accepted, belongs to this deal and its net_total_agorot equals the deal's amount, else it is cleared
--   (never an error). So any other change of the amount (a person, the lines while the value is computed, a merge)
--   clears it, and a person's write of the column (granted, for the won window's invoker update) can only state a fact.
-- * app.quote_accept_deal and public.quote_win_deal are redefined from 020485 to write the amount and the mark in the
--   same update as the move. The won window prefills the quote's total; a different typed amount loses the mark.
-- Additive only; safe to run twice.

alter table public.deals add column if not exists amount_quote_id uuid;
alter table public.deals drop constraint if exists deals_amount_quote_fk;
alter table public.deals add constraint deals_amount_quote_fk foreign key (organization_id, amount_quote_id)
  references public.quotes (organization_id, id) on delete set null (amount_quote_id);
create index if not exists deals_amount_quote_idx on public.deals (organization_id, amount_quote_id);
grant update (amount_quote_id) on public.deals to authenticated;

create or replace function app.deals_amount_quote() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.amount_quote_id := null;
    return new;
  end if;
  if new.amount_quote_id is not null
     and not exists (select 1 from public.quotes q
                      where q.organization_id = new.organization_id and q.id = new.amount_quote_id
                        and q.status = 'accepted' and q.deal_id = new.id
                        and q.net_total_agorot is not distinct from new.amount_agorot) then
    new.amount_quote_id := null;
  end if;
  return new;
end;
$$;
revoke all on function app.deals_amount_quote() from public, anon, authenticated;

-- named to fire after deals_amount_auto (triggers fire in name order), so it judges the amount as stored
create or replace trigger deals_amount_quote before insert or update on public.deals
  for each row execute function app.deals_amount_quote();

-- ----------------------------------------------------------------------------
-- The automatic step (the body of 020485; the amount and its mark are new)
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
    -- the deal's amount is the quote's total before VAT, after its document discount (owner, 19 October 2026), marked
    -- with the quote (deals_amount_quote keeps the mark only while it is true)
    update public.deals d set stage_id = v_won, amount_agorot = p_quote.net_total_agorot, amount_quote_id = p_quote.id
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
-- The won window of an accepted quote (the body of 020485; the mark is new)
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
         custom_fields = case when p_custom_fields is null then d.custom_fields else p_custom_fields end,
         -- the mark "by quote N": kept by deals_amount_quote only when the amount is that quote's total
         amount_quote_id = p_quote
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
