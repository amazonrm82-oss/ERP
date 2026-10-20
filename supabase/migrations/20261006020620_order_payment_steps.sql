-- =============================================================================
-- ORD-04 part one: a payment schedule on orders (owner, 20 October 2026, DECISIONS.md "הזמנות: לוח תשלומים")
-- =============================================================================
-- The mechanism of quotes' payment steps (GAP-09, 020310), on orders. No "how much was billed and paid" yet: that comes
-- with DOC/PAY.
--
-- * public.order_payment_steps: one row per step (organization, order, position, name 1..80, percent_bp 1..10000,
--   due_date, milestone 1..120; a date or a milestone at least). FK to the order with cascade (only a draft is ever
--   deleted). At most 20 per order (hint order_schedule:max); the steps of an order never pass 100% (hint
--   order_schedule:over); a draft may be incomplete.
-- * Rights follow the order, exactly like order_lines: select = the order is readable; insert, update and delete = a draft
--   the caller may edit (app.order_editable). Definer trigger app.order_payment_steps_check (outsider guard first, as
--   app.quote_payment_steps_check) keeps the caps and refuses any insert, update or delete once the order is no longer a
--   draft, for every writer (hint order:frozen); it takes the order FOR SHARE against order_confirm's FOR UPDATE. A
--   cascade from the order (or the business) still removes them.
-- * public.order_from_quote (020570 body): copies the accepted quote's schedule with its lines, before the order is
--   numbered, so it is frozen like the lines.
-- * public.order_confirm (020570 body): a manual order is confirmed only with no schedule or one of exactly 100% (hint
--   order:schedule_total), quote_send's rule. An order from a quote got its quote's schedule, already 100% when sent.
-- * Audited (app.audit_row), no emit_event. app.audit_erase_core (020570 body) erases the entries of a gone order's steps
--   with its lines' (the steps of a kept order stay, as a quote's: owner, 18 October 2026).
-- Every statement is safe to run twice. No drops, no row removal.

create table if not exists public.order_payment_steps (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  order_id         uuid not null,
  position         integer not null default 0 check (position between 0 and 100000),
  name             text not null check (char_length(btrim(name)) between 1 and 80),
  percent_bp       integer not null check (percent_bp between 1 and 10000),
  due_date         date,
  milestone        text check (milestone is null or char_length(btrim(milestone)) between 1 and 120),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, id),
  constraint order_payment_steps_order_fk foreign key (organization_id, order_id)
    references public.orders (organization_id, id) on delete cascade,
  constraint order_payment_steps_when check (due_date is not null or milestone is not null)
);

create index if not exists order_payment_steps_order_idx on public.order_payment_steps (organization_id, order_id, position);

alter table public.order_payment_steps enable row level security;

revoke all on public.order_payment_steps from anon, authenticated;
grant select, delete on public.order_payment_steps to authenticated;
grant insert (organization_id, order_id, position, name, percent_bp, due_date, milestone) on public.order_payment_steps to authenticated;
grant update (position, name, percent_bp, due_date, milestone) on public.order_payment_steps to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'order_payment_steps' and policyname = 'order_payment_steps_select') then
    create policy order_payment_steps_select on public.order_payment_steps for select to authenticated
      using (exists (select 1 from public.orders o where o.organization_id = order_payment_steps.organization_id and o.id = order_payment_steps.order_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'order_payment_steps' and policyname = 'order_payment_steps_insert') then
    create policy order_payment_steps_insert on public.order_payment_steps for insert to authenticated
      with check (exists (select 1 from public.orders o
                           where o.organization_id = order_payment_steps.organization_id and o.id = order_payment_steps.order_id
                             and o.status = 'draft' and app.order_editable(o.organization_id, o.deal_id, o.contact_id, o.company_id)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'order_payment_steps' and policyname = 'order_payment_steps_update') then
    create policy order_payment_steps_update on public.order_payment_steps for update to authenticated
      using (exists (select 1 from public.orders o
                      where o.organization_id = order_payment_steps.organization_id and o.id = order_payment_steps.order_id
                        and o.status = 'draft' and app.order_editable(o.organization_id, o.deal_id, o.contact_id, o.company_id)))
      with check (exists (select 1 from public.orders o
                           where o.organization_id = order_payment_steps.organization_id and o.id = order_payment_steps.order_id
                             and o.status = 'draft' and app.order_editable(o.organization_id, o.deal_id, o.contact_id, o.company_id)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'order_payment_steps' and policyname = 'order_payment_steps_delete') then
    create policy order_payment_steps_delete on public.order_payment_steps for delete to authenticated
      using (exists (select 1 from public.orders o
                      where o.organization_id = order_payment_steps.organization_id and o.id = order_payment_steps.order_id
                        and o.status = 'draft' and app.order_editable(o.organization_id, o.deal_id, o.contact_id, o.company_id)));
  end if;
end;
$$;

-- The caps, and the lock once the order is no longer a draft (every writer)
create or replace function app.order_payment_steps_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row public.order_payment_steps;
  v_order public.orders;
begin
  -- a delete cascading from the order or the business (a nested trigger) is never refused
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  v_row := case when tg_op = 'DELETE' then old else new end;
  -- FOR SHARE: a step written while the order is being confirmed waits for order_confirm (FOR UPDATE), then sees it
  -- numbered; and order_confirm waits for a step written first, then counts it
  select * into v_order from public.orders o where o.organization_id = v_row.organization_id and o.id = v_row.order_id for share;
  -- outsider guard: RLS refuses (42501) a person who may not edit the order
  if auth.uid() is not null and (not found or not app.order_editable(v_order.organization_id, v_order.deal_id, v_order.contact_id, v_order.company_id)) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if not found then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if v_order.status <> 'draft' then
    raise exception 'the payment schedule of a numbered order cannot change' using errcode = 'P0001', hint = 'order:frozen';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if tg_op = 'UPDATE' and (new.order_id is distinct from old.order_id or new.organization_id is distinct from old.organization_id) then
    raise exception 'a step stays in its order' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('order_payment_steps:' || new.order_id::text, 0));
  if tg_op = 'INSERT' and (select count(*) from public.order_payment_steps s
                            where s.organization_id = new.organization_id and s.order_id = new.order_id) >= 20 then
    raise exception 'at most 20 payment steps in an order' using errcode = 'P0001', hint = 'order_schedule:max';
  end if;
  if new.percent_bp + coalesce((select sum(s.percent_bp) from public.order_payment_steps s
                                 where s.organization_id = new.organization_id and s.order_id = new.order_id
                                   and s.id <> new.id), 0) > 10000 then
    raise exception 'the payment schedule passes 100%%' using errcode = 'P0001', hint = 'order_schedule:over';
  end if;
  new.name := btrim(new.name);
  new.milestone := nullif(btrim(new.milestone), '');
  return new;
end;
$$;
revoke all on function app.order_payment_steps_check() from public, anon, authenticated;

create or replace trigger order_payment_steps_check before insert or update or delete on public.order_payment_steps
  for each row execute function app.order_payment_steps_check();
create or replace trigger order_payment_steps_touch before insert or update on public.order_payment_steps
  for each row execute function app.touch_row();
create or replace trigger order_payment_steps_audit after insert or update or delete on public.order_payment_steps
  for each row execute function app.audit_row();

-- ----------------------------------------------------------------------------
-- Confirming a manual order: 020570's order_confirm, plus the schedule check
-- ----------------------------------------------------------------------------
create or replace function public.order_confirm(p_org uuid, p_order uuid) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_order public.orders;
begin
  select * into v_order from public.orders o where o.organization_id = p_org and o.id = p_order for update;
  if not found or not app.order_editable(p_org, v_order.deal_id, v_order.contact_id, v_order.company_id) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not app.org_has_feature(p_org, 'orders') then
    raise exception 'orders are not in this plan' using errcode = 'P0001', hint = 'feature:orders';
  end if;
  if v_order.status <> 'draft' then
    raise exception 'the order was already confirmed' using errcode = 'P0001', hint = 'order:frozen';
  end if;
  -- ORD-04: a payment schedule, when the order has one, adds up to exactly 100% when it is confirmed (quote_send's rule)
  if exists (select 1 from public.order_payment_steps s where s.organization_id = p_org and s.order_id = p_order)
     and (select sum(s.percent_bp) from public.order_payment_steps s where s.organization_id = p_org and s.order_id = p_order) <> 10000 then
    raise exception 'the payment schedule must add up to 100%%' using errcode = 'P0001', hint = 'order:schedule_total';
  end if;
  return jsonb_build_object('number', app.order_number(p_org, p_order));
end;
$$;
revoke all on function public.order_confirm(uuid, uuid) from public, anon;
grant execute on function public.order_confirm(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- An order from an accepted quote: 020570's order_from_quote, plus the quote's schedule
-- ----------------------------------------------------------------------------
create or replace function public.order_from_quote(p_org uuid, p_quote uuid) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_quote public.quotes;
  v_new uuid;
  v_original uuid;
begin
  select * into v_quote from public.quotes q where q.organization_id = p_org and q.id = p_quote for share;
  if not found or not app.quote_editable(p_org, v_quote.deal_id, v_quote.contact_id) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not app.org_has_feature(p_org, 'orders') then
    raise exception 'orders are not in this plan' using errcode = 'P0001', hint = 'feature:orders';
  end if;
  if v_quote.status <> 'accepted' then
    raise exception 'an order is made from an accepted quote' using errcode = 'P0001', hint = 'order:quote_not_accepted';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('order_from_quote:' || p_quote::text, 0));
  if exists (select 1 from public.orders o where o.organization_id = p_org and o.quote_id = p_quote) then
    raise exception 'the quote already has an order' using errcode = 'P0001', hint = 'order:exists';
  end if;
  -- an accepted addendum is its own order, linked to the original quote's order (owner (3))
  if v_quote.addendum_of is not null then
    select o.id into v_original from public.orders o where o.organization_id = p_org and o.quote_id = v_quote.addendum_of;
  end if;

  perform set_config('app.order_server', 'on', true);
  insert into public.orders (organization_id, status, source, quote_id, original_order_id, deal_id, contact_id, company_id,
                             prices_include_vat, no_vat_reason, no_vat_note, discount_bp, discount_agorot, vat_rate_bp,
                             customer_name, currency)
  values (p_org, 'draft', 'quote', p_quote, v_original, v_quote.deal_id, v_quote.contact_id, v_quote.company_id,
          v_quote.prices_include_vat, v_quote.no_vat_reason, v_quote.no_vat_note, v_quote.discount_bp, v_quote.discount_agorot,
          v_quote.vat_rate_bp, v_quote.customer_name, v_quote.currency)
  returning id into v_new;
  -- the lines the customer accepted: items that count (not optional, or optional and selected) and the group headings
  insert into public.order_lines (organization_id, order_id, position, kind, product_id, name, description, unit_name, quantity,
                                  unit_price_agorot, discount_bp, discount_agorot, vat_exempt, billing, price_source,
                                  price_list_name, currency)
  select l.organization_id, v_new, l.position, l.kind, l.product_id, l.name, l.description, l.unit_name, l.quantity,
         l.unit_price_agorot, l.discount_bp, l.discount_agorot, l.vat_exempt, l.billing, l.price_source,
         l.price_list_name, l.currency
    from public.quote_lines l
   where l.organization_id = p_org and l.quote_id = p_quote
     and (l.kind = 'group' or not l.is_optional or l.optional_selected)
   order by l.position, l.id;
  -- ORD-04 (owner, 20 October 2026): the quote's payment schedule as accepted; frozen with the lines once numbered below
  insert into public.order_payment_steps (organization_id, order_id, position, name, percent_bp, due_date, milestone)
  select s.organization_id, v_new, s.position, s.name, s.percent_bp, s.due_date, s.milestone
    from public.quote_payment_steps s
   where s.organization_id = p_org and s.quote_id = p_quote
   order by s.position, s.id;
  perform set_config('app.order_server', '', true);
  perform app.order_number(p_org, v_new);
  return v_new;
end;
$$;
revoke all on function public.order_from_quote(uuid, uuid) from public, anon;
grant execute on function public.order_from_quote(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Privacy erasure: 020570's app.audit_erase_core, plus the entries of a gone order's payment steps
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
     where a.organization_id = p_org and a.entity_type in ('tasks', 'files', 'activities', 'deal_lines', 'quotes', 'orders') and a.entity_id is not null
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

  -- QUO-01: the lines of those quotes (their entries carry quote_id, not the record's id); GAP-09: and their payment schedule
  for v_child in
    select distinct a.entity_type, a.entity_id from public.audit_log a
     where a.organization_id = p_org and a.entity_type in ('quote_lines', 'quote_payment_steps') and a.entity_id is not null
       and coalesce(a.changes ->> 'quote_id', a.changes -> 'quote_id' ->> 'old') = any (
             select substr(c, length('quotes:') + 1) from unnest(v_children) c where c like 'quotes:%')
  loop
    execute format('select exists (select 1 from public.%I where organization_id = $1 and id = $2)', v_child.entity_type)
      into v_exists using p_org, v_child.entity_id;
    if not v_exists then
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end if;
  end loop;

  -- QUO-07: a sent quote that was detached from the record keeps its number, date and amounts; its
  -- personal details are emptied, and its own entries are erased below with the rest. A draft that
  -- only named the record (a deal's quote naming a purged contact) is the deal's and is left alone.
  if p_type in ('contacts', 'deals') then
    for v_child in
      update public.quotes q
         set customer_name = null, customer_contact_name = null, notes = null, title = 'הצעת מחיר',
             -- QUO-11: the reason staff wrote when cancelling an accepted quote may name the customer
             cancel_reason = null
       where q.organization_id = p_org and q.status <> 'draft'
         and ((p_type = 'contacts' and q.former_contact_id = p_id) or (p_type = 'deals' and q.former_deal_id = p_id))
      returning 'quotes'::text as entity_type, q.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    -- owner, 18 October 2026 (QUO-07): the free text of those quotes' lines goes too: quantity, price and amounts stay;
    -- a free line and a group heading get a neutral name; every description is emptied. Owner, 19 October 2026: a
    -- product line's name that was edited by hand goes too. "Edited by hand" in the data = the stored name differs
    -- (trimmed) from the product's current catalog name; such a line takes the catalog name (not personal), and a
    -- product that is gone leaves the neutral name. A product line still named as in the catalog keeps it. Payment
    -- steps, milestones and terms stay (owner). These lines' entries (the old text included) are erased below.
    for v_child in
      update public.quote_lines l
         set description = null,
             name = case
                      when l.kind = 'group' then 'קבוצה'
                      when l.product_id is null then 'שורה'
                      else coalesce((select p.name from public.products p
                                      where p.organization_id = l.organization_id and p.id = l.product_id), 'שורה')
                    end
       where l.organization_id = p_org
         and l.quote_id = any (select substr(c, length('quotes:') + 1)::uuid from unnest(v_children) c where c like 'quotes:%')
         and exists (select 1 from public.quotes q where q.organization_id = p_org and q.id = l.quote_id and q.status <> 'draft')
      returning 'quote_lines'::text as entity_type, l.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    -- QUO-11: the cancel entry of those quotes on the timeline loses its " · סיבה: …" part (the rest is number and author);
    -- the entries' audit history (the old body included) is erased below with the rest
    for v_child in
      update public.activities ac
         set body = regexp_replace(ac.body, ' · סיבה: .*$', '')
       where ac.organization_id = p_org and ac.metadata ->> 'kind' = 'quote_cancelled'
         and ac.metadata ->> 'quote_id' = any (select substr(c, length('quotes:') + 1) from unnest(v_children) c where c like 'quotes:%')
         and ac.body like '% · סיבה: %'
      returning 'activities'::text as entity_type, ac.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    -- QUO-09 (owner, 18 October 2026): the customer's decision on those quotes keeps what, when and the fingerprint of the
    -- version; the signer's name, ID, signature, IP, browser and reason go (the table is not audited)
    update public.quote_decisions d
       set signer_name = null, signer_id_number = null, signature_image = null, ip = null, user_agent = null,
           decline_reason = null, erased_at = coalesce(d.erased_at, now())
     where d.organization_id = p_org
       and d.quote_id = any (select substr(c, length('quotes:') + 1)::uuid from unnest(v_children) c where c like 'quotes:%');
  end if;

  -- ORD-01: an order that was detached from the record keeps its number, date, lines' amounts and totals; the customer's
  -- name, the shipping address and the notes go, and its lines' free text goes as for quotes (a product line takes the
  -- catalog name, a free line and a heading a neutral one, every description is emptied). A draft only loses the
  -- shipping address and the name it may have copied from the record. Its entries are erased below with the rest.
  if p_type in ('contacts', 'companies', 'deals') then
    perform set_config('app.order_server', 'on', true);
    for v_child in
      update public.orders o
         set customer_name = case when o.status <> 'draft' then null else o.customer_name end,
             shipping_address = null,
             notes = case when o.status <> 'draft' then null else o.notes end
       where o.organization_id = p_org
         and ((p_type = 'contacts' and o.former_contact_id = p_id) or (p_type = 'deals' and o.former_deal_id = p_id)
              or (p_type = 'companies' and o.former_company_id = p_id))
      returning 'orders'::text as entity_type, o.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    for v_child in
      update public.order_lines l
         set description = null,
             name = case
                      when l.kind = 'group' then 'קבוצה'
                      when l.product_id is null then 'שורה'
                      else coalesce((select p.name from public.products p
                                      where p.organization_id = l.organization_id and p.id = l.product_id), 'שורה')
                    end
       where l.organization_id = p_org
         and l.order_id = any (select substr(c, length('orders:') + 1)::uuid from unnest(v_children) c where c like 'orders:%')
         and exists (select 1 from public.orders o where o.organization_id = p_org and o.id = l.order_id and o.status <> 'draft')
      returning 'order_lines'::text as entity_type, l.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    perform set_config('app.order_server', '', true);
  end if;
  -- the lines of those orders (kept or gone) that are gone themselves: their entries carry order_id; ORD-04: and their
  -- payment steps, as for quotes (the steps of a kept order stay, like a quote's)
  for v_child in
    select distinct a.entity_type, a.entity_id from public.audit_log a
     where a.organization_id = p_org and a.entity_type in ('order_lines', 'order_payment_steps') and a.entity_id is not null
       and coalesce(a.changes ->> 'order_id', a.changes -> 'order_id' ->> 'old') = any (
             select substr(c, length('orders:') + 1) from unnest(v_children) c where c like 'orders:%')
  loop
    execute format('select exists (select 1 from public.%I where organization_id = $1 and id = $2)', v_child.entity_type)
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
