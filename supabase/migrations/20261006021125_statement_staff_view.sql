-- =============================================================================
-- BAL-04, the owner's answers of 2 November 2026, (35) (א) and (36) (ב): the staff's PDF of a customer's statement holds
-- exactly the customer's statement (public.statement_public's content), and the business's bank details only for owners
-- and admins while the statement's TAX-02 switch is on; anyone else gets a line in their place.
-- =============================================================================
-- * public.statement_staff_view(org, contact, company) (security INVOKER, granted to authenticated): the answer of
--   public.statement_public (latest body 021115) for one customer, read with the caller's own session, so RLS decides every
--   row. No new definer, no service key.
--   - Rights, keys and partial rule: public.customer_debt_summary (BAL-01's rule: app.can_record_payments with the balances,
--     documents and payments keys; a row of the customer hidden from the caller = partial). Not allowed answers
--     {allowed: false}; partial answers {allowed: true, partial: true} and nothing else.
--   - The customer: a live contact without a company, or a live company, that the caller reads (app.statement_link_usable's
--     customer rule); else {allowed: true, partial: false, refused: 'not_found' | 'company'}.
--   - The rest copies statement_public's selection (documents, payments, totals, credit, business details per the design;
--     keep in step): with a full view the caller reads every row statement_public reads, so the answers are equal
--     (tests/db/275-statement-staff-view.test.ts compares them).
--   - `bank`: public.org_bank_details read under RLS (owners and admins only), only while show_bank_details_statement is on
--     and app.is_admin(org); never app.document_bank_snapshot (service_role only). `bank_elsewhere` is true only for a
--     reader who is not an owner or admin while the switch is on (the customer's page shows any details then; the PDF prints
--     "פרטי הבנק מופיעים בדף שהלקוח רואה"); with the switch off nobody gets the details or the line (lead's decision, 2 November 2026).
--   - `built_with` is false: the staff's file never prints the line (app.show_built_with is not the caller's to read).
-- Every statement is safe to run twice. No drops, no row removal.

create or replace function public.statement_staff_view(p_org uuid, p_contact uuid, p_company uuid) returns jsonb
language plpgsql stable security invoker
set search_path = ''
set jit = off
as $$
declare
  v_summary jsonb;
  v_org public.organizations;
  v_design public.quote_designs;
  v_settings public.org_document_settings;
  v_today date;
  v_customer text;
  v_company uuid;
  v_live boolean;
  v_show_details boolean;
  v_show_logo boolean;
  v_switch boolean;
  v_admin boolean;
  v_show_bank boolean;
  v_docs uuid[];
  v_rows jsonb;
  v_totals record;
  v_credit bigint;
  v_pays record;
  v_bank jsonb;
begin
  if (p_contact is null) = (p_company is null) then
    raise exception 'one customer: a contact or a company' using errcode = '22023';
  end if;

  -- BAL-01's rights and keys
  v_summary := public.customer_debt_summary(p_org, p_contact, p_company);
  if not coalesce((v_summary ->> 'allowed')::boolean, false) then
    return jsonb_build_object('allowed', false);
  end if;

  -- the customer as the link's rule takes it (app.statement_customer_live): live, and a contact without a company;
  -- read under RLS, so a customer the caller does not read is not found
  if p_contact is not null then
    select coalesce(nullif(btrim(c.billing_name), ''), c.full_name), c.company_id, c.deleted_at is null
      into v_customer, v_company, v_live
      from public.contacts c where c.organization_id = p_org and c.id = p_contact;
  else
    select coalesce(nullif(btrim(c.billing_name), ''), c.name), null::uuid, c.deleted_at is null
      into v_customer, v_company, v_live
      from public.companies c where c.organization_id = p_org and c.id = p_company;
  end if;
  if not coalesce(v_live, false) then
    return jsonb_build_object('allowed', true, 'partial', false, 'refused', 'not_found');
  end if;
  if v_company is not null then
    return jsonb_build_object('allowed', true, 'partial', false, 'refused', 'company');
  end if;

  -- BAL-01's partial rule (customer_debt_summary): nothing of a view that misses a row of the customer
  if coalesce((v_summary ->> 'partial')::boolean, true) then
    return jsonb_build_object('allowed', true, 'partial', true);
  end if;

  select * into v_org from public.organizations o where o.id = p_org;
  select * into v_design from public.quote_designs d where d.organization_id = p_org;
  select * into v_settings from public.org_document_settings s where s.organization_id = p_org;
  -- QUO-05: no design row = the defaults (logo and business details shown)
  v_show_details := coalesce(v_design.show_business_details, true);
  v_show_logo := coalesce(v_design.show_logo, true);
  v_today := (now() at time zone coalesce(v_org.timezone, 'Asia/Jerusalem'))::date;

  -- public.statement_public's selection from here on (keep in step): BAL-02's scope, a contact without a company = its own
  -- documents; a company = its own, its contacts' and its deals'
  select coalesce(array_agg(d.id), '{}'::uuid[]) into v_docs
    from public.accounting_documents d
   where d.organization_id = p_org
     and d.doc_type in ('tax_invoice', 'proforma', 'opening_balance') and d.status = 'active' and d.amount_agorot > 0
     and ((p_contact is not null and d.contact_id = p_contact)
          or (p_company is not null
              and (d.company_id = p_company
                   or d.contact_id in (select c.id from public.contacts c
                                        where c.organization_id = p_org and c.company_id = p_company)
                   or d.deal_id in (select x.id from public.deals x
                                     where x.organization_id = p_org and x.company_id = p_company))));

  with balances as (
    select (x ->> 'id')::uuid as id, coalesce((x ->> 'balance')::bigint, 0) as balance
      from jsonb_array_elements(public.money_allocation_state(p_org, v_docs, '{}'::uuid[]) -> 'documents') x
  ),
  open_docs as (
    select d.doc_type, d.number, d.doc_date, d.due_date, d.amount_agorot, b.balance, d.created_at, d.id,
           case when d.due_date < v_today then v_today - d.due_date else 0 end as overdue_days
      from public.accounting_documents d
      join balances b on b.id = d.id
     where d.organization_id = p_org and d.id = any (v_docs) and b.balance > 0
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
  v_credit := coalesce((public.money_customer_credit(p_org, null, p_contact, p_company) ->> 'total')::bigint, 0);

  -- payments received in the last 12 months (paid_on in the business's zone), the documents' customer scope; recorded or
  -- confirmed only; the date, the method code and the amount only
  with pays as (
    select p.paid_on, p.method, p.amount_agorot, p.created_at, p.id
      from public.payments p
     where p.organization_id = p_org
       and p.status in ('recorded', 'confirmed')
       and p.paid_on > (v_today - interval '12 months')::date and p.paid_on <= v_today
       and ((p_contact is not null and p.contact_id = p_contact)
            or (p_company is not null
                and (p.contact_id in (select c.id from public.contacts c
                                       where c.organization_id = p_org and c.company_id = p_company)
                     or p.deal_id in (select x.id from public.deals x
                                       where x.organization_id = p_org and x.company_id = p_company))))
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

  -- BAL-04 answer (35) (א): the bank details for owners and admins only, while the statement's switch is on; read under
  -- RLS (org_bank_details_select = app.is_admin), in app.document_bank_snapshot's shape (keep in step)
  v_switch := coalesce(v_design.show_bank_details_statement, true);
  v_admin := app.is_admin(p_org);
  v_show_bank := v_switch and v_admin;
  if v_show_bank then
    select jsonb_build_object(
             'bank_name', b.bank_name,
             'bank_branch', b.bank_branch,
             'bank_account', b.bank_account,
             'bank_account_name', b.bank_account_name)
      into v_bank
      from public.org_bank_details b
     where b.organization_id = p_org and b.bank_account is not null;
  end if;

  return jsonb_build_object(
    'allowed', true,
    'partial', false,
    'business', jsonb_build_object(
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
    'bank_elsewhere', v_switch and not v_admin,
    'totals', jsonb_build_object('open_agorot', v_totals.open_agorot, 'overdue_agorot', v_totals.overdue_agorot,
                                 'credit_agorot', v_credit),
    'built_with', false);
end;
$$;
revoke all on function public.statement_staff_view(uuid, uuid, uuid) from public, anon;
grant execute on function public.statement_staff_view(uuid, uuid, uuid) to authenticated;

-- keep in step: the two functions select the same documents, payments, totals and credit (comments, so statement_public's body
-- stays as 021115 left it)
comment on function public.statement_staff_view(uuid, uuid, uuid) is
  'BAL-04 staff PDF: statement_public''s answer for one customer under the caller''s RLS; keep its selection in step with public.statement_public (test 275).';
comment on function public.statement_public(text, text) is
  'BAL-04 customer page: keep its documents, payments, totals and credit selection in step with public.statement_staff_view (test 275).';
