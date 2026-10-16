-- =============================================================================
-- GAP-09: a payment schedule in a quote
-- =============================================================================
-- Contractors work in milestones; until now a schedule existed only in an order (an optional module). A quote may carry
-- rows of name, percent and when (a date, or a short milestone, or both), shown on its document and on the customer's
-- page (QUO-08).
--
-- * public.quote_payment_steps: one row per step (organization, quote, position, name 1..80, percent_bp 1..10000,
--   due_date, milestone 1..120; a date or a milestone at least). FK to the quote with cascade. At most 20 per quote
--   (hint quote_schedule:max), and the steps of a quote never pass 100% (hint quote_schedule:over); a draft may be
--   incomplete (lead's default, 16 October 2026).
-- * Rights follow the quote, exactly like quote_lines: select = the quote is readable; insert, update and delete = a
--   draft the caller may edit (app.quote_editable). Definer trigger app.quote_payment_steps_check (outsider guard first,
--   as app.quote_lines_check) keeps the caps and refuses any insert, update or delete once the quote is no longer a draft,
--   for every writer (hint quote:frozen); it takes the quote FOR SHARE, so it and quote_send (FOR UPDATE) never overlap.
--   A cascade from the quote (or the business) still removes them: the quote is gone by then.
-- * public.quote_send (020270 body) refuses a quote whose schedule does not add up to exactly 100% (hint
--   quote:schedule_total); a quote with no schedule is sent as before.
-- * app.quote_schedule(org, quote, total) (definer, no grants) answers the rows the customer needs: name, percent_bp,
--   due_date, milestone and amount_agorot, in order, no ids. Amounts are the total's cumulative shares, half up, so they
--   add up to the total exactly (mirrored by scheduleAmounts() in src/features/quotes/schedule.ts, unit test).
--   public.quote_public (020290 body) adds it as 'schedule'.
-- * Audited (app.audit_row), no emit_event. app.audit_erase_core (020270 body) erases the schedule's entries with the
--   quote's lines.
-- Every statement is safe to run twice. No drops, no row removal.

create table if not exists public.quote_payment_steps (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  quote_id         uuid not null,
  position         integer not null default 0 check (position between 0 and 100000),
  name             text not null check (char_length(btrim(name)) between 1 and 80),
  percent_bp       integer not null check (percent_bp between 1 and 10000),
  due_date         date,
  milestone        text check (milestone is null or char_length(btrim(milestone)) between 1 and 120),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, id),
  constraint quote_payment_steps_quote_fk foreign key (organization_id, quote_id)
    references public.quotes (organization_id, id) on delete cascade,
  constraint quote_payment_steps_when check (due_date is not null or milestone is not null)
);

create index if not exists quote_payment_steps_quote_idx on public.quote_payment_steps (organization_id, quote_id, position);

alter table public.quote_payment_steps enable row level security;

revoke all on public.quote_payment_steps from anon, authenticated;
grant select, delete on public.quote_payment_steps to authenticated;
grant insert (organization_id, quote_id, position, name, percent_bp, due_date, milestone) on public.quote_payment_steps to authenticated;
grant update (position, name, percent_bp, due_date, milestone) on public.quote_payment_steps to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_payment_steps' and policyname = 'quote_payment_steps_select') then
    create policy quote_payment_steps_select on public.quote_payment_steps for select to authenticated
      using (exists (select 1 from public.quotes q where q.organization_id = quote_payment_steps.organization_id and q.id = quote_payment_steps.quote_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_payment_steps' and policyname = 'quote_payment_steps_insert') then
    create policy quote_payment_steps_insert on public.quote_payment_steps for insert to authenticated
      with check (exists (select 1 from public.quotes q
                           where q.organization_id = quote_payment_steps.organization_id and q.id = quote_payment_steps.quote_id
                             and q.status = 'draft' and app.quote_editable(q.organization_id, q.deal_id, q.contact_id)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_payment_steps' and policyname = 'quote_payment_steps_update') then
    create policy quote_payment_steps_update on public.quote_payment_steps for update to authenticated
      using (exists (select 1 from public.quotes q
                      where q.organization_id = quote_payment_steps.organization_id and q.id = quote_payment_steps.quote_id
                        and q.status = 'draft' and app.quote_editable(q.organization_id, q.deal_id, q.contact_id)))
      with check (exists (select 1 from public.quotes q
                           where q.organization_id = quote_payment_steps.organization_id and q.id = quote_payment_steps.quote_id
                             and q.status = 'draft' and app.quote_editable(q.organization_id, q.deal_id, q.contact_id)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_payment_steps' and policyname = 'quote_payment_steps_delete') then
    create policy quote_payment_steps_delete on public.quote_payment_steps for delete to authenticated
      using (exists (select 1 from public.quotes q
                      where q.organization_id = quote_payment_steps.organization_id and q.id = quote_payment_steps.quote_id
                        and q.status = 'draft' and app.quote_editable(q.organization_id, q.deal_id, q.contact_id)));
  end if;
end;
$$;

-- The caps, and the lock once the quote is no longer a draft (every writer)
create or replace function app.quote_payment_steps_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row public.quote_payment_steps;
  v_quote public.quotes;
begin
  -- a delete cascading from the quote or the business (a nested trigger) is never refused
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  v_row := case when tg_op = 'DELETE' then old else new end;
  -- FOR SHARE: a step written while the quote is being sent waits for quote_send (FOR UPDATE), then sees it sent;
  -- and quote_send waits for a step written first, then counts it
  select * into v_quote from public.quotes q where q.organization_id = v_row.organization_id and q.id = v_row.quote_id for share;
  -- outsider guard: RLS refuses (42501) a person who may not edit the quote
  if auth.uid() is not null and (not found or not app.quote_editable(v_quote.organization_id, v_quote.deal_id, v_quote.contact_id)) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if not found then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if v_quote.status <> 'draft' then
    raise exception 'the payment schedule of a quote that is no longer a draft cannot change' using errcode = 'P0001', hint = 'quote:frozen';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if tg_op = 'UPDATE' and (new.quote_id is distinct from old.quote_id or new.organization_id is distinct from old.organization_id) then
    raise exception 'a step stays in its quote' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('quote_payment_steps:' || new.quote_id::text, 0));
  if tg_op = 'INSERT' and (select count(*) from public.quote_payment_steps s
                            where s.organization_id = new.organization_id and s.quote_id = new.quote_id) >= 20 then
    raise exception 'at most 20 payment steps in a quote' using errcode = 'P0001', hint = 'quote_schedule:max';
  end if;
  if new.percent_bp + coalesce((select sum(s.percent_bp) from public.quote_payment_steps s
                                 where s.organization_id = new.organization_id and s.quote_id = new.quote_id
                                   and s.id <> new.id), 0) > 10000 then
    raise exception 'the payment schedule passes 100%%' using errcode = 'P0001', hint = 'quote_schedule:over';
  end if;
  new.name := btrim(new.name);
  new.milestone := nullif(btrim(new.milestone), '');
  return new;
end;
$$;
revoke all on function app.quote_payment_steps_check() from public, anon, authenticated;

create or replace trigger quote_payment_steps_check before insert or update or delete on public.quote_payment_steps
  for each row execute function app.quote_payment_steps_check();
create or replace trigger quote_payment_steps_touch before insert or update on public.quote_payment_steps
  for each row execute function app.touch_row();
create or replace trigger quote_payment_steps_audit after insert or update or delete on public.quote_payment_steps
  for each row execute function app.audit_row();

-- The rows the customer needs, in order, with each one's share of the total; no ids
create or replace function app.quote_schedule(p_org uuid, p_quote uuid, p_total bigint) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'name', r.name,
           'percent_bp', r.percent_bp,
           'due_date', r.due_date,
           'milestone', r.milestone,
           -- cumulative shares, half up: the amounts add up to the total when the percents add up to 100%
           'amount_agorot', round(p_total::numeric * r.cum / 10000) - round(p_total::numeric * (r.cum - r.percent_bp) / 10000))
         order by r.position, r.id), '[]'::jsonb)
    from (select s.id, s.position, s.name, s.percent_bp, s.due_date, s.milestone,
                 sum(s.percent_bp) over (order by s.position, s.id) as cum
            from public.quote_payment_steps s
           where s.organization_id = p_org and s.quote_id = p_quote) r;
$$;
revoke all on function app.quote_schedule(uuid, uuid, bigint) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Sending: 020270's quote_send, plus the schedule check
-- ----------------------------------------------------------------------------
create or replace function public.quote_send(p_org uuid, p_quote uuid) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_quote public.quotes;
  v_contact record;
  v_company_name text;
  v_name text;
  v_number bigint;
  v_display text;
begin
  select * into v_quote from public.quotes q where q.organization_id = p_org and q.id = p_quote for update;
  if not found or not app.quote_editable(p_org, v_quote.deal_id, v_quote.contact_id) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_quote.status <> 'draft' then
    raise exception 'the quote was already sent' using errcode = 'P0001', hint = 'quote:frozen';
  end if;
  if not app.org_has_feature(p_org, 'quotes') then
    raise exception 'quotes are not in this plan' using errcode = 'P0001', hint = 'feature:quotes';
  end if;
  if not exists (select 1 from public.quote_lines l where l.organization_id = p_org and l.quote_id = p_quote and l.kind = 'item') then
    raise exception 'a quote needs a line' using errcode = 'P0001', hint = 'quote:empty';
  end if;
  -- GAP-09: a payment schedule, when the quote has one, adds up to exactly 100% when it is sent
  if exists (select 1 from public.quote_payment_steps s where s.organization_id = p_org and s.quote_id = p_quote)
     and (select sum(s.percent_bp) from public.quote_payment_steps s where s.organization_id = p_org and s.quote_id = p_quote) <> 10000 then
    raise exception 'the payment schedule must add up to 100%%' using errcode = 'P0001', hint = 'quote:schedule_total';
  end if;
  if v_quote.no_vat_reason is null and app.org_document_vat_rate(p_org, v_quote.quote_date) is null then
    raise exception 'the VAT status of the business is not set' using errcode = 'P0001', hint = 'quote:vat_unknown';
  end if;

  -- the customer as the quote names it (CON-08 order)
  select c.full_name, c.billing_name, co.name as company_name, co.billing_name as company_billing_name into v_contact
    from public.contacts c left join public.companies co on co.organization_id = c.organization_id and co.id = c.company_id
   where c.organization_id = p_org and c.id = v_quote.contact_id;
  select co.name into v_company_name from public.companies co where co.organization_id = p_org and co.id = v_quote.company_id;
  v_name := coalesce(v_contact.billing_name, v_contact.company_billing_name, v_contact.company_name, v_company_name, v_contact.full_name);

  select n.o_number, n.o_display into v_number, v_display from app.next_document_number(p_org, 'quote') n;

  update public.quotes q
     set status = 'sent', sent_at = now(), number = v_number, number_display = v_display,
         customer_name = v_name,
         customer_contact_name = case when v_contact.full_name is distinct from v_name then v_contact.full_name end
   where q.organization_id = p_org and q.id = p_quote;
  return jsonb_build_object('number', v_display);
end;
$$;
revoke all on function public.quote_send(uuid, uuid) from public, anon;
grant execute on function public.quote_send(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The customer's page: 020290's quote_public, plus the schedule
-- ----------------------------------------------------------------------------
create or replace function public.quote_public(p_token text) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_link app.quote_links;
  v_quote public.quotes;
  v_count integer;
  v_design public.quote_designs;
  v_settings public.org_document_settings;
  v_org public.organizations;
  v_show_details boolean;
  v_show_logo boolean;
  v_lines jsonb;
  v_built_with boolean;
  v_schedule jsonb;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_link from app.quote_links l where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_quote from public.quotes q where q.organization_id = v_link.organization_id and q.id = v_link.quote_id;
  if not found or not app.quote_link_open(v_quote)
     or not app.org_public_pages_open(v_quote.organization_id)
     or not app.org_has_feature(v_quote.organization_id, 'quotes') then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;

  -- 120 views per link in 10 minutes; counted first, so the limit holds under parallel load
  update app.quote_links l
     set window_started_at = case when l.window_started_at > now() - interval '10 minutes' then l.window_started_at else now() end,
         window_count = case when l.window_started_at > now() - interval '10 minutes' then l.window_count + 1 else 1 end
   where l.quote_id = v_link.quote_id
  returning l.window_count into v_count;
  if v_count > 120 then
    return jsonb_build_object('rate_limited', true);
  end if;

  select * into v_org from public.organizations o where o.id = v_quote.organization_id;
  select * into v_design from public.quote_designs d where d.organization_id = v_quote.organization_id;
  select * into v_settings from public.org_document_settings s where s.organization_id = v_quote.organization_id;
  -- QUO-05: no design row = the defaults (logo and business details shown)
  v_show_details := coalesce(v_design.show_business_details, true);
  v_show_logo := coalesce(v_design.show_logo, true);

  select coalesce(jsonb_agg(jsonb_build_object(
           'position', l.position,
           'kind', l.kind,
           'name', l.name,
           'description', l.description,
           'unit_name', l.unit_name,
           'quantity', l.quantity,
           'unit_price_agorot', l.unit_price_agorot,
           'discount_bp', l.discount_bp,
           'discount_agorot', l.discount_agorot,
           'vat_exempt', l.vat_exempt,
           'billing', l.billing,
           'is_optional', l.is_optional,
           'optional_selected', l.optional_selected,
           'total_agorot', l.total_agorot) order by l.position, l.id), '[]'::jsonb)
    into v_lines
    from public.quote_lines l
   where l.organization_id = v_quote.organization_id and l.quote_id = v_quote.id;

  -- GAP-09: the payment schedule, with each row's share of the total (the shares add up to the total)
  v_schedule := app.quote_schedule(v_quote.organization_id, v_quote.id, v_quote.total_agorot);

  begin
    v_built_with := coalesce(app.show_built_with(v_quote.organization_id), true);
  exception when others then
    v_built_with := true;
  end;

  return jsonb_build_object(
    'quote', jsonb_build_object(
      'number', v_quote.number_display,
      'title', v_quote.title,
      'status', v_quote.status,
      'quote_date', v_quote.quote_date,
      'valid_until', v_quote.valid_until,
      'sent_at', v_quote.sent_at,
      'prices_include_vat', v_quote.prices_include_vat,
      'no_vat_reason', v_quote.no_vat_reason,
      'no_vat_note', v_quote.no_vat_note,
      'discount_bp', v_quote.discount_bp,
      'discount_agorot', v_quote.discount_agorot,
      'notes', v_quote.notes,
      'terms', v_quote.terms,
      'vat_rate_bp', v_quote.vat_rate_bp,
      'subtotal_agorot', v_quote.subtotal_agorot,
      'discount_total_agorot', v_quote.discount_total_agorot,
      'net_total_agorot', v_quote.net_total_agorot,
      'vat_agorot', v_quote.vat_agorot,
      'total_agorot', v_quote.total_agorot,
      'currency', v_quote.currency),
    -- the customer as printed when the quote was sent (QUO-07); never the live record
    'customer', jsonb_build_object('name', v_quote.customer_name, 'contact', v_quote.customer_contact_name),
    'lines', v_lines,
    'schedule', v_schedule,
    -- documents use the registered name when set (owner); the rest only when the design shows the details
    'business', jsonb_build_object(
      'name', coalesce(nullif(btrim(v_settings.legal_name), ''), v_org.name),
      'tax_id', case when v_show_details then v_settings.tax_id end,
      'address_line', case when v_show_details then v_settings.address_line end,
      'city', case when v_show_details then v_settings.city end,
      'postal_code', case when v_show_details then v_settings.postal_code end,
      'phone', case when v_show_details then v_settings.phone end,
      'email', case when v_show_details then v_settings.email end),
    'design', jsonb_build_object(
      'header_text', v_design.header_text,
      'footer_text', v_design.footer_text,
      'show_logo', v_show_logo,
      'show_business_details', v_show_details,
      'accent_color', v_design.accent_color),
    'brand', jsonb_build_object('logo', case when v_show_logo then v_org.logo_path end, 'color', v_org.brand_color),
    'built_with', v_built_with);
end;
$$;
revoke all on function public.quote_public(text) from public, anon, authenticated;
grant execute on function public.quote_public(text) to service_role;

-- ----------------------------------------------------------------------------
-- Privacy erasure: 020270's body; the schedule's entries are erased with the quote's lines
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
         set customer_name = null, customer_contact_name = null, notes = null, title = 'הצעת מחיר'
       where q.organization_id = p_org and q.status <> 'draft'
         and ((p_type = 'contacts' and q.former_contact_id = p_id) or (p_type = 'deals' and q.former_deal_id = p_id))
      returning 'quotes'::text as entity_type, q.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
  end if;

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
