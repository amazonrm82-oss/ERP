-- =============================================================================
-- A currency column next to every amount, shekels only for now (TAX-06, wave 2)
-- =============================================================================
-- Money is integer agorot plus a currency code. Tables that hold an amount today:
--   deals.amount_agorot      deals.currency char(3) not null default 'ILS' (since
--                            crm_core): the column stays; it gets the same
--                            ILS-only check as leads (deals_currency_ils).
--   leads.budget_agorot      had no currency: added here.
--   organizations.currency   the business's own currency (since foundation),
--                            not an amount: left as it is.
--   plans.price_*_agorot     the platform's own price list (shared ground, our
--                            billing in shekels): not touched.
--   goals.target             agorot only for the won_amount metric (a count for
--                            the others): not touched, see the report.
-- New money tables (products, price lists, quotes, orders, documents, payments;
-- later waves) each carry `currency text not null default 'ILS'
-- check (currency = 'ILS')` from their first migration. Several currencies
-- (DEAL-12, wave 6) will lift the check and add exchange rates.
--
-- leads.currency: the currency of budget_agorot. Text, not null, 'ILS' only.
-- leads has column-level grants (0038), so the new column gets its own: a
-- client may send it (only 'ILS' passes the check) and nothing else changes.
-- Adding a constant default does not rewrite the table (PostgreSQL 11+); the
-- checks read the tables once (hosted deals were all ILS when checked read-only).
-- Merge (merge_records) does not pick currency today: with one currency there is
-- nothing to pick. When wave 6 lifts the ILS checks, leads.currency must travel
-- with budget_agorot in a merge (a companion in app.merge_columns() and
-- MERGE_COMPANIONS), and any code that copies a deal amount copies its currency.
--
-- app.sample_row() (USR-04, last redefined in deal_loss_reasons) ignores a key
-- missing from a sample note's snapshot only while it is null. Sample leads
-- noted before this migration have no 'currency' key while their row now
-- holds 'ILS', so they would look touched and never be removed. Redefined
-- here: a missing 'currency' key is also ignored while it holds 'ILS' (the
-- only value it can hold). Test 64 re-runs this file last.
-- Every statement is safe to run twice.

alter table public.leads add column if not exists currency text not null default 'ILS';

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.leads'::regclass and conname = 'leads_currency_ils') then
    alter table public.leads add constraint leads_currency_ils check (currency = 'ILS');
  end if;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.deals'::regclass and conname = 'deals_currency_ils') then
    alter table public.deals add constraint deals_currency_ils check (currency = 'ILS');
  end if;
end;
$$;

comment on column public.leads.currency is
  'TAX-06: the currency of budget_agorot. Shekels only (ILS) until several currencies (wave 6).';

grant insert (currency), update (currency) on public.leads to authenticated;

create or replace function app.sample_row(p_org uuid, p_type text, p_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
-- timestamps in the snapshot must not depend on the caller's time zone
set timezone = 'UTC'
as $$
declare
  v_row jsonb;
  v_snapshot jsonb;
begin
  if p_type not in ('lead', 'contact', 'company', 'deal', 'task') then
    raise exception 'unknown record type' using errcode = '22023';
  end if;
  execute format('select to_jsonb(t) - array[''updated_at'', ''updated_by'', ''deleted_at''] from public.%I t where t.organization_id = $1 and t.id = $2',
                 case p_type when 'lead' then 'leads' when 'contact' then 'contacts' when 'company' then 'companies'
                             when 'deal' then 'deals' else 'tasks' end)
    into v_row using p_org, p_id;
  if v_row is null then
    return null;
  end if;
  -- a column added after the snapshot was taken is left out while it is null,
  -- and leads.currency (TAX-06) while it holds its only value
  select s.snapshot into v_snapshot
    from app.sample_records s
   where s.organization_id = p_org
     and app.sample_note_type(s) = p_type
     and coalesce(s.lead_id, s.contact_id, s.company_id, s.deal_id, s.task_id) = p_id
   limit 1;
  if v_snapshot is not null and jsonb_typeof(v_snapshot) = 'object' then
    select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into v_row
      from jsonb_each(v_row) e
     where v_snapshot ? e.key
        or not (e.value = 'null'::jsonb or (p_type = 'lead' and e.key = 'currency' and e.value = '"ILS"'::jsonb));
  end if;
  return v_row;
end;
$$;
revoke all on function app.sample_row(uuid, text, uuid) from public, anon, authenticated;
