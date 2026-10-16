-- =============================================================================
-- Quotes: created from a deal or a contact, edited as a draft (QUO-01, QUO-02; wave 2)
-- =============================================================================
-- SPEC-ADDITIONS 5. A quote is not an accounting document; this migration builds the
-- draft and its editor's data. Sending, the public link, PDF, signing, versions and
-- the running number come with QUO-03/06..12.
--
-- public.quotes, one row per quote:
--   deal_id, contact_id   the customer side. At least one (quotes_has_parent). A quote
--                         made from a deal takes the deal's contact and company when
--                         none is sent; one made from a contact takes its company.
--                         Composite FKs; deal and contact ON DELETE CASCADE (a quote is
--                         a child of its deal, else of its contact: SPEC-ADDITIONS 22.9
--                         "a child record inherits the parent's visibility"; purging the
--                         parent removes it, as privacy erasure needs), company SET NULL.
--                         deal_id is set once, on insert.
--   status                draft | sent | viewed | accepted | rejected | expired | cancelled
--                         (QUO-11). Server only: every quote is a draft until the sending
--                         RPC of QUO-07 exists. Clients edit and delete drafts only.
--   title                 1..200 characters.
--   quote_date            server: the business's today (its time zone) when made. The VAT
--                         rate is the rate of this day. The sending RPC will date it again.
--   valid_until           optional; on or after quote_date (QUO-11 expires it).
--   owner_id              server: the person who made it.
--   prices_include_vat    one mode per quote (TAX-04): the business's setting when made;
--                         may change only while the quote has no lines (hint
--                         quote:vat_locked), so every line is read in one mode.
--   no_vat_reason,        owner, 14 October 2026: "מסמך זה בלי מע"מ" with a reason from a
--   no_vat_note           closed list: eilat | abroad | other (other needs a note, 1..200).
--                         The quote then uses rate 0. Only for prices before VAT
--                         (quotes_no_vat_mode), so a price is never read as gross at rate 0.
--   discount_bp,          the document discount (DSC-01), percent OR amount; needs the plan
--   discount_agorot       flag 'discounts' when set or changed by a person.
--   notes, terms          text for the customer (QUO-04 templates fill them later).
--   vat_rate_bp,          server only, recomputed on every write of the quote or its lines by
--   subtotal_agorot, ...  app.document_totals (the one totals rule, TAX-05): rate = 0 with a
--                         no-VAT reason, else app.org_document_vat_rate(org, quote_date)
--                         (null = the business's VAT status is not set: totals without
--                         VAT, the editor says so). Counted lines: items that are not
--                         optional, and optional ones marked selected.
--   currency              ILS only (TAX-06).
--
-- public.quote_lines, one row per line (cap 200 per quote, hint quote_lines:max):
--   kind                  item | group. A group line is a heading (its name) that starts a
--                         group of the lines after it; it carries no product, price,
--                         discount or option (quote_lines_group_shape) and counts nothing.
--   position              order (the app appends at max + 1; public.quote_lines_reorder
--                         renumbers in one statement).
--   product_id            composite FK with NO on delete action (PRD-02: a product on a
--                         line can only be archived); set on insert only; a person adds
--                         only an offerable product (hint quote_lines:product). Needs the
--                         'products' flag.
--   name, description     copied from the product when picked, editable (PRD-03: a later
--                         change of the product never changes the line).
--   unit_name             server: the product's unit name, copied on insert.
--   quantity, unit_price_agorot, discount_bp | discount_agorot   as in deal_lines.
--   vat_exempt            a product line: the product's (not taxable = exempt), fixed; a free
--                         line: the person's choice.
--   billing               a product line copies its product's; a free line is the person's
--                         (one_time by default). For QUO-13, which updates the deal's lines.
--   is_optional,          an optional line (the customer chooses later, QUO-08); counted
--   optional_selected     only while selected. The seller may preselect it.
--   price_source, price_list_id, price_list_name   as in deal_lines (PL-03 order of lists).
--   total_agorot          server: the line alone by app.document_totals in the quote's mode.
--
-- Rights (SPEC-ADDITIONS 5.3: "whoever may edit the deal may create and edit its quote"):
-- * read: the caller reads the quote's deal, else its contact (the subqueries run under
--   the deals / contacts RLS, so deputies and team rules apply as they do there);
-- * insert, update, delete: app.quote_editable(org, deal, contact): the deal, else the
--   contact, is live (not in the bin) and app.can_edit_record allows it (which also needs a
--   writable business); update and delete only while the quote is a draft; insert also
--   needs the plan flag 'quotes' (hint feature:quotes from the trigger, also in the policy).
-- * lines follow their quote: read with it; written while it is a draft and editable.
-- PRM-01 'issue_documents' is about invoices and receipts, not quotes: not asked here.
-- A person may link only a contact / company they read and that is not in the bin (hints
-- quote:contact, quote:company; trigger quotes_links, security invoker); the contact of
-- the quote's own deal is always allowed.
--
-- The definer triggers start with the outsider guard of the quota triggers: a person who
-- may not edit the quote's parent is left to RLS (42501) and learns nothing else.
--
-- The select policies lean on the parents' RLS on purpose: quotes_select is an EXISTS on
-- public.deals / public.contacts and quote_lines_select an EXISTS on public.quotes, each run
-- under the caller's own policies there (visibility, teams, deputies, support sessions). A
-- change to those parents' select policies changes who reads quotes, and nothing else does.
--
-- Purging a contact: its contact-only drafts go with it (cascade); a deal's quote that names
-- it is detached first (trigger contacts_quotes_detach) and stays with the deal.
--
-- Shared functions redefined from their latest bodies, each with quotes added only:
-- app.merge_move_links (019500: a merged contact's / company's quotes move to the kept
-- one), app.audit_erase_core (018500: a purged record's quotes and their lines are erased
-- from the audit log), app.sample_untouched and app.import_record_worked (020090 CON-06: a
-- record with a quote is real work for sample removal and for undo of one's own import).
-- Not changed: public.transfer_records (a quote's owner_id stays; its rights follow the
-- deal or contact, which do move).
--
-- Every statement is safe to run twice. No drops, no row removal.

-- ----------------------------------------------------------------------------
-- Tables
-- ----------------------------------------------------------------------------
create table if not exists public.quotes (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations (id) on delete cascade,
  title                 text not null check (char_length(btrim(title)) between 1 and 200),
  status                text not null default 'draft'
                        check (status in ('draft', 'sent', 'viewed', 'accepted', 'rejected', 'expired', 'cancelled')),
  deal_id               uuid,
  contact_id            uuid,
  company_id            uuid,
  owner_id              uuid references auth.users (id) on delete set null,
  quote_date            date not null default current_date,
  valid_until           date,
  prices_include_vat    boolean not null default false,
  no_vat_reason         text check (no_vat_reason in ('eilat', 'abroad', 'other')),
  no_vat_note           text check (no_vat_note is null or char_length(btrim(no_vat_note)) between 1 and 200),
  discount_bp           integer check (discount_bp is null or discount_bp between 1 and 10000),
  discount_agorot       bigint check (discount_agorot is null or discount_agorot between 1 and 1000000000000),
  notes                 text check (notes is null or char_length(notes) <= 4000),
  terms                 text check (terms is null or char_length(terms) <= 8000),
  vat_rate_bp           integer,
  subtotal_agorot       bigint not null default 0,
  discount_total_agorot bigint not null default 0,
  net_total_agorot      bigint not null default 0,
  vat_agorot            bigint not null default 0,
  total_agorot          bigint not null default 0,
  currency              text not null default 'ILS' check (currency = 'ILS'),
  created_by            uuid references auth.users (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (organization_id, id),
  constraint quotes_has_parent check (deal_id is not null or contact_id is not null),
  constraint quotes_one_discount check (discount_bp is null or discount_agorot is null),
  constraint quotes_no_vat_note check ((no_vat_reason = 'other') = (no_vat_note is not null)),
  constraint quotes_no_vat_mode check (no_vat_reason is null or not prices_include_vat),
  constraint quotes_valid_until check (valid_until is null or valid_until >= quote_date),
  -- Drafts go with their deal or contact (owner, 15 October 2026). QUO-07 must change these two cascades for
  -- SENT quotes: a sent quote stays, detached, with the customer's name as printed and marked "הלקוח נמחק"; a
  -- privacy erasure empties its personal details and keeps the number, date and amounts.
  constraint quotes_deal_fk foreign key (organization_id, deal_id)
    references public.deals (organization_id, id) on delete cascade,
  constraint quotes_contact_fk foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id) on delete cascade,
  constraint quotes_company_fk foreign key (organization_id, company_id)
    references public.companies (organization_id, id) on delete set null (company_id)
);

create index if not exists quotes_deal_idx on public.quotes (organization_id, deal_id) where deal_id is not null;
create index if not exists quotes_contact_idx on public.quotes (organization_id, contact_id) where contact_id is not null;
create index if not exists quotes_company_idx on public.quotes (organization_id, company_id) where company_id is not null;
create index if not exists quotes_org_created_idx on public.quotes (organization_id, created_at desc);

create table if not exists public.quote_lines (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  quote_id           uuid not null,
  position           integer not null default 0 check (position between 0 and 100000),
  kind               text not null default 'item' check (kind in ('item', 'group')),
  product_id         uuid,
  name               text not null check (char_length(btrim(name)) between 1 and 300),
  description        text check (description is null or char_length(description) <= 2000),
  unit_name          text,
  quantity           numeric not null default 1,
  unit_price_agorot  bigint not null default 0 check (unit_price_agorot between 0 and 1000000000000),
  discount_bp        integer check (discount_bp is null or discount_bp between 1 and 10000),
  discount_agorot    bigint check (discount_agorot is null or discount_agorot between 1 and 1000000000000),
  vat_exempt         boolean not null default false,
  billing            text not null default 'one_time' check (billing in ('one_time', 'monthly', 'quarterly', 'yearly')),
  is_optional        boolean not null default false,
  optional_selected  boolean not null default false,
  price_source       text not null default 'manual' check (price_source in ('product', 'price_list', 'manual')),
  price_list_id      uuid,
  price_list_name    text,
  total_agorot       bigint not null default 0,
  currency           text not null default 'ILS' check (currency = 'ILS'),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (organization_id, id),
  constraint quote_lines_quote_fk foreign key (organization_id, quote_id)
    references public.quotes (organization_id, id) on delete cascade,
  -- no action: a product on a line cannot be removed, only archived (PRD-02)
  constraint quote_lines_product_fk foreign key (organization_id, product_id)
    references public.products (organization_id, id),
  constraint quote_lines_price_list_fk foreign key (organization_id, price_list_id)
    references public.price_lists (organization_id, id) on delete set null (price_list_id),
  constraint quote_lines_quantity check (quantity > 0 and quantity <= 1000000 and quantity = round(quantity, 3)),
  constraint quote_lines_one_discount check (discount_bp is null or discount_agorot is null),
  constraint quote_lines_free_manual check (product_id is not null or price_source = 'manual'),
  constraint quote_lines_list_source check (price_source = 'price_list' or price_list_id is null),
  constraint quote_lines_optional check (is_optional or not optional_selected),
  constraint quote_lines_group_shape check (
    kind = 'item'
    or (product_id is null and discount_bp is null and discount_agorot is null and not is_optional
        and unit_price_agorot = 0 and quantity = 1 and price_source = 'manual'))
);

create index if not exists quote_lines_quote_idx on public.quote_lines (organization_id, quote_id, position);
create index if not exists quote_lines_product_idx on public.quote_lines (organization_id, product_id) where product_id is not null;
create index if not exists quote_lines_price_list_idx on public.quote_lines (organization_id, price_list_id) where price_list_id is not null;

alter table public.quotes enable row level security;
alter table public.quote_lines enable row level security;

revoke all on public.quotes from anon, authenticated;
grant select, delete on public.quotes to authenticated;
grant insert (organization_id, title, deal_id, contact_id, company_id, valid_until, prices_include_vat, no_vat_reason,
              no_vat_note, discount_bp, discount_agorot, notes, terms, currency)
  on public.quotes to authenticated;
grant update (title, contact_id, company_id, valid_until, prices_include_vat, no_vat_reason, no_vat_note, discount_bp,
              discount_agorot, notes, terms, currency)
  on public.quotes to authenticated;

revoke all on public.quote_lines from anon, authenticated;
grant select, delete on public.quote_lines to authenticated;
grant insert (organization_id, quote_id, position, kind, product_id, name, description, quantity, unit_price_agorot,
              discount_bp, discount_agorot, vat_exempt, billing, is_optional, optional_selected, price_source,
              price_list_id, currency)
  on public.quote_lines to authenticated;
grant update (position, name, description, quantity, unit_price_agorot, discount_bp, discount_agorot, vat_exempt, billing,
              is_optional, optional_selected, price_source, price_list_id, currency)
  on public.quote_lines to authenticated;

-- ----------------------------------------------------------------------------
-- Who may write a quote: the one who may edit its deal, else its contact
-- ----------------------------------------------------------------------------
create or replace function app.quote_editable(p_org uuid, p_deal uuid, p_contact uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select case
    when p_deal is not null then exists (
      select 1 from public.deals d
       where d.organization_id = p_org and d.id = p_deal and d.deleted_at is null
         and app.can_edit_record(d.organization_id, d.owner_id, d.team_id))
    when p_contact is not null then exists (
      select 1 from public.contacts c
       where c.organization_id = p_org and c.id = p_contact and c.deleted_at is null
         and app.can_edit_record(c.organization_id, c.owner_id, c.team_id))
    else false
  end;
$$;
revoke all on function app.quote_editable(uuid, uuid, uuid) from public, anon;
grant execute on function app.quote_editable(uuid, uuid, uuid) to authenticated, service_role;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quotes' and policyname = 'quotes_select') then
    create policy quotes_select on public.quotes for select to authenticated
      using (case when quotes.deal_id is not null
                  then exists (select 1 from public.deals d where d.organization_id = quotes.organization_id and d.id = quotes.deal_id)
                  else exists (select 1 from public.contacts c where c.organization_id = quotes.organization_id and c.id = quotes.contact_id)
             end);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quotes' and policyname = 'quotes_insert') then
    create policy quotes_insert on public.quotes for insert to authenticated
      with check (app.org_has_feature(organization_id, 'quotes')
                  and app.quote_editable(organization_id, deal_id, contact_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quotes' and policyname = 'quotes_update') then
    create policy quotes_update on public.quotes for update to authenticated
      using (status = 'draft' and app.quote_editable(organization_id, deal_id, contact_id))
      with check (status = 'draft' and app.quote_editable(organization_id, deal_id, contact_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quotes' and policyname = 'quotes_delete') then
    create policy quotes_delete on public.quotes for delete to authenticated
      using (status = 'draft' and app.quote_editable(organization_id, deal_id, contact_id));
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_lines' and policyname = 'quote_lines_select') then
    create policy quote_lines_select on public.quote_lines for select to authenticated
      using (exists (select 1 from public.quotes q where q.organization_id = quote_lines.organization_id and q.id = quote_lines.quote_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_lines' and policyname = 'quote_lines_insert') then
    create policy quote_lines_insert on public.quote_lines for insert to authenticated
      with check (exists (select 1 from public.quotes q
                           where q.organization_id = quote_lines.organization_id and q.id = quote_lines.quote_id
                             and q.status = 'draft' and app.quote_editable(q.organization_id, q.deal_id, q.contact_id)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_lines' and policyname = 'quote_lines_update') then
    create policy quote_lines_update on public.quote_lines for update to authenticated
      using (exists (select 1 from public.quotes q
                      where q.organization_id = quote_lines.organization_id and q.id = quote_lines.quote_id
                        and q.status = 'draft' and app.quote_editable(q.organization_id, q.deal_id, q.contact_id)))
      with check (exists (select 1 from public.quotes q
                           where q.organization_id = quote_lines.organization_id and q.id = quote_lines.quote_id
                             and q.status = 'draft' and app.quote_editable(q.organization_id, q.deal_id, q.contact_id)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_lines' and policyname = 'quote_lines_delete') then
    create policy quote_lines_delete on public.quote_lines for delete to authenticated
      using (exists (select 1 from public.quotes q
                      where q.organization_id = quote_lines.organization_id and q.id = quote_lines.quote_id
                        and q.status = 'draft' and app.quote_editable(q.organization_id, q.deal_id, q.contact_id)));
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- The quote: server values and totals
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
    new.deal_id := old.deal_id;
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

create or replace trigger quotes_check before insert or update on public.quotes
  for each row execute function app.quotes_check();

-- A person links only a contact / company they read and that is not in the bin. Security
-- invoker: the reads run under the caller's RLS. The contact of the quote's own deal is allowed.
create or replace function app.quotes_links() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if new.contact_id is not null and (tg_op = 'INSERT' or new.contact_id is distinct from old.contact_id)
     and not exists (select 1 from public.contacts c
                      where c.organization_id = new.organization_id and c.id = new.contact_id and c.deleted_at is null)
     and not (new.deal_id is not null and exists (
                select 1 from public.deals d
                 where d.organization_id = new.organization_id and d.id = new.deal_id and d.contact_id = new.contact_id)) then
    raise exception 'the contact cannot be linked' using errcode = 'P0001', hint = 'quote:contact';
  end if;
  if new.company_id is not null and (tg_op = 'INSERT' or new.company_id is distinct from old.company_id)
     and not exists (select 1 from public.companies c
                      where c.organization_id = new.organization_id and c.id = new.company_id and c.deleted_at is null)
     and not (new.deal_id is not null and exists (
                select 1 from public.deals d
                 where d.organization_id = new.organization_id and d.id = new.deal_id and d.company_id = new.company_id))
     and not (new.contact_id is not null and exists (
                select 1 from public.contacts c
                 where c.organization_id = new.organization_id and c.id = new.contact_id and c.company_id = new.company_id)) then
    raise exception 'the company cannot be linked' using errcode = 'P0001', hint = 'quote:company';
  end if;
  return new;
end;
$$;
revoke all on function app.quotes_links() from public, anon;
grant execute on function app.quotes_links() to authenticated;

create or replace trigger quotes_links before insert or update on public.quotes
  for each row execute function app.quotes_links();

-- A purged contact takes its contact-only drafts with it (the cascade), but a deal's quote
-- belongs to the deal: before the contact row goes, the deal quotes that name it are detached
-- (contact_id = null), so the cascade removes only quotes whose parent is the contact.
-- Definer: whoever may purge the contact detaches every deal quote that names it, including
-- quotes of deals they do not read (a member may have named a colleague's contact).
create or replace function app.quotes_detach_contact() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- the whole business is being deleted: its quotes go with it, and an audit entry for a
  -- business that no longer exists would break the audit log's foreign key
  if not app.org_exists(old.organization_id) then
    return old;
  end if;
  update public.quotes q set contact_id = null
   where q.organization_id = old.organization_id and q.contact_id = old.id and q.deal_id is not null;
  return old;
end;
$$;
revoke all on function app.quotes_detach_contact() from public, anon, authenticated;

create or replace trigger contacts_quotes_detach before delete on public.contacts
  for each row execute function app.quotes_detach_contact();
create or replace trigger quotes_touch before insert or update on public.quotes
  for each row execute function app.touch_row();
create or replace trigger quotes_audit after insert or update or delete on public.quotes
  for each row execute function app.audit_row();

-- ----------------------------------------------------------------------------
-- The lines: server values, flags, the cap and the line total
-- ----------------------------------------------------------------------------
create or replace function app.quote_lines_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_quote public.quotes;
  v_kind text;
  v_active boolean;
  v_archived timestamptz;
  v_billing text;
  v_unit text;
  v_name text;
  v_totals jsonb;
begin
  select * into v_quote from public.quotes q where q.organization_id = new.organization_id and q.id = new.quote_id;
  -- outsider guard: RLS refuses (42501) a person who may not edit the quote
  if auth.uid() is not null and (not found or not app.quote_editable(v_quote.organization_id, v_quote.deal_id, v_quote.contact_id)) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtextextended('quote_lines:' || new.quote_id::text, 0));
    if (select count(*) from public.quote_lines l
         where l.organization_id = new.organization_id and l.quote_id = new.quote_id) >= 200 then
      raise exception 'at most 200 lines in a quote' using errcode = 'P0001', hint = 'quote_lines:max';
    end if;
    if new.product_id is not null then
      if not app.org_has_feature(new.organization_id, 'products') then
        raise exception 'products are not in this plan' using errcode = 'P0001', hint = 'feature:products';
      end if;
      select p.vat_kind, p.is_active, p.archived_at, p.billing, u.name
        into v_kind, v_active, v_archived, v_billing, v_unit
        from public.products p
        left join public.product_units u on u.organization_id = p.organization_id and u.id = p.unit_id
       where p.organization_id = new.organization_id and p.id = new.product_id;
      if found then
        if auth.uid() is not null and (not v_active or v_archived is not null) then
          raise exception 'the product cannot be offered' using errcode = 'P0001', hint = 'quote_lines:product';
        end if;
        new.vat_exempt := v_kind <> 'taxable';
        new.billing := v_billing;
        new.unit_name := v_unit;
      end if;
      -- not found: the foreign key refuses the row (23503)
    else
      new.unit_name := null;
    end if;
  else
    new.organization_id := old.organization_id;
    new.quote_id := old.quote_id;
    new.kind := old.kind;
    new.product_id := old.product_id;
    new.unit_name := old.unit_name;
    if old.product_id is not null then
      new.vat_exempt := old.vat_exempt;
      new.billing := old.billing;
    end if;
  end if;

  if new.kind = 'group' then
    new.vat_exempt := false;
    new.billing := 'one_time';
    new.total_agorot := 0;
    return new;
  end if;

  if (new.discount_bp is not null or new.discount_agorot is not null)
     and (tg_op = 'INSERT' or new.discount_bp is distinct from old.discount_bp
          or new.discount_agorot is distinct from old.discount_agorot)
     and not app.org_has_feature(new.organization_id, 'discounts') then
    raise exception 'discounts are not in this plan' using errcode = 'P0001', hint = 'feature:discounts';
  end if;

  -- the price list that set the price (PL-03); its name is kept with the line
  if new.price_source <> 'price_list' then
    if new.price_list_id is not null and auth.uid() is not null then
      raise exception 'only a price from a price list names a list' using errcode = 'P0001', hint = 'quote_lines:price_list';
    end if;
    new.price_list_id := null;
    new.price_list_name := null;
  elsif new.price_list_id is not null
        and (tg_op = 'INSERT' or new.price_list_id is distinct from old.price_list_id) then
    if not app.org_has_feature(new.organization_id, 'price_lists') then
      raise exception 'price lists are not in this plan' using errcode = 'P0001', hint = 'feature:price_lists';
    end if;
    select l.name into v_name from public.price_lists l
     where l.organization_id = new.organization_id and l.id = new.price_list_id;
    new.price_list_name := v_name;
  elsif tg_op = 'INSERT' then
    raise exception 'a price from a price list names the list' using errcode = 'P0001', hint = 'quote_lines:price_list';
  elsif new.price_list_id is null and old.price_source = 'price_list' then
    -- its list was removed (on delete set null): the line keeps the name it was priced by
    new.price_list_name := old.price_list_name;
  else
    new.price_list_name := old.price_list_name;
  end if;

  v_totals := app.document_totals(
    jsonb_build_array(jsonb_build_object(
      'quantity', new.quantity,
      'unit_price_agorot', new.unit_price_agorot,
      'discount_bp', new.discount_bp,
      'discount_agorot', new.discount_agorot,
      'vat_exempt', new.vat_exempt)),
    0, coalesce(v_quote.prices_include_vat, false));
  new.total_agorot := (v_totals #>> '{lines,0,total_agorot}')::bigint;
  return new;
end;
$$;
revoke all on function app.quote_lines_check() from public, anon, authenticated;

create or replace trigger quote_lines_check before insert or update on public.quote_lines
  for each row execute function app.quote_lines_check();
create or replace trigger quote_lines_touch before insert or update on public.quote_lines
  for each row execute function app.touch_row();
create or replace trigger quote_lines_audit after insert or update or delete on public.quote_lines
  for each row execute function app.audit_row();

-- The quote's totals follow its lines: a write that can change them touches the quote, whose
-- trigger (app.quotes_check) computes them again. A move of position only changes nothing.
create or replace function app.quote_lines_recompute() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_org uuid := coalesce(new.organization_id, old.organization_id);
  v_quote uuid := coalesce(new.quote_id, old.quote_id);
begin
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'position' - 'updated_at') = (to_jsonb(old) - 'position' - 'updated_at') then
    return null;
  end if;
  update public.quotes q set updated_at = now() where q.organization_id = v_org and q.id = v_quote;
  return null;
end;
$$;
revoke all on function app.quote_lines_recompute() from public, anon, authenticated;

create or replace trigger quote_lines_recompute after insert or update or delete on public.quote_lines
  for each row execute function app.quote_lines_recompute();

-- QUO-02: the lines in a new order, in one statement (security invoker: RLS decides).
-- p_ids lists the quote's lines in their new order; each line not listed keeps its place
-- after them. Returns the number of lines moved.
create or replace function public.quote_lines_reorder(p_org uuid, p_quote uuid, p_ids uuid[]) returns integer
language plpgsql volatile security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_ids is null or cardinality(p_ids) > 200 then
    raise exception 'invalid order' using errcode = '22023', hint = 'quote_lines:order';
  end if;
  update public.quote_lines l
     set position = o.n
    from unnest(p_ids) with ordinality as o(id, n)
   where l.organization_id = p_org and l.quote_id = p_quote and l.id = o.id and l.position is distinct from o.n::integer;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.quote_lines_reorder(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.quote_lines_reorder(uuid, uuid, uuid[]) to authenticated;

-- ----------------------------------------------------------------------------
-- Merge: a merged contact's / company's quotes move to the kept one.
-- Redefined from its latest body (019500 lead_score); only the two quote lines are added.
-- ----------------------------------------------------------------------------
create or replace function app.merge_move_links(p_org uuid, p_type text, p_keep uuid, p_merge uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $$
declare
  v_col text := p_type || '_id';
  v_owner uuid;
  v_team uuid;
begin
  execute format('update public.activities set %1$I = $1 where organization_id = $2 and %1$I = $3', v_col) using p_keep, p_org, p_merge;
  execute format('update public.tasks set %1$I = $1 where organization_id = $2 and %1$I = $3', v_col) using p_keep, p_org, p_merge;
  execute format('update public.files set %1$I = $1 where organization_id = $2 and %1$I = $3', v_col) using p_keep, p_org, p_merge;
  execute format('update public.meetings set %1$I = $1 where organization_id = $2 and %1$I = $3', v_col) using p_keep, p_org, p_merge;
  update public.notifications set entity_id = p_keep where organization_id = p_org and entity_id = p_merge;
  -- CNS-01: the duplicate's consent history goes to the kept record (time and seq kept;
  -- the guard lets the link move and subject_id follows)
  if p_type in ('lead', 'contact') then
    execute format('update public.consents set %1$I = $1 where organization_id = $2 and %1$I = $3', v_col) using p_keep, p_org, p_merge;
  end if;
  -- followers who may read the kept record, one row per user; a row that would
  -- clash, or whose user may not read the kept record, stays and goes with the duplicate
  execute format('select owner_id, team_id from public.%I where organization_id = $1 and id = $2',
                 case p_type when 'lead' then 'leads' when 'contact' then 'contacts' else 'companies' end)
    into v_owner, v_team using p_org, p_keep;
  execute format(
    'update public.record_followers f set %1$I = $1
      where f.organization_id = $2 and f.%1$I = $3
        and app.user_can_read_record($2, f.user_id, $4, $5)
        and not exists (select 1 from public.record_followers k
                         where k.organization_id = $2 and k.user_id = f.user_id and k.%1$I = $1)', v_col)
    using p_keep, p_org, p_merge, v_owner, v_team;

  if p_type = 'lead' then
    update public.form_submissions set lead_id = p_keep where organization_id = p_org and lead_id = p_merge;
    -- LEAD-05: a call-back the duplicate asked for counts for the kept lead (one mark,
    -- the earliest time); the duplicate's own mark goes with it by cascade
    insert into app.lead_callback_requests as k (organization_id, lead_id, requested_at)
    select c.organization_id, p_keep, c.requested_at
      from app.lead_callback_requests c
     where c.organization_id = p_org and c.lead_id = p_merge
    on conflict (organization_id, lead_id) do update
      set requested_at = least(k.requested_at, excluded.requested_at);
    perform app.lead_score_write(p_org, p_keep);
  elsif p_type = 'contact' then
    update public.deals set contact_id = p_keep where organization_id = p_org and contact_id = p_merge;
    -- one row per deal: a row that would clash stays and goes with the duplicate
    update public.deal_contacts dc set contact_id = p_keep
     where dc.organization_id = p_org and dc.contact_id = p_merge
       and not exists (select 1 from public.deal_contacts k where k.deal_id = dc.deal_id and k.contact_id = p_keep);
    update public.leads set converted_contact_id = p_keep where organization_id = p_org and converted_contact_id = p_merge;
    perform app.merge_contact_channels_move(p_org, p_keep, p_merge);
    -- QUO-01: its quotes (they would go with the duplicate by cascade)
    update public.quotes set contact_id = p_keep where organization_id = p_org and contact_id = p_merge;
  elsif p_type = 'company' then
    update public.contacts set company_id = p_keep where organization_id = p_org and company_id = p_merge;
    update public.deals set company_id = p_keep where organization_id = p_org and company_id = p_merge;
    update public.leads set converted_company_id = p_keep where organization_id = p_org and converted_company_id = p_merge;
    update public.companies set parent_company_id = case when id = p_keep then null else p_keep end
     where organization_id = p_org and parent_company_id = p_merge;
    -- QUO-01: its quotes
    update public.quotes set company_id = p_keep where organization_id = p_org and company_id = p_merge;
  end if;
end;
$$;
revoke all on function app.merge_move_links(uuid, text, uuid, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- USR-04: a sample deal, contact or company with a quote is real work (kept on removal).
-- Redefined from its latest body (020090 contact_relations); only the three quote checks are added.
-- ----------------------------------------------------------------------------
create or replace function app.sample_untouched(p_org uuid, p_type text, p_id uuid, p_snapshot jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $$
declare
  v_col text := p_type || '_id';
  v_found boolean;
begin
  if app.sample_row(p_org, p_type, p_id) is distinct from p_snapshot then
    return false;
  end if;
  if p_type = 'task' then
    return true;
  end if;
  -- notes, files and meetings are never sample data
  execute format(
    'select exists (select 1 from public.activities where organization_id = $1 and %1$I = $2)
         or exists (select 1 from public.files where organization_id = $1 and %1$I = $2)
         or exists (select 1 from public.meetings where organization_id = $1 and %1$I = $2)', v_col)
    into v_found using p_org, p_id;
  if v_found then
    return false;
  end if;
  -- a task that is not an unchanged sample task
  execute format(
    'select exists (select 1 from public.tasks t where t.organization_id = $1 and t.%1$I = $2
                     and not app.sample_pristine($1, ''task'', t.id))', v_col)
    into v_found using p_org, p_id;
  if v_found then
    return false;
  end if;
  if p_type = 'lead' then
    return not exists (select 1 from public.form_submissions f where f.organization_id = p_org and f.lead_id = p_id)
       -- CNS-01: sample data records no consent; one recorded is real work
       and not exists (select 1 from public.consents cn where cn.organization_id = p_org and cn.lead_id = p_id)
       -- CON-06: a referral by the lead
       and not exists (select 1 from public.contact_relations cr where cr.organization_id = p_org and cr.lead_id = p_id);
  elsif p_type = 'contact' then
    return not exists (select 1 from public.deal_contacts dc where dc.organization_id = p_org and dc.contact_id = p_id)
       and not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_contact_id = p_id)
       and not exists (select 1 from public.deals d where d.organization_id = p_org and d.contact_id = p_id
                         and not app.sample_untouched_id(p_org, 'deal', d.id))
       -- CON-01: sample data adds no further phones or emails; one added is real work
       and not exists (select 1 from public.contact_channels ch where ch.organization_id = p_org and ch.contact_id = p_id)
       -- CNS-01: a consent recorded on it
       and not exists (select 1 from public.consents cn where cn.organization_id = p_org and cn.contact_id = p_id)
       -- CON-05: a further company, or a role at the primary one
       and not exists (select 1 from public.contact_companies cc where cc.organization_id = p_org and cc.contact_id = p_id
                         and (not cc.is_primary or cc.title is not null))
       -- CON-06: sample data makes no relations; one made is real work
       and not exists (select 1 from public.contact_relations cr where cr.organization_id = p_org and p_id in (cr.contact_id, cr.related_contact_id))
       -- QUO-01: sample data makes no quotes; one made is real work
       and not exists (select 1 from public.quotes qt where qt.organization_id = p_org and qt.contact_id = p_id);
  elsif p_type = 'company' then
    return not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_company_id = p_id)
       and not exists (select 1 from public.companies c where c.organization_id = p_org and c.parent_company_id = p_id)
       and not exists (select 1 from public.contacts c where c.organization_id = p_org and c.company_id = p_id
                         and not app.sample_untouched_id(p_org, 'contact', c.id))
       and not exists (select 1 from public.deals d where d.organization_id = p_org and d.company_id = p_id
                         and not app.sample_untouched_id(p_org, 'deal', d.id))
       -- CON-05: someone linked to it as a further company, or given a role there
       and not exists (select 1 from public.contact_companies cc where cc.organization_id = p_org and cc.company_id = p_id
                         and (not cc.is_primary or cc.title is not null))
       -- QUO-01
       and not exists (select 1 from public.quotes qt where qt.organization_id = p_org and qt.company_id = p_id);
  else -- deal
    return not exists (select 1 from public.deal_contacts dc where dc.organization_id = p_org and dc.deal_id = p_id)
       and not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_deal_id = p_id)
       -- DLI-01: sample data adds no product lines; one added is real work
       and not exists (select 1 from public.deal_lines dl where dl.organization_id = p_org and dl.deal_id = p_id)
       -- QUO-01
       and not exists (select 1 from public.quotes qt where qt.organization_id = p_org and qt.deal_id = p_id);
  end if;
end;
$$;
revoke all on function app.sample_untouched(uuid, text, uuid, jsonb) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Privacy erasure: a purged record's quotes (gone with it by cascade) and their lines are
-- erased from the audit log. Redefined from its latest body (018500 deal_lines); only
-- 'quotes' in the child list and the quote lines loop are added.
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

  -- tasks, files, notes and deal lines (DLI-01) that were linked to it and no longer exist: by the
  -- ids in their entries, and for notes by every record they were ever linked to
  for v_child in
    select distinct a.entity_type, a.entity_id from public.audit_log a
     where a.organization_id = p_org and a.entity_type in ('tasks', 'files', 'activities', 'deal_lines', 'quotes') and a.entity_id is not null
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

  -- QUO-01: the lines of those quotes (their entries carry quote_id, not the record's id)
  for v_child in
    select distinct a.entity_type, a.entity_id from public.audit_log a
     where a.organization_id = p_org and a.entity_type = 'quote_lines' and a.entity_id is not null
       and coalesce(a.changes ->> 'quote_id', a.changes -> 'quote_id' ->> 'old') = any (
             select substr(c, length('quotes:') + 1) from unnest(v_children) c where c like 'quotes:%')
  loop
    execute 'select exists (select 1 from public.quote_lines where organization_id = $1 and id = $2)'
      into v_exists using p_org, v_child.entity_id;
    if not v_exists then
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end if;
  end loop;

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

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, p_actor, 'erase', p_type, p_id, jsonb_build_object('entries', v_count));
  return v_count;
end;
$$;

revoke all on function app.audit_erase_core(uuid, text, uuid, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- PRM-01 undo of one's own import: a record with a quote is worked on.
-- Redefined from its latest body (020090 contact_relations); only the quote checks are added.
-- ----------------------------------------------------------------------------
create or replace function app.import_record_worked(p_org uuid, p_type text, p_id uuid, p_since timestamptz, p_job uuid)
returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_col text := case p_type when 'lead' then 'lead_id' when 'contact' then 'contact_id'
                            when 'company' then 'company_id' when 'deal' then 'deal_id' end;
  v_found boolean;
begin
  -- an imported task has no records linked to it; its own row is the whole story
  if v_col is null then
    return false;
  end if;
  execute format(
    'select exists (select 1 from public.activities x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.tasks x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.meetings x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.files x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.record_followers x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)',
    v_col)
    into v_found using p_org, p_id, p_since;
  if v_found then
    return true;
  end if;
  if p_type = 'lead' then
    return exists (select 1 from public.consents x where x.organization_id = p_org and x.lead_id = p_id and x.created_at > p_since)
        -- CON-06: a referral by the lead, made after the import
        or exists (select 1 from public.contact_relations x where x.organization_id = p_org and x.lead_id = p_id and x.created_at > p_since);
  elsif p_type = 'contact' then
    return exists (select 1 from public.quotes x where x.organization_id = p_org and x.contact_id = p_id)
        or exists (select 1 from public.consents x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since)
        or exists (select 1 from public.contact_channels x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since)
        -- put on a deal later, or a deal from outside this import points at it
        or exists (select 1 from public.deal_contacts x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since)
        or exists (select 1 from public.deals x where x.organization_id = p_org and x.contact_id = p_id
                     and x.import_job_id is distinct from p_job)
        -- CON-05: a company linked, or a role changed, after the import
        or exists (select 1 from public.contact_companies x where x.organization_id = p_org and x.contact_id = p_id
                     and greatest(x.created_at, x.updated_at) > p_since)
        -- CON-06: a relation made after the import, on either side
        or exists (select 1 from public.contact_relations x where x.organization_id = p_org
                     and p_id in (x.contact_id, x.related_contact_id) and x.created_at > p_since);
  elsif p_type = 'company' then
    -- a contact, deal or company from outside this import points at it (made later, or moved onto it later)
    return exists (select 1 from public.quotes x where x.organization_id = p_org and x.company_id = p_id)
        or exists (select 1 from public.contacts x where x.organization_id = p_org and x.company_id = p_id
                     and x.import_job_id is distinct from p_job)
        or exists (select 1 from public.deals x where x.organization_id = p_org and x.company_id = p_id
                     and x.import_job_id is distinct from p_job)
        or exists (select 1 from public.companies x where x.organization_id = p_org and x.parent_company_id = p_id
                     and x.import_job_id is distinct from p_job)
        -- CON-05: someone linked to it, or given a role there, after the import; links of this import's own contacts
        -- (written in a later chunk of it) are not work
        or exists (select 1 from public.contact_companies x where x.organization_id = p_org and x.company_id = p_id
                     and greatest(x.created_at, x.updated_at) > p_since
                     and not exists (select 1 from public.contacts k
                                      where k.organization_id = p_org and k.id = x.contact_id and k.import_job_id = p_job));
  elsif p_type = 'deal' then
    return exists (select 1 from public.quotes x where x.organization_id = p_org and x.deal_id = p_id)
        or exists (select 1 from public.deal_lines x where x.organization_id = p_org and x.deal_id = p_id and x.created_at > p_since)
        or exists (select 1 from public.deal_contacts x where x.organization_id = p_org and x.deal_id = p_id and x.created_at > p_since)
        -- a follow-up deal from outside this import points at it (DEAL-11)
        or exists (select 1 from public.deals x where x.organization_id = p_org and x.previous_deal_id = p_id
                     and x.import_job_id is distinct from p_job);
  end if;
  return false;
end;
$$;
revoke all on function app.import_record_worked(uuid, text, uuid, timestamptz, uuid) from public, anon, authenticated;
