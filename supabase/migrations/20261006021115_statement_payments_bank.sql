-- =============================================================================
-- BAL-04, the owner's answers of 1 November 2026, (2) (ב) and (4) (ב): the customer's statement page also lists the payments
-- received in the last 12 months, and shows the business's bank details for a transfer by a TAX-02 switch of its own.
-- =============================================================================
-- * public.quote_designs.show_bank_details_statement  boolean not null default true (owner: "לפי מתג של TAX-02 לדף החשבון,
--   כמו המתגים להצעה ולהזמנה"); column grants like show_bank_details_quote / _order (021087). Old code that
--   never sends it keeps working (the default).
-- * public.statement_public (latest body 021114) is redefined only to add, after every check, limit and the documents part of
--   021114 (unchanged):
--   - `payments`: the customer's payments (the same scope as the documents and BAL-01's ledger: a contact without a company =
--     payments on the contact; a company = payments on its contacts and on its deals) whose status is recorded or confirmed
--     and whose paid_on falls in the last 12 months in the business's zone (after today minus 12 months, up to today). Each:
--     paid_on, the method's code (the page prints its label; a cheque is only "צ'ק") and the amount. Never the reference, the
--     note, a cheque's number, bank, branch or due date, the status, an id or an allocation. Newest first, at most 500;
--     `payments_more` counts the rest.
--   - `bank`: app.document_bank_snapshot(org) read at view time (the statement is not an issued document, so nothing is
--     stored), only while show_bank_details_statement is on (no design row = on); null otherwise or when the business has no
--     account. app.document_bank_snapshot is granted to service_role only; this function (security definer, service_role only)
--     runs it as its owner. Nothing here writes audit_log or a log line, so the account number reaches neither.
-- Every statement is safe to run twice. No drops, no row removal.

alter table public.quote_designs add column if not exists show_bank_details_statement boolean not null default true;
grant insert (show_bank_details_statement) on public.quote_designs to authenticated;
grant update (show_bank_details_statement) on public.quote_designs to authenticated;

create or replace function public.statement_public(p_token text, p_ip_hash text default null) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_link app.statement_links;
  v_org public.organizations;
  v_design public.quote_designs;
  v_settings public.org_document_settings;
  v_count integer;
  v_bucket integer;
  v_views integer;
  v_today date;
  v_customer text;
  v_show_details boolean;
  v_show_logo boolean;
  v_docs uuid[];
  v_rows jsonb;
  v_totals record;
  v_credit bigint;
  v_built_with boolean;
  v_pays record;
  v_bank jsonb;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'statement not found' using errcode = 'P0002';
  end if;
  select * into v_link from app.statement_links l where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found or not app.statement_link_usable(v_link) then
    raise exception 'statement not found' using errcode = 'P0002';
  end if;

  -- 120 views per link in 10 minutes; counted (one row update) before the page's data is read, so the limit holds under
  -- parallel load
  update app.statement_links l
     set window_started_at = case when l.window_started_at > now() - interval '10 minutes' then l.window_started_at else now() end,
         window_count = case when l.window_started_at > now() - interval '10 minutes' then l.window_count + 1 else 1 end
   where l.id = v_link.id
  returning l.window_count into v_count;
  if v_count > 120 then
    return jsonb_build_object('rate_limited', true);
  end if;
  -- FXS-11: 60 views per sender in 10 minutes, by the server's keyed IP hash scoped to this link
  if p_ip_hash is not null then
    v_bucket := ((hashtextextended(app.statement_link_sender(v_link.id, p_ip_hash), 0) % 1024) + 1024) % 1024;
    insert into app.statement_link_view_counts as vc (link_id, bucket, window_start, views)
    values (v_link.id, v_bucket, now(), 1)
    on conflict (link_id, bucket) do update
      set window_start = case when vc.window_start > now() - interval '10 minutes' then vc.window_start else now() end,
          views = case when vc.window_start > now() - interval '10 minutes' then vc.views + 1 else 1 end
    returning vc.views into v_views;
    if v_views > 60 then
      return jsonb_build_object('rate_limited', true);
    end if;
  end if;

  select * into v_org from public.organizations o where o.id = v_link.organization_id;
  select * into v_design from public.quote_designs d where d.organization_id = v_link.organization_id;
  select * into v_settings from public.org_document_settings s where s.organization_id = v_link.organization_id;
  -- QUO-05: no design row = the defaults (logo and business details shown)
  v_show_details := coalesce(v_design.show_business_details, true);
  v_show_logo := coalesce(v_design.show_logo, true);
  v_today := (now() at time zone coalesce(v_org.timezone, 'Asia/Jerusalem'))::date;

  -- the customer as documents name it (CON-08): the billing name, else the name
  if v_link.contact_id is not null then
    select coalesce(nullif(btrim(c.billing_name), ''), c.full_name) into v_customer
      from public.contacts c where c.organization_id = v_link.organization_id and c.id = v_link.contact_id;
  else
    select coalesce(nullif(btrim(c.billing_name), ''), c.name) into v_customer
      from public.companies c where c.organization_id = v_link.organization_id and c.id = v_link.company_id;
  end if;

  -- BAL-02's scope (public.customer_debt_summary / public.customer_ledger; keep in step): a contact without a company =
  -- its own documents; a company = its own, its contacts' and its deals'
  select coalesce(array_agg(d.id), '{}'::uuid[]) into v_docs
    from public.accounting_documents d
   where d.organization_id = v_link.organization_id
     and d.doc_type in ('tax_invoice', 'proforma', 'opening_balance') and d.status = 'active' and d.amount_agorot > 0
     and ((v_link.contact_id is not null and d.contact_id = v_link.contact_id)
          or (v_link.company_id is not null
              and (d.company_id = v_link.company_id
                   or d.contact_id in (select c.id from public.contacts c
                                        where c.organization_id = v_link.organization_id and c.company_id = v_link.company_id)
                   or d.deal_id in (select x.id from public.deals x
                                     where x.organization_id = v_link.organization_id and x.company_id = v_link.company_id))));

  with balances as (
    select (x ->> 'id')::uuid as id, coalesce((x ->> 'balance')::bigint, 0) as balance
      from jsonb_array_elements(public.money_allocation_state(v_link.organization_id, v_docs, '{}'::uuid[]) -> 'documents') x
  ),
  open_docs as (
    select d.doc_type, d.number, d.doc_date, d.due_date, d.amount_agorot, b.balance, d.created_at, d.id,
           case when d.due_date < v_today then v_today - d.due_date else 0 end as overdue_days
      from public.accounting_documents d
      join balances b on b.id = d.id
     where d.organization_id = v_link.organization_id and d.id = any (v_docs) and b.balance > 0
  ),
  ranked as (
    select o.*, row_number() over (order by o.due_date nulls last, o.doc_date, o.created_at, o.id) as n from open_docs o
  )
  select coalesce(sum(r.balance), 0)::bigint as open_agorot,
         coalesce(sum(r.balance) filter (where r.due_date < v_today), 0)::bigint as overdue_agorot,
         count(*) filter (where r.n > 500) as more,
         coalesce(jsonb_agg(jsonb_build_object(
           'type', r.doc_type,
           'number', r.number,
           'doc_date', r.doc_date,
           'due_date', r.due_date,
           'amount_agorot', r.amount_agorot,
           'balance_agorot', r.balance,
           'overdue_days', r.overdue_days) order by r.n) filter (where r.n <= 500), '[]'::jsonb) as rows
    into v_totals
    from ranked r;
  v_rows := v_totals.rows;

  -- PAY-03: the customer's credit, a separate figure (never netted into the debt here)
  v_credit := coalesce((public.money_customer_credit(v_link.organization_id, null, v_link.contact_id, v_link.company_id) ->> 'total')::bigint, 0);

  -- BAL-04 answer (2) (ב): payments received in the last 12 months (paid_on in the business's zone), the same customer
  -- scope as the documents and BAL-01's ledger (keep in step): a contact without a company = its own payments; a company =
  -- its contacts' and its deals' payments. Recorded or confirmed only; the date, the method code and the amount only.
  with pays as (
    select p.paid_on, p.method, p.amount_agorot, p.created_at, p.id
      from public.payments p
     where p.organization_id = v_link.organization_id
       and p.status in ('recorded', 'confirmed')
       and p.paid_on > (v_today - interval '12 months')::date and p.paid_on <= v_today
       and ((v_link.contact_id is not null and p.contact_id = v_link.contact_id)
            or (v_link.company_id is not null
                and (p.contact_id in (select c.id from public.contacts c
                                       where c.organization_id = v_link.organization_id and c.company_id = v_link.company_id)
                     or p.deal_id in (select x.id from public.deals x
                                       where x.organization_id = v_link.organization_id and x.company_id = v_link.company_id))))
  ),
  ranked_pays as (
    select y.*, row_number() over (order by y.paid_on desc, y.created_at desc, y.id) as n from pays y
  )
  select count(*) filter (where r.n > 500) as more,
         coalesce(jsonb_agg(jsonb_build_object(
           'paid_on', r.paid_on,
           'method', r.method,
           'amount_agorot', r.amount_agorot) order by r.n) filter (where r.n <= 500), '[]'::jsonb) as rows
    into v_pays
    from ranked_pays r;

  -- BAL-04 answer (4) (ב): the business's bank details, read now (nothing stored), while the statement's TAX-02 switch is
  -- on (no design row = on)
  if coalesce(v_design.show_bank_details_statement, true) then
    v_bank := app.document_bank_snapshot(v_link.organization_id);
  end if;

  begin
    v_built_with := coalesce(app.show_built_with(v_link.organization_id), true);
  exception when others then
    v_built_with := true;
  end;

  return jsonb_build_object(
    'business', jsonb_build_object(
      -- the display name (customer-facing communication); the registered one with the details, as on documents
      'name', v_org.name,
      'legal_name', case when v_show_details then nullif(btrim(v_settings.legal_name), '') end,
      'tax_id', case when v_show_details then v_settings.tax_id end,
      'address_line', case when v_show_details then v_settings.address_line end,
      'city', case when v_show_details then v_settings.city end,
      'postal_code', case when v_show_details then v_settings.postal_code end,
      'phone', case when v_show_details then v_settings.phone end,
      'email', case when v_show_details then v_settings.email end),
    'brand', jsonb_build_object('logo', case when v_show_logo then v_org.logo_path end,
                                'color', coalesce(v_design.accent_color, v_org.brand_color)),
    'customer', jsonb_build_object('name', v_customer),
    'today', v_today,
    'currency', 'ILS',
    'documents', v_rows,
    'more', v_totals.more,
    'payments', v_pays.rows,
    'payments_more', v_pays.more,
    'bank', v_bank,
    'totals', jsonb_build_object('open_agorot', v_totals.open_agorot, 'overdue_agorot', v_totals.overdue_agorot,
                                 'credit_agorot', v_credit),
    'built_with', v_built_with);
end;
$$;
revoke all on function public.statement_public(text, text) from public, anon, authenticated;
grant execute on function public.statement_public(text, text) to service_role;
