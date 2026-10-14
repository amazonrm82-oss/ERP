-- =============================================================================
-- Product lines on a deal (DLI-01, DLI-02, PL-03 for deal lines; wave 2)
-- =============================================================================
-- SPEC-ADDITIONS 4.5: a "מוצרים" section on the deal card. A line: product
-- (optional; a free line without a product is allowed), description, quantity,
-- unit price, line discount (DSC-01, the line part: a percentage OR an amount),
-- and its amount. The deal value is NOT computed from the lines (DLI-03 is a
-- later requirement); deals.amount_agorot and DEAL-07's amount_auto stay as they are.
--
-- public.deal_lines, one row per line:
--   position            the order on the card (the app appends at max + 1).
--   product_id          composite FK with NO on delete action, like every
--                       document-lines table (PRD-02, CLAUDE.md "Products"): a
--                       product on a line can only be archived. Set once, on
--                       insert (column grants); null = a free line.
--   description         copied from the product's name when it is picked
--                       (PRD-03: a later change of the product never changes
--                       the line), editable; 1..1000 characters.
--   quantity            > 0, at most 3 decimals, at most 1,000,000 (the limits
--                       of app.document_totals); a quantity with more decimals is
--                       refused, never rounded (unconstrained numeric + check).
--   unit_price_agorot   integer agorot, as typed in the line's VAT mode.
--   discount_bp,        the line discount: basis points (1..10000) or a fixed
--   discount_agorot     amount in agorot, not both (deal_lines_one_discount).
--   total_agorot        server only: quantity x price - discount, half up, as
--                       typed, computed by app.document_totals() on the line
--                       alone (the one totals rule; a discount larger than the
--                       amount is refused there, hint totals:invalid).
--   price_includes_vat  server rule on insert, never changed: the mode of the
--                       deal's existing lines, else the business's setting
--                       (org_document_settings.prices_include_vat, TAX-04; no row
--                       = false). One mode per deal, so the lines add up through
--                       app.document_totals / documentTotals(). A writer may
--                       send the mode it priced the line in; a different one is
--                       refused (hint deal_lines:vat_mode), so a price is never
--                       read in the wrong mode.
--   vat_exempt          a product line: copied from the product on insert (vat_kind
--                       <> 'taxable') and never changed; whatever a writer sends
--                       is overridden. A free line: the person's choice, "פטור
--                       ממע"מ" (owner, 14 October 2026; default false), on insert
--                       and update. A business that charges no VAT does not show
--                       the choice; the stored value is kept.
--   price_source        product | price_list | manual: where the unit price
--                       came from when the line was saved (PL-03); a free line is
--                       always manual.
--   price_list_id,      the customer's price list that set the price (composite
--   price_list_name     FK, on delete set null of the column); the name is
--                       copied by the server when the list is set, so the card
--                       still says which list was used after it is renamed or
--                       removed. Only with price_source = 'price_list'.
--                       price_source is a person's claim (informational): the
--                       server must verify it before quotes and documents rely
--                       on it. For a person's write, 'price_list' needs a list
--                       and any other source none (hint deal_lines:price_list);
--                       setting or changing the list needs the plan flag
--                       'price_lists' (hint feature:price_lists).
--   currency            ILS only until DEAL-12 (TAX-06).
--
-- Rights follow the deal: read when the caller reads the deal; insert, update
-- and delete when they may edit the deal (app.can_edit_record, which includes a
-- writable organization) and the deal is not in the recycle bin. Every policy
-- carries the tenant check itself (org of the line = org of the deal).
-- Plan flags (owner, 14 October 2026; both open in every plan today): a line with
-- a product needs 'products' (hint feature:products); a line discount needs
-- 'discounts' (hint feature:discounts), checked when the discount is set or
-- changed. At most 200 lines per deal (hint deal_lines:max), under an advisory
-- lock per deal. A person may add only an offerable product (active, not
-- archived; hint deal_lines:product).
--
-- app.deal_lines_check is security definer (it reads the business setting, the
-- product and the price list whatever the caller's grants) and starts with the
-- outsider guard of the quota triggers: a person who may not edit the deal is
-- left to RLS (42501) and learns nothing about the plan or the catalog.
--
-- app.sample_untouched() (USR-04) is redefined from its latest body (0155-10,
-- consents_followups) with one more rule: a sample deal with lines is real work.
-- app.audit_erase_core() (privacy erasure) is redefined from its latest body (same
-- migration) with 'deal_lines' among the child entries it erases: a purged deal's
-- lines leave their description in their audit entries otherwise.
--
-- Audited (configuration of a business record). Exported in the full export.
-- Every statement is safe to run twice. No drops, no row removal.

create table if not exists public.deal_lines (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  deal_id            uuid not null,
  position           integer not null default 0 check (position between 0 and 100000),
  product_id         uuid,
  description        text not null check (char_length(btrim(description)) between 1 and 1000),
  quantity           numeric not null default 1,
  unit_price_agorot  bigint not null default 0 check (unit_price_agorot between 0 and 1000000000000),
  discount_bp        integer check (discount_bp is null or discount_bp between 1 and 10000),
  discount_agorot    bigint check (discount_agorot is null or discount_agorot between 1 and 1000000000000),
  total_agorot       bigint not null default 0,
  price_includes_vat boolean not null,
  vat_exempt         boolean not null default false,
  price_source       text not null default 'manual' check (price_source in ('product', 'price_list', 'manual')),
  price_list_id      uuid,
  price_list_name    text,
  currency           text not null default 'ILS' check (currency = 'ILS'),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (organization_id, id),
  constraint deal_lines_deal_fk foreign key (organization_id, deal_id)
    references public.deals (organization_id, id) on delete cascade,
  -- no action: a product on a line cannot be removed, only archived (PRD-02)
  constraint deal_lines_product_fk foreign key (organization_id, product_id)
    references public.products (organization_id, id),
  constraint deal_lines_price_list_fk foreign key (organization_id, price_list_id)
    references public.price_lists (organization_id, id) on delete set null (price_list_id),
  constraint deal_lines_quantity check (quantity > 0 and quantity <= 1000000 and quantity = round(quantity, 3)),
  constraint deal_lines_one_discount check (discount_bp is null or discount_agorot is null),
  constraint deal_lines_free_manual check (product_id is not null or price_source = 'manual'),
  constraint deal_lines_list_source check (price_source = 'price_list' or price_list_id is null)
);

create index if not exists deal_lines_deal_idx on public.deal_lines (organization_id, deal_id, position);
-- removing a product or a price list looks up its lines
create index if not exists deal_lines_product_idx on public.deal_lines (organization_id, product_id) where product_id is not null;
create index if not exists deal_lines_price_list_idx on public.deal_lines (organization_id, price_list_id) where price_list_id is not null;

alter table public.deal_lines enable row level security;

revoke all on public.deal_lines from anon, authenticated;
grant select, delete on public.deal_lines to authenticated;
grant insert (organization_id, deal_id, position, product_id, description, quantity, unit_price_agorot, discount_bp,
              discount_agorot, price_includes_vat, vat_exempt, price_source, price_list_id, currency)
  on public.deal_lines to authenticated;
grant update (position, description, quantity, unit_price_agorot, discount_bp, discount_agorot, vat_exempt,
              price_source, price_list_id, currency)
  on public.deal_lines to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'deal_lines' and policyname = 'deal_lines_select') then
    create policy deal_lines_select on public.deal_lines for select to authenticated
      using (exists (select 1 from public.deals d
                      where d.organization_id = deal_lines.organization_id and d.id = deal_lines.deal_id
                        and app.can_read_record(d.organization_id, d.owner_id, d.team_id)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'deal_lines' and policyname = 'deal_lines_insert') then
    create policy deal_lines_insert on public.deal_lines for insert to authenticated
      with check (exists (select 1 from public.deals d
                           where d.organization_id = deal_lines.organization_id and d.id = deal_lines.deal_id
                             and d.deleted_at is null
                             and app.can_edit_record(d.organization_id, d.owner_id, d.team_id)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'deal_lines' and policyname = 'deal_lines_update') then
    create policy deal_lines_update on public.deal_lines for update to authenticated
      using (exists (select 1 from public.deals d
                      where d.organization_id = deal_lines.organization_id and d.id = deal_lines.deal_id
                        and d.deleted_at is null
                        and app.can_edit_record(d.organization_id, d.owner_id, d.team_id)))
      with check (exists (select 1 from public.deals d
                           where d.organization_id = deal_lines.organization_id and d.id = deal_lines.deal_id
                             and d.deleted_at is null
                             and app.can_edit_record(d.organization_id, d.owner_id, d.team_id)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'deal_lines' and policyname = 'deal_lines_delete') then
    create policy deal_lines_delete on public.deal_lines for delete to authenticated
      using (exists (select 1 from public.deals d
                      where d.organization_id = deal_lines.organization_id and d.id = deal_lines.deal_id
                        and d.deleted_at is null
                        and app.can_edit_record(d.organization_id, d.owner_id, d.team_id)));
  end if;
end;
$$;

create or replace trigger deal_lines_touch before update on public.deal_lines
  for each row execute function app.touch_row();
create or replace trigger deal_lines_audit after insert or update or delete on public.deal_lines
  for each row execute function app.audit_row();

-- Server-set columns, plan flags, the cap, the mode and the line total, for every writer.
create or replace function app.deal_lines_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_mode boolean;
  v_kind text;
  v_active boolean;
  v_archived timestamptz;
  v_name text;
  v_totals jsonb;
begin
  -- A person who may not edit this deal is refused by RLS (42501) right after this
  -- trigger; answering here would tell them about the plan or the catalog.
  -- auth.uid(), not current_user: inside a definer current_user is the owner.
  if auth.uid() is not null and not exists (
       select 1 from public.deals d
        where d.organization_id = new.organization_id and d.id = new.deal_id
          and app.can_edit_record(d.organization_id, d.owner_id, d.team_id)) then
    new.price_includes_vat := coalesce(new.price_includes_vat, false);
    return new;
  end if;

  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtextextended('deal_lines:' || new.deal_id::text, 0));
    if (select count(*) from public.deal_lines l
         where l.organization_id = new.organization_id and l.deal_id = new.deal_id) >= 200 then
      raise exception 'at most 200 lines in a deal' using errcode = 'P0001', hint = 'deal_lines:max';
    end if;
    -- one VAT mode per deal: its lines', else the business's setting
    select l.price_includes_vat into v_mode
      from public.deal_lines l
     where l.organization_id = new.organization_id and l.deal_id = new.deal_id
     order by l.created_at, l.id
     limit 1;
    if not found then
      v_mode := coalesce((select s.prices_include_vat from public.org_document_settings s
                           where s.organization_id = new.organization_id), false);
    end if;
    if new.price_includes_vat is null then
      new.price_includes_vat := v_mode;
    elsif new.price_includes_vat <> v_mode then
      raise exception 'the line is priced in another VAT mode than the deal' using errcode = 'P0001', hint = 'deal_lines:vat_mode';
    end if;

    if new.product_id is not null then
      if not app.org_has_feature(new.organization_id, 'products') then
        raise exception 'products are not in this plan' using errcode = 'P0001', hint = 'feature:products';
      end if;
      select p.vat_kind, p.is_active, p.archived_at into v_kind, v_active, v_archived
        from public.products p
       where p.organization_id = new.organization_id and p.id = new.product_id;
      if found then
        -- a person adds only an offerable product (PRD-02); a server copy keeps what it copies
        if auth.uid() is not null and (not v_active or v_archived is not null) then
          raise exception 'the product cannot be offered' using errcode = 'P0001', hint = 'deal_lines:product';
        end if;
        new.vat_exempt := v_kind <> 'taxable';
      end if;
      -- not found: the foreign key refuses the row (23503)
    else
      -- a free line: the person's choice
      new.vat_exempt := coalesce(new.vat_exempt, false);
    end if;
  else
    -- the deal, the product and the mode never change on a line; a product line's
    -- exemption is the product's, a free line's is the person's
    new.organization_id := old.organization_id;
    new.deal_id := old.deal_id;
    new.product_id := old.product_id;
    new.price_includes_vat := old.price_includes_vat;
    if old.product_id is not null then
      new.vat_exempt := old.vat_exempt;
    else
      new.vat_exempt := coalesce(new.vat_exempt, old.vat_exempt);
    end if;
  end if;

  if (new.discount_bp is not null or new.discount_agorot is not null)
     and (tg_op = 'INSERT' or new.discount_bp is distinct from old.discount_bp
          or new.discount_agorot is distinct from old.discount_agorot)
     and not app.org_has_feature(new.organization_id, 'discounts') then
    raise exception 'discounts are not in this plan' using errcode = 'P0001', hint = 'feature:discounts';
  end if;

  -- which price list set the price; its name is kept with the line. The source is a
  -- person's claim (informational), held to its shape here for a person's write.
  if new.price_source <> 'price_list' then
    if new.price_list_id is not null and auth.uid() is not null then
      raise exception 'only a price from a price list names a list' using errcode = 'P0001', hint = 'deal_lines:price_list';
    end if;
    new.price_list_id := null;
    new.price_list_name := null;
  elsif new.price_list_id is not null
        and (tg_op = 'INSERT' or new.price_list_id is distinct from old.price_list_id) then
    if not app.org_has_feature(new.organization_id, 'price_lists') then
      raise exception 'price lists are not in this plan' using errcode = 'P0001', hint = 'feature:price_lists';
    end if;
    select l.name into v_name
      from public.price_lists l
     where l.organization_id = new.organization_id and l.id = new.price_list_id;
    new.price_list_name := v_name;
  elsif tg_op = 'INSERT' then
    raise exception 'a price from a price list names the list' using errcode = 'P0001', hint = 'deal_lines:price_list';
  elsif old.price_list_id is not null and new.price_list_id is null
        and not exists (select 1 from public.price_lists l
                         where l.organization_id = old.organization_id and l.id = old.price_list_id) then
    -- the list was removed (on delete set null): the name stays, as it was used
    new.price_list_name := old.price_list_name;
  elsif new.price_list_id is null and old.price_source = 'price_list' and old.price_list_id is null then
    -- its list was removed earlier: the line keeps the name it was priced by
    new.price_list_name := old.price_list_name;
  elsif new.price_list_id is null then
    raise exception 'a price from a price list names the list' using errcode = 'P0001', hint = 'deal_lines:price_list';
  else
    new.price_list_name := old.price_list_name;
  end if;

  -- the line's amount by the one totals rule (TAX-05), as typed in the line's mode
  v_totals := app.document_totals(
    jsonb_build_array(jsonb_build_object(
      'quantity', new.quantity,
      'unit_price_agorot', new.unit_price_agorot,
      'discount_bp', new.discount_bp,
      'discount_agorot', new.discount_agorot,
      'vat_exempt', new.vat_exempt)),
    0, new.price_includes_vat);
  new.total_agorot := (v_totals #>> '{lines,0,total_agorot}')::bigint;
  return new;
end;
$$;
revoke all on function app.deal_lines_check() from public, anon, authenticated;

create or replace trigger deal_lines_check before insert or update on public.deal_lines
  for each row execute function app.deal_lines_check();

-- ----------------------------------------------------------------------------
-- USR-04: a sample deal with product lines is real work (kept on removal).
-- Redefined from its latest body (consents_followups); only the deal branch changes.
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
       and not exists (select 1 from public.consents cn where cn.organization_id = p_org and cn.lead_id = p_id);
  elsif p_type = 'contact' then
    return not exists (select 1 from public.deal_contacts dc where dc.organization_id = p_org and dc.contact_id = p_id)
       and not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_contact_id = p_id)
       and not exists (select 1 from public.deals d where d.organization_id = p_org and d.contact_id = p_id
                         and not app.sample_untouched_id(p_org, 'deal', d.id))
       -- CON-01: sample data adds no further phones or emails; one added is real work
       and not exists (select 1 from public.contact_channels ch where ch.organization_id = p_org and ch.contact_id = p_id)
       -- CNS-01: a consent recorded on it
       and not exists (select 1 from public.consents cn where cn.organization_id = p_org and cn.contact_id = p_id);
  elsif p_type = 'company' then
    return not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_company_id = p_id)
       and not exists (select 1 from public.companies c where c.organization_id = p_org and c.parent_company_id = p_id)
       and not exists (select 1 from public.contacts c where c.organization_id = p_org and c.company_id = p_id
                         and not app.sample_untouched_id(p_org, 'contact', c.id))
       and not exists (select 1 from public.deals d where d.organization_id = p_org and d.company_id = p_id
                         and not app.sample_untouched_id(p_org, 'deal', d.id));
  else -- deal
    return not exists (select 1 from public.deal_contacts dc where dc.organization_id = p_org and dc.deal_id = p_id)
       and not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_deal_id = p_id)
       -- DLI-01: sample data adds no product lines; one added is real work
       and not exists (select 1 from public.deal_lines dl where dl.organization_id = p_org and dl.deal_id = p_id);
  end if;
end;
$$;
revoke all on function app.sample_untouched(uuid, text, uuid, jsonb) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Privacy erasure: a purged deal's product lines are erased with it (their entries
-- carry deal_id; update entries are found by the line's id). Redefined from its
-- latest body (consents_followups); only the child list changes.
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
     where a.organization_id = p_org and a.entity_type in ('tasks', 'files', 'activities', 'deal_lines') and a.entity_id is not null
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
