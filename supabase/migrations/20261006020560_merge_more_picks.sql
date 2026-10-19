-- =============================================================================
-- More fields a merge can take from the duplicate (RVW-26)
-- =============================================================================
-- Goes through the connector, after 20261006020555_merge_delete_duplicate.sql (pasted by hand, it holds the
-- one delete): merge_records below calls app.merge_delete_duplicate. The code that offers the new fields is
-- pushed after both.
--
-- RVW-26 (review of 15 October 2026): every column of the duplicate that app.merge_columns() does not list is lost in a
-- merge. Now also pickable (shown on the merge screen, src/features/merge/fields.ts MERGE_FIELDS):
-- * lead: preferred_locale, preferred_channel, requested_product_id;
-- * contact: type_id, preferred_locale, preferred_channel, billing_name, billing_tax_id, billing_address,
--   shipping_address, billing_email, payment_terms, price_list_id;
-- * company: type_id, billing_name, billing_address, shipping_address, billing_email, payment_terms, price_list_id.
-- And taken together with the field they belong to, never offered alone (MERGE_COMPANIONS):
-- * contact phone -> phone_type, email -> email_type (the type of the primary phone / email, CON-01);
-- * preferred_channel -> preferred_channel_source (form | manual, CON-10);
-- * payment_terms -> payment_days (constraint *_payment_terms_shape judges the pair);
-- * company tax_id -> country (the number is checked against its country, CON-04).
-- Deals are not a merge type, so recurring revenue (DEAL-07) has nothing to add here.
-- companies.parent_company_id stays out (its own checks: readable live parent, the tree trigger).
--
-- app.merge_pick_check(org, type, keep, merge, cols) (no grants; called only by merge_records, which has already
-- checked the caller's rights on both records). public.merge_records is security definer, so the triggers that judge
-- a person's write (they look at current_user) let its updates through; a merge is a person's choice, so the values
-- it takes over are judged here by the same rules:
-- * type_id (contact, company): an active type of that object type in this business (hint 'record_type:invalid');
-- * requested_product_id (lead): an offerable product (hint 'lead:requested_product') in a plan with products
--   (hint 'feature:products');
-- * tax_id / country (company): the RESULTING pair (each the picked value, else the kept one) meets
--   app.check_company_tax_id's rule (0078): foreign = 2..30 letters, digits, spaces, dots, slashes or dashes (hint
--   'tax_id:invalid_foreign'), Israeli = app.valid_israeli_id (hint 'tax_id:invalid'); a pair equal to the kept
--   record's passes, as an unchanged update does;
-- * preferred_channel_source is taken only together with preferred_channel (22023);
-- * a value equal to the kept record's own passes; an empty value always passes.
-- price_list_id is a composite foreign key (the same business, as for a person), and the shapes (phone/email types,
-- language, channel, payment terms, billing tax id) are check constraints every writer meets.
--
-- app.merge_columns (last 0090) gains the columns above. public.merge_records (last 0090) changes in four ways only:
-- * the picked columns are written in ONE update (an owner still brings their team), so a pair whose constraint spans
--   both columns (payment_terms + payment_days) is judged as a whole; before, one column at a time could fail half way;
-- * before writing, app.merge_pick_check judges the picks; after writing, a company number is stored the way
--   app.check_company_tax_id stores a person's (trimmed, an Israeli one padded to 9 digits);
-- * the duplicate is removed by app.merge_delete_duplicate (020555), so this file holds no delete statement.
-- Safe to run twice.

create or replace function app.merge_pick_check(p_org uuid, p_type text, p_keep jsonb, p_merge jsonb, p_cols text[])
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_value   uuid;
  v_tax     text;
  v_country text;
begin
  if 'preferred_channel_source' = any (p_cols) and not 'preferred_channel' = any (p_cols) then
    raise exception 'field preferred_channel_source is merged only with preferred_channel' using errcode = '22023';
  end if;

  if p_type = 'company' and ('tax_id' = any (p_cols) or 'country' = any (p_cols)) then
    v_tax := case when 'tax_id' = any (p_cols) then p_merge ->> 'tax_id' else p_keep ->> 'tax_id' end;
    v_country := case when 'country' = any (p_cols) then p_merge ->> 'country' else p_keep ->> 'country' end;
    if v_tax is not null
       and (v_tax is distinct from p_keep ->> 'tax_id' or v_country is distinct from p_keep ->> 'country') then
      if v_country is distinct from 'IL' then
        if btrim(v_tax, E' \t\r\n') !~ '^[A-Za-z0-9 ./-]{2,30}$' then
          raise exception 'invalid company number' using errcode = 'P0001', hint = 'tax_id:invalid_foreign';
        end if;
      elsif not app.valid_israeli_id(v_tax) then
        raise exception 'invalid company number' using errcode = 'P0001', hint = 'tax_id:invalid';
      end if;
    end if;
  end if;

  if p_type in ('contact', 'company') and 'type_id' = any (p_cols) then
    v_value := (p_merge ->> 'type_id')::uuid;
    if v_value is not null and v_value is distinct from (p_keep ->> 'type_id')::uuid
       and not exists (select 1 from public.record_type_options r
                        where r.organization_id = p_org and r.id = v_value and r.object_type = p_type and r.is_active) then
      raise exception 'pick a type from the list' using errcode = 'P0001', hint = 'record_type:invalid';
    end if;
  end if;

  if p_type = 'lead' and 'requested_product_id' = any (p_cols) then
    v_value := (p_merge ->> 'requested_product_id')::uuid;
    if v_value is not null and v_value is distinct from (p_keep ->> 'requested_product_id')::uuid then
      if not exists (select 1 from public.products p
                      where p.organization_id = p_org and p.id = v_value and p.is_active and p.archived_at is null) then
        raise exception 'the requested product is not available' using errcode = 'P0001', hint = 'lead:requested_product';
      end if;
      if not app.org_has_feature(p_org, 'products') then
        raise exception 'products are not in this plan' using errcode = 'P0001', hint = 'feature:products';
      end if;
    end if;
  end if;
end;
$$;
revoke all on function app.merge_pick_check(uuid, text, jsonb, jsonb, text[]) from public, anon, authenticated, service_role;

create or replace function app.merge_columns(p_type text) returns text[]
language sql immutable
set search_path = ''
as $$
  select case p_type
    when 'lead' then array['full_name', 'email', 'phone', 'company_name', 'job_title', 'status_id', 'disqualify_reason',
                           'source_id', 'campaign', 'message', 'budget_agorot', 'owner_id',
                           'preferred_locale', 'preferred_channel', 'preferred_channel_source', 'requested_product_id']
    when 'contact' then array['first_name', 'last_name', 'email', 'email_type', 'phone', 'phone_type', 'job_title', 'company_id',
                              'source_id', 'address_line', 'city', 'birth_date', 'owner_id', 'type_id',
                              'preferred_locale', 'preferred_channel', 'preferred_channel_source',
                              'billing_name', 'billing_tax_id', 'billing_address', 'shipping_address', 'billing_email',
                              'payment_terms', 'payment_days', 'price_list_id']
    when 'company' then array['name', 'tax_id', 'country', 'industry', 'website', 'email', 'phone', 'address_line', 'city',
                              'owner_id', 'type_id', 'billing_name', 'billing_address', 'shipping_address', 'billing_email',
                              'payment_terms', 'payment_days', 'price_list_id']
  end;
$$;
revoke all on function app.merge_columns(text) from public, anon;
grant execute on function app.merge_columns(text) to authenticated;

create or replace function public.merge_records(p_org uuid, p_type text, p_keep uuid, p_merge uuid, p_picks jsonb default '{}'::jsonb)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_table   text;
  v_keep    jsonb;
  v_merge   jsonb;
  v_allowed text[] := app.merge_columns(p_type);
  v_col     text;
  v_cols    text[];
  v_name    text;
begin
  if v_allowed is null then
    raise exception 'unknown record type' using errcode = '22023';
  end if;
  if p_keep = p_merge then
    raise exception 'a record cannot be merged with itself' using errcode = '22023';
  end if;
  v_table := case p_type when 'lead' then 'leads' when 'contact' then 'contacts' else 'companies' end;
  execute format('select to_jsonb(t) from public.%I t where organization_id = $1 and id = $2 and deleted_at is null', v_table)
    into v_keep using p_org, p_keep;
  execute format('select to_jsonb(t) from public.%I t where organization_id = $1 and id = $2 and deleted_at is null', v_table)
    into v_merge using p_org, p_merge;
  if v_keep is null or v_merge is null
     or not app.org_writable(p_org)
     or not app.can_edit_record(p_org, (v_keep ->> 'owner_id')::uuid, (v_keep ->> 'team_id')::uuid)
     or not app.can_delete_record(p_org, (v_merge ->> 'owner_id')::uuid, (v_merge ->> 'team_id')::uuid) then
    raise exception 'not found or not permitted' using errcode = '42501';
  end if;
  if p_type = 'lead' and v_keep ->> 'converted_at' is not null and v_merge ->> 'converted_at' is not null then
    raise exception 'both leads were converted' using errcode = 'P0001', hint = 'merge:both_converted';
  end if;

  -- the fields picked from the duplicate (an owner comes with their team), judged by a person's rules and written in one
  -- update, so columns that are checked together (payment_terms + payment_days) are judged together (RVW-26)
  select coalesce(array_agg(key order by key), '{}') into v_cols
    from jsonb_each_text(coalesce(p_picks, '{}'::jsonb)) where value = 'merge';
  foreach v_col in array v_cols loop
    if not v_col = any (v_allowed) then
      raise exception 'field % cannot be merged', v_col using errcode = '22023';
    end if;
  end loop;
  if cardinality(v_cols) > 0 then
    perform app.merge_pick_check(p_org, p_type, v_keep, v_merge, v_cols);
    if 'owner_id' = any (v_cols) then
      v_cols := v_cols || 'team_id'::text;
    end if;
    execute format('update public.%1$I k set (%2$s) = row(%3$s) from public.%1$I m where k.id = $1 and m.id = $2',
                   v_table,
                   (select string_agg(format('%I', c), ', ' order by n) from unnest(v_cols) with ordinality u(c, n)),
                   (select string_agg(format('m.%I', c), ', ' order by n) from unnest(v_cols) with ordinality u(c, n)))
      using p_keep, p_merge;
    -- a company number stored the way app.check_company_tax_id stores a person's (merge_pick_check judged the pair)
    if p_type = 'company' and ('tax_id' = any (v_cols) or 'country' = any (v_cols)) then
      update public.companies
         set tax_id = case when country = 'IL' then lpad(tax_id, 9, '0') else btrim(tax_id, E' \t\r\n') end
       where organization_id = p_org and id = p_keep and tax_id is not null
         and tax_id is distinct from (case when country = 'IL' then lpad(tax_id, 9, '0') else btrim(tax_id, E' \t\r\n') end);
    end if;
  end if;

  -- tags joined; custom fields joined, the kept record's values winning
  execute format(
    'update public.%1$I k set tag_ids = array(select distinct unnest(k.tag_ids || m.tag_ids)),
                             custom_fields = m.custom_fields || k.custom_fields
       from public.%1$I m where k.id = $1 and m.id = $2', v_table)
    using p_keep, p_merge;

  -- a converted duplicate passes its conversion to the kept lead
  if p_type = 'lead' and v_merge ->> 'converted_at' is not null then
    update public.leads k
       set converted_at = m.converted_at, converted_contact_id = m.converted_contact_id,
           converted_company_id = m.converted_company_id, converted_deal_id = m.converted_deal_id, status_id = m.status_id
      from public.leads m where k.id = p_keep and m.id = p_merge;
  end if;

  perform app.merge_move_links(p_org, p_type, p_keep, p_merge);

  v_name := coalesce(nullif(v_merge ->> 'full_name', ''), nullif(v_merge ->> 'name', ''), v_merge ->> 'email', v_merge ->> 'phone', '');
  execute format(
    'insert into public.activities (organization_id, type, body, metadata, %I, created_by)
     values ($1, ''system'', $2, $3, $4, $5)', p_type || '_id')
    using p_org, 'מוזג עם רשומה כפולה: ' || v_name, jsonb_build_object('merged_id', p_merge, 'merged', v_merge), p_keep, auth.uid();

  perform app.merge_delete_duplicate(p_org, v_table, p_merge);
end;
$$;

revoke all on function app.merge_columns(text) from public, anon;
grant execute on function app.merge_columns(text) to authenticated;
revoke all on function app.merge_move_links(uuid, text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.merge_records(uuid, text, uuid, uuid, jsonb) from public, anon;
grant execute on function public.merge_records(uuid, text, uuid, uuid, jsonb) to authenticated;
