-- RVW-23 (weekly review of 15 October 2026; BACKLOG "after PRD-05/PRD-08" item 1): the outsider guard
-- at the top of every quota or cap trigger that lacked it.
--
-- A before-insert definer trigger runs before the policy's WITH CHECK. Without the guard a signed-in
-- person who sends another business's organization_id got the quota hint (P0001) when that business was
-- at its cap, and learned something about it (how many reasons, types or templates it has, whether a uuid
-- is a subcategory there, its plan's limits). With the guard, a caller the table's own write policy would
-- refuse gets RLS's plain 42501. The guard's predicate is the write policy's own rule, so nobody who may
-- write skips the check:
--   owners/admins (is_admin): deal_loss_reasons_cap, disqualify_reasons_cap, record_type_options_cap,
--     whatsapp_templates_cap, enforce_count_limit (pipelines, field_definitions), guard_form (max_forms and
--     the webhook flag; the card and widget locks still answer first, they tell nothing about the business)
--   catalog editors (can_edit_catalog, PRM-01): product_units_cap, product_categories_check
--   leave editors (member_hours_editable): member_leaves_limit
--   automation managers (can_manage_automations, PRM-01): guard_automation
--   writers (can_write, files_insert): files_before_insert (storage_gb and the pending cap)
-- Server writers without a session (auth.uid() is null) are checked as before. Each body below is the
-- latest one (pg_get_functiondef of the fresh build) with only the guard added.
--
-- Additive only. Safe to run twice.

create or replace function app.deal_loss_reasons_cap()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- RVW-23: a caller the write policy refuses gets RLS's plain 42501, never this business's quota
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  -- one insert at a time per organization, so two cannot both pass the count
  perform pg_advisory_xact_lock(hashtextextended('deal_loss_reasons:' || new.organization_id::text, 0));
  if (select count(*) from public.deal_loss_reasons r where r.organization_id = new.organization_id) >= 50 then
    raise exception 'too many loss reasons' using errcode = 'P0001', hint = 'reasons:max';
  end if;
  return new;
end;
$function$;

create or replace function app.disqualify_reasons_cap()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- RVW-23: a caller the write policy refuses gets RLS's plain 42501, never this business's quota
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  -- one insert at a time per organization, so two cannot both pass the count
  perform pg_advisory_xact_lock(hashtextextended('disqualify_reasons:' || new.organization_id::text, 0));
  if (select count(*) from public.disqualify_reasons r where r.organization_id = new.organization_id) >= 50 then
    raise exception 'too many disqualify reasons' using errcode = 'P0001', hint = 'reasons:max';
  end if;
  return new;
end;
$function$;

create or replace function app.record_type_options_cap()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- RVW-23: a caller the write policy refuses gets RLS's plain 42501, never this business's quota
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  -- one insert at a time per organization, so two cannot both pass the count
  perform pg_advisory_xact_lock(hashtextextended('record_type_options:' || new.organization_id::text, 0));
  if (select count(*) from public.record_type_options r
       where r.organization_id = new.organization_id and r.object_type = new.object_type) >= 50 then
    raise exception 'too many record types' using errcode = 'P0001', hint = 'record_types:max';
  end if;
  return new;
end;
$function$;

create or replace function app.whatsapp_templates_cap()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- RVW-23: a caller the write policy refuses gets RLS's plain 42501, never this business's quota
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  -- one insert at a time per organization, so two cannot both pass the count
  perform pg_advisory_xact_lock(hashtextextended('whatsapp_templates:' || new.organization_id::text, 0));
  if (select count(*) from public.whatsapp_templates t where t.organization_id = new.organization_id) >= 50 then
    raise exception 'too many whatsapp templates' using errcode = 'P0001', hint = 'whatsapp_templates:max';
  end if;
  return new;
end;
$function$;

create or replace function app.enforce_count_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_key text := tg_argv[0];
  v_limit numeric := app.org_limit(new.organization_id, v_key);
  v_count bigint;
begin
  -- RVW-23: a caller the write policy refuses gets RLS's plain 42501, never this business's quota
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  if v_limit is null then
    return new;
  end if;
  if tg_table_name = 'pipelines' then
    select count(*) into v_count from public.pipelines p
      where p.organization_id = new.organization_id and p.deleted_at is null and p.id <> new.id;
  elsif tg_table_name = 'field_definitions' then
    select count(*) into v_count from public.field_definitions f
      where f.organization_id = new.organization_id and f.object_type = new.object_type
        and f.is_active and f.id <> new.id;
  else
    raise exception 'enforce_count_limit: unsupported table %', tg_table_name;
  end if;
  if v_count + 1 > v_limit then
    raise exception 'plan limit reached (% = %)', v_key, v_limit using errcode = 'P0001', hint = 'limit:' || v_key;
  end if;
  return new;
end;
$function$;

create or replace function app.product_units_cap()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- RVW-23: a caller the write policy refuses gets RLS's plain 42501, never this business's quota
  if auth.uid() is not null and not app.can_edit_catalog(new.organization_id) then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('product_units:' || new.organization_id::text, 0));
  if (select count(*) from public.product_units u where u.organization_id = new.organization_id) >= 50 then
    raise exception 'too many units' using errcode = 'P0001', hint = 'product_units:max';
  end if;
  return new;
end;
$function$;

create or replace function app.product_categories_check()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- RVW-23: a caller the write policy refuses gets RLS's plain 42501, never this business's quota
  if auth.uid() is not null and not app.can_edit_catalog(new.organization_id) then
    return new;
  end if;
  -- one write at a time per organization, so two cannot pass the checks together
  -- (a count race, or A under B while B goes under A)
  perform pg_advisory_xact_lock(hashtextextended('product_categories:' || new.organization_id::text, 0));
  if tg_op = 'INSERT'
     and (select count(*) from public.product_categories c where c.organization_id = new.organization_id) >= 200 then
    raise exception 'too many product categories' using errcode = 'P0001', hint = 'product_categories:max';
  end if;
  if new.parent_id is not null and (tg_op = 'INSERT' or new.parent_id is distinct from old.parent_id) then
    if new.parent_id = new.id then
      raise exception 'a category cannot be its own parent' using errcode = 'P0001', hint = 'product_categories:depth';
    end if;
    -- the parent must be a top category (a missing parent is the FK's error)
    if exists (select 1 from public.product_categories p
                where p.organization_id = new.organization_id and p.id = new.parent_id and p.parent_id is not null) then
      raise exception 'categories have at most two levels' using errcode = 'P0001', hint = 'product_categories:depth';
    end if;
    -- a category with subcategories stays a top category
    if tg_op = 'UPDATE' and exists (select 1 from public.product_categories c
                                     where c.organization_id = new.organization_id and c.parent_id = new.id) then
      raise exception 'categories have at most two levels' using errcode = 'P0001', hint = 'product_categories:depth';
    end if;
  end if;
  return new;
end;
$function$;

create or replace function app.member_leaves_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_cutoff date;
begin
  -- RVW-23: a caller the write policy refuses gets RLS's plain 42501, never this business's quota
  if auth.uid() is not null and not app.member_hours_editable(new.organization_id, new.user_id) then
    return new;
  end if;
  select (now() at time zone app.intake_zone(o.timezone))::date - 1 into v_cutoff
    from public.organizations o where o.id = new.organization_id;
  v_cutoff := coalesce(v_cutoff, current_date - 1);
  if tg_op = 'UPDATE' and new.ends_on < v_cutoff then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('member_leaves:' || new.organization_id::text || ':' || new.user_id::text, 0));
  if (select count(*) from public.member_leaves l
       where l.organization_id = new.organization_id and l.user_id = new.user_id
         and l.id <> new.id
         and l.ends_on >= v_cutoff) >= 100 then
    raise exception 'too many leaves for one member' using errcode = 'P0001', hint = 'member_leaves:max';
  end if;
  return new;
end;
$function$;

create or replace function app.guard_automation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_limit numeric;
  v_count bigint;
begin
  -- RVW-23: a caller the write policy refuses gets RLS's plain 42501, never this business's quota
  if auth.uid() is not null and not app.can_manage_automations(new.organization_id) then
    return new;
  end if;
  if not new.is_active or (tg_op = 'UPDATE' and old.is_active) then
    return new;
  end if;
  v_limit := app.org_limit(new.organization_id, 'max_active_automations');
  if v_limit is not null then
    select count(*) into v_count from public.automations a
     where a.organization_id = new.organization_id and a.is_active and a.id <> new.id;
    if v_count + 1 > v_limit then
      raise exception 'plan limit reached (max_active_automations = %)', v_limit
        using errcode = 'P0001', hint = 'limit:max_active_automations';
    end if;
  end if;
  return new;
end;
$function$;

create or replace function app.guard_form()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_limit numeric;
  v_count bigint;
begin
  if new.kind = 'card' then
    if coalesce(current_setting('app.card_form', true), '') <> 'on' then
      raise exception 'a card form is made with its card' using errcode = 'P0001', hint = 'form:card';
    end if;
    return new;
  end if;
  if new.kind = 'widget' then
    if coalesce(current_setting('app.widget_form', true), '') <> 'on' then
      raise exception 'a widget form is made with its widget' using errcode = 'P0001', hint = 'form:widget';
    end if;
    return new;
  end if;
  -- RVW-23: a caller the write policy refuses gets RLS's plain 42501, never this business's quota
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  if new.kind = 'webhook' then
    if not app.org_has_feature(new.organization_id, 'api') then
      raise exception 'webhooks are not included in this plan' using errcode = 'P0001', hint = 'feature:api';
    end if;
    return new;
  end if;
  v_limit := app.org_limit(new.organization_id, 'max_forms');
  if v_limit is not null then
    select count(*) into v_count from public.forms f
      where f.organization_id = new.organization_id and f.kind = 'form' and f.id <> new.id;
    if v_count + 1 > v_limit then
      raise exception 'plan limit reached (max_forms = %)', v_limit using errcode = 'P0001', hint = 'limit:max_forms';
    end if;
  end if;
  return new;
end;
$function$;

create or replace function app.files_before_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_gb  numeric := app.org_limit(new.organization_id, 'storage_gb');
  v_uid uuid := auth.uid();
begin
  new.storage_path := new.organization_id::text || '/' || new.id::text;
  new.uploaded_by := v_uid;
  new.upload_checked_at := null;
  -- RVW-23: a caller the write policy refuses gets RLS's plain 42501, never this business's quota
  if auth.uid() is not null and not app.can_write(new.organization_id) then
    return new;
  end if;
  if v_uid is not null then
    -- FXS-07: a person's row waits until its upload is confirmed
    new.unconfirmed_since := now();
    perform pg_advisory_xact_lock(hashtextextended('files_pending:' || new.organization_id::text || ':' || v_uid::text, 0));
    if (select count(*) from public.files f
         where f.organization_id = new.organization_id and f.uploaded_by = v_uid
           and f.unconfirmed_since > now() - interval '1 hour') >= 20 then
      raise exception 'too many uploads are waiting for confirmation' using errcode = 'P0001', hint = 'file:pending_max';
    end if;
  end if;
  if v_gb is not null then
    perform pg_advisory_xact_lock(hashtextextended('files_quota:' || new.organization_id::text, 0));
    if not app.files_quota_ok(new.organization_id, new.size_bytes) then
      raise exception 'plan storage limit reached (% GB)', v_gb using errcode = 'P0001', hint = 'limit:storage_gb';
    end if;
  end if;
  return new;
end;
$function$;
