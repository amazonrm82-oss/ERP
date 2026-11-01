-- =============================================================================
-- BAL-04: the customer's statement page through a secret link ("דף חשבון ללקוח": the open debts, itemized). The link
-- now; the PDF waits for the PDF module's turn (BACKLOG, "כסף").
-- =============================================================================
-- The approved pattern for public secret-link pages (CLAUDE.md hard rule 5; owner, 8 October 2026, BAL-04 named), as
-- ORD-05's order link: the page's server file calls one security definer function granted to service_role only, which
-- checks the token and answers only what the page shows; no table is reached directly with the service key.
--
-- * The customer is BAL-02's (PAY-02's customer, as public.customer_debt_summary and public.customer_ledger take it): a
--   contact WITHOUT a company (its own documents), or a company (its own opening balance and every document of its
--   contacts and deals). A contact with a company has its company's figures, so its link lives on the company: making a
--   link for such a contact is refused (hint statement_link:company), and a contact link stops working (not found) once
--   the contact joins a company, so it never shows a company's documents to whoever holds a contact's link.
-- * app.statement_links: one link per customer (no API access, no grants). Only the SHA-256 of the token is kept; the link
--   is shown once when it is made; a new link replaces the old one; turning it off clears the hash. The row goes with its
--   contact or company (cascade).
-- * public.statement_link_create(org, contact, company): security INVOKER, so BAL-01's rights and partial rule are judged
--   under the caller's RLS by public.customer_debt_summary itself (no copy): not allowed = 42501; partial (the customer has
--   a document or payment the caller cannot read) = refused (hint statement_link:partial), because the page shows every
--   open document of the customer and its holder would learn amounts the caller may not see. Then the definer
--   app.statement_link_issue (schema app, not in the API; granted to authenticated for this wrapper only) checks again
--   what it can (app.can_record_payments, that the caller reads the customer (app.statement_customer_readable: the
--   rule of app.user_can_read_record on the record's owner and team), a writable business (org:read_only), the keys
--   balances, documents and payments, a live customer of the business (statement_link:deleted), no company on a contact)
--   and writes the link. Called directly, it can at most skip the partial rule; never reach a customer the caller does not
--   read. A deputy who reads a customer only through HEB-08's deputy rule is refused (fails closed). Audited as
--   action 'statement_link' on the contact or company, {"link": "created" | "revoked"}: never the token or its hash.
-- * public.statement_link_revoke / statement_link_status (definer): app.can_record_payments in the business and a customer
--   the caller reads (the same app.statement_customer_readable). Revoking only lessens access: no key, no writable
--   business needed.
-- * The one rule for a link (app.statement_link_usable): not found (P0002) for an unknown or revoked token, a business whose
--   public pages are closed (app.org_public_pages_open), a business without one of the keys balances, documents, payments,
--   a customer in the recycle bin or gone, and a contact that now has a company.
-- * public.statement_public(token, ip_hash): service_role only. Views: 120 per link in 10 minutes (counted on the link) and,
--   with the server's keyed IP hash (FXS-11, src/lib/keyed-ip-hash.ts, scope "statement"), 60 per sender in 10 minutes in
--   app.statement_link_view_counts (1,024 reused buckets per link, no hash stored; the sender is scoped to the link by
--   app.statement_link_sender). Past either: {"rate_limited": true}. Both are counted right after the token is looked up
--   and judged usable (the link's own row and the business's state are read first, as ORD-05's order link does, which
--   accepts this), before any of the page's data is read.
--   The answer: the business (display name, the registered details as on documents while QUO-05's design shows them, the
--   logo while it shows it, the colour), the customer's name as documents name it (CON-08: billing name, else the name),
--   the business's today, and the customer's OPEN debt documents by BAL-02's rule: active tax invoices, proformas and
--   positive opening balances whose public.money_allocation_state balance is above 0 (a proforma billed by an active tax
--   invoice is 'transferred', 0, and its invoice carries what is left). Each: type code, number, date, due date, amount,
--   balance and days overdue (whole days past the due date in the business's zone, 0 otherwise). Totals: open, overdue
--   (due before today) and the customer's credit (PAY-03 public.money_customer_credit's total: payments' unallocated
--   amounts and negative opening balances' credit left), as a separate figure. At most 500 documents, oldest due first;
--   `more` counts the rest (the totals count all). No ids, no notes, no payment details, nothing of another customer.
--   The money functions are security invoker; here they run as this function's owner, so every row of THIS customer
--   counts (the page is not a person); the scope is the customer's alone, as BAL-02's card.
-- * Accepted (review): a merge of two contacts leaves the duplicate's link to go with the duplicate (cascade), so the kept
--   contact has no link until one is made again; removing sample data (USR-04) does not count a link as work on the record.
-- Every statement is safe to run twice. No drops, no row removal.

create table if not exists app.statement_links (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null,
  contact_id         uuid,
  company_id         uuid,
  -- hex SHA-256 of the token; null = turned off
  token_hash         text unique,
  created_by         uuid,
  created_at         timestamptz,
  window_started_at  timestamptz,
  window_count       integer not null default 0,
  constraint statement_links_one check ((contact_id is null) <> (company_id is null)),
  constraint statement_links_contact_once unique (organization_id, contact_id),
  constraint statement_links_company_once unique (organization_id, company_id),
  constraint statement_links_contact_fk foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id) on delete cascade,
  constraint statement_links_company_fk foreign key (organization_id, company_id)
    references public.companies (organization_id, id) on delete cascade
);
alter table app.statement_links enable row level security;
revoke all on app.statement_links from public, anon, authenticated, service_role;

-- Views per sender: a fixed set of counters per link (1,024 buckets picked by the scoped keyed IP hash), each counting its
-- 10-minute window and reused by the next one (an update, never a delete). No hash is stored.
create table if not exists app.statement_link_view_counts (
  link_id       uuid not null references app.statement_links (id) on delete cascade,
  bucket        integer not null check (bucket between 0 and 1023),
  window_start  timestamptz not null,
  views         integer not null,
  primary key (link_id, bucket)
);
alter table app.statement_link_view_counts enable row level security;
revoke all on app.statement_link_view_counts from public, anon, authenticated, service_role;

-- The sender, scoped to one link: nothing matches across links or businesses
create or replace function app.statement_link_sender(p_link uuid, p_hash text) returns text
language sql immutable
set search_path = ''
as $$
  select case when p_hash is null or p_link is null then null
              else encode(sha256(convert_to('statement:' || p_link::text || ':' || p_hash, 'UTF8')), 'hex') end
$$;
revoke all on function app.statement_link_sender(uuid, text) from public, anon, authenticated, service_role;

-- The business has the ledger's three keys (BAL-01)
create or replace function app.statement_keys(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce(app.org_has_feature(p_org, 'balances') and app.org_has_feature(p_org, 'documents')
                  and app.org_has_feature(p_org, 'payments'), false)
$$;
revoke all on function app.statement_keys(uuid) from public, anon, authenticated, service_role;

-- The customer is live: a contact without a company, or a company, of the business, not in the recycle bin
create or replace function app.statement_customer_live(p_org uuid, p_contact uuid, p_company uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select case
    when p_contact is not null and p_company is null then exists (
      select 1 from public.contacts c
       where c.organization_id = p_org and c.id = p_contact and c.deleted_at is null and c.company_id is null)
    when p_company is not null and p_contact is null then exists (
      select 1 from public.companies c where c.organization_id = p_org and c.id = p_company and c.deleted_at is null)
    else false end
$$;
revoke all on function app.statement_customer_live(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- The one rule for a link: anything else answers "not found"
create or replace function app.statement_link_usable(p_link app.statement_links) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_link.id is not null
     and p_link.token_hash is not null
     and app.org_public_pages_open(p_link.organization_id)
     and app.statement_keys(p_link.organization_id)
     and app.statement_customer_live(p_link.organization_id, p_link.contact_id, p_link.company_id)
$$;
revoke all on function app.statement_link_usable(app.statement_links) from public, anon, authenticated, service_role;

-- The caller reads the customer: a contact or company of the business (in the recycle bin too, so a binned customer's
-- link can still be seen and turned off), judged by app.user_can_read_record (the rule of app.can_read_record for a named
-- user; keep in step) on the record's owner and team
create or replace function app.statement_customer_readable(p_org uuid, p_contact uuid, p_company uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select case
    when p_contact is not null and p_company is null then exists (
      select 1 from public.contacts c
       where c.organization_id = p_org and c.id = p_contact
         and app.user_can_read_record(p_org, auth.uid(), c.owner_id, c.team_id))
    when p_company is not null and p_contact is null then exists (
      select 1 from public.companies c
       where c.organization_id = p_org and c.id = p_company
         and app.user_can_read_record(p_org, auth.uid(), c.owner_id, c.team_id))
    else false end
$$;
revoke all on function app.statement_customer_readable(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- Who may manage a customer's link: whoever records payments in the business (BAL-01's rule), for one customer they read
create or replace function app.statement_link_check(p_org uuid, p_contact uuid, p_company uuid) returns void
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if (p_contact is null) = (p_company is null) then
    raise exception 'name a contact or a company' using errcode = '22023';
  end if;
  if not app.can_record_payments(p_org) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not app.statement_customer_readable(p_org, p_contact, p_company) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
end;
$$;
revoke all on function app.statement_link_check(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- Makes the link (called by public.statement_link_create after the partial check under the caller's RLS)
create or replace function app.statement_link_issue(p_org uuid, p_contact uuid, p_company uuid) returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_token text;
  v_hash text;
  v_has_company boolean;
begin
  perform app.statement_link_check(p_org, p_contact, p_company);
  if not app.org_writable(p_org) then
    raise exception 'the organization is read-only' using errcode = 'P0001', hint = 'org:read_only';
  end if;
  if not app.org_has_feature(p_org, 'balances') then
    raise exception 'balances are not in this plan' using errcode = 'P0001', hint = 'feature:balances';
  end if;
  if not app.org_has_feature(p_org, 'documents') then
    raise exception 'documents are not in this plan' using errcode = 'P0001', hint = 'feature:documents';
  end if;
  if not app.org_has_feature(p_org, 'payments') then
    raise exception 'payments are not in this plan' using errcode = 'P0001', hint = 'feature:payments';
  end if;
  if p_contact is not null then
    select c.company_id is not null into v_has_company
      from public.contacts c where c.organization_id = p_org and c.id = p_contact;
    if v_has_company then
      raise exception 'a contact of a company has the company''s statement' using errcode = 'P0001', hint = 'statement_link:company';
    end if;
  end if;
  if not app.statement_customer_live(p_org, p_contact, p_company) then
    raise exception 'the customer is not live' using errcode = 'P0001', hint = 'statement_link:deleted';
  end if;

  -- 48 random bytes from three UUIDs, base64url: 64 characters
  v_token := translate(
    encode(decode(replace(gen_random_uuid()::text || gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'), 'base64'),
    E'+/=\n', '-_');
  v_hash := encode(sha256(convert_to(v_token, 'UTF8')), 'hex');

  if p_contact is not null then
    insert into app.statement_links as l (organization_id, contact_id, token_hash, created_by, created_at, window_started_at, window_count)
    values (p_org, p_contact, v_hash, auth.uid(), now(), null, 0)
    on conflict (organization_id, contact_id) do update
      set token_hash = excluded.token_hash, created_by = excluded.created_by, created_at = excluded.created_at,
          window_started_at = null, window_count = 0;
    insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
    values (p_org, auth.uid(), 'statement_link', 'contacts', p_contact, jsonb_build_object('link', 'created'));
  else
    insert into app.statement_links as l (organization_id, company_id, token_hash, created_by, created_at, window_started_at, window_count)
    values (p_org, p_company, v_hash, auth.uid(), now(), null, 0)
    on conflict (organization_id, company_id) do update
      set token_hash = excluded.token_hash, created_by = excluded.created_by, created_at = excluded.created_at,
          window_started_at = null, window_count = 0;
    insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
    values (p_org, auth.uid(), 'statement_link', 'companies', p_company, jsonb_build_object('link', 'created'));
  end if;
  return v_token;
end;
$$;
-- schema app is not in the API: only public.statement_link_create (invoker) reaches it. A direct call still needs
-- app.statement_link_check (rights and a customer the caller reads) and the checks above; it skips only the partial rule.
revoke all on function app.statement_link_issue(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function app.statement_link_issue(uuid, uuid, uuid) to authenticated;

create or replace function public.statement_link_create(p_org uuid, p_contact uuid default null, p_company uuid default null)
returns text
language plpgsql volatile security invoker
set search_path = ''
as $$
declare
  v_summary jsonb;
begin
  if (p_contact is null) = (p_company is null) then
    raise exception 'name a contact or a company' using errcode = '22023';
  end if;
  if not app.can_record_payments(p_org) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  -- the keys, so a business without them hears why (checked again by the issuer)
  if not app.org_has_feature(p_org, 'balances') then
    raise exception 'balances are not in this plan' using errcode = 'P0001', hint = 'feature:balances';
  end if;
  if not app.org_has_feature(p_org, 'documents') then
    raise exception 'documents are not in this plan' using errcode = 'P0001', hint = 'feature:documents';
  end if;
  if not app.org_has_feature(p_org, 'payments') then
    raise exception 'payments are not in this plan' using errcode = 'P0001', hint = 'feature:payments';
  end if;
  -- the customer is one the caller reads (RLS)
  if not ((p_contact is not null and exists (select 1 from public.contacts c where c.organization_id = p_org and c.id = p_contact))
          or (p_company is not null and exists (select 1 from public.companies c where c.organization_id = p_org and c.id = p_company))) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  -- BAL-01's rights, keys and partial rule, under the caller's RLS (the card's own function)
  v_summary := public.customer_debt_summary(p_org, p_contact, p_company);
  if not coalesce((v_summary ->> 'allowed')::boolean, false) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if coalesce((v_summary ->> 'partial')::boolean, true) then
    raise exception 'part of the customer''s money is hidden from the caller' using errcode = 'P0001', hint = 'statement_link:partial';
  end if;
  return app.statement_link_issue(p_org, p_contact, p_company);
end;
$$;
revoke all on function public.statement_link_create(uuid, uuid, uuid) from public, anon;
grant execute on function public.statement_link_create(uuid, uuid, uuid) to authenticated;

-- Turning the link off only lessens access, but it is still for those who record payments
create or replace function public.statement_link_revoke(p_org uuid, p_contact uuid default null, p_company uuid default null)
returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform app.statement_link_check(p_org, p_contact, p_company);
  update app.statement_links l
     set token_hash = null, created_at = null, window_started_at = null, window_count = 0
   where l.organization_id = p_org and l.token_hash is not null
     and ((p_contact is not null and l.contact_id = p_contact) or (p_company is not null and l.company_id = p_company));
  get diagnostics v_count = row_count;
  if v_count > 0 then
    if p_contact is not null then
      insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
      values (p_org, auth.uid(), 'statement_link', 'contacts', p_contact, jsonb_build_object('link', 'revoked'));
    else
      insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
      values (p_org, auth.uid(), 'statement_link', 'companies', p_company, jsonb_build_object('link', 'revoked'));
    end if;
  end if;
  return v_count > 0;
end;
$$;
revoke all on function public.statement_link_revoke(uuid, uuid, uuid) from public, anon;
grant execute on function public.statement_link_revoke(uuid, uuid, uuid) to authenticated;

-- Whether the customer has a working link, and since when (never the hash)
create or replace function public.statement_link_status(p_org uuid, p_contact uuid default null, p_company uuid default null)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_link app.statement_links;
begin
  perform app.statement_link_check(p_org, p_contact, p_company);
  select * into v_link from app.statement_links l
   where l.organization_id = p_org and l.token_hash is not null
     and ((p_contact is not null and l.contact_id = p_contact) or (p_company is not null and l.company_id = p_company));
  return jsonb_build_object('active', v_link.id is not null and app.statement_link_usable(v_link), 'created_at', v_link.created_at);
end;
$$;
revoke all on function public.statement_link_status(uuid, uuid, uuid) from public, anon;
grant execute on function public.statement_link_status(uuid, uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The customer's page
-- ----------------------------------------------------------------------------
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
    'totals', jsonb_build_object('open_agorot', v_totals.open_agorot, 'overdue_agorot', v_totals.overdue_agorot,
                                 'credit_agorot', v_credit),
    'built_with', v_built_with);
end;
$$;
revoke all on function public.statement_public(text, text) from public, anon, authenticated;
grant execute on function public.statement_public(text, text) to service_role;
