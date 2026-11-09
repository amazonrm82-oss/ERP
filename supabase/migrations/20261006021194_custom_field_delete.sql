-- FLD (owner, 9 November 2026): deleting a custom field that is not in use. Owner's answers of 9 November 2026
-- (DECISIONS.md): (183) ב people's own list columns and private saved views never block; (184) ב only the field's current
-- file and uploads waiting for confirmation block, earlier versions stay as plain files of the record; (185) ב only the
-- lead side of a conversion mapping blocks.
--
-- The settings page offers "מחיקה" next to "הסתרה". The delete itself stays what it was: a person's
-- DELETE on public.field_definitions through PostgREST, under the existing grant and policy
-- (field_definitions_delete: app.is_admin + app.org_writable, so owners and admins of a writable
-- business). What is new is that the database refuses a person's delete while the field is in use,
-- and tells the page why.
--
-- * app.custom_field_uses(org, object, field) (definer, granted to authenticated for the trigger below;
--   app is not in the API) answers (field_id, reason, uses) for one field, or for every field of a record
--   type: counts only, never a value. The reasons:
--     values        a record of the field's type (records in the recycle bin included) holds a non-empty
--                   value under the key (app.custom_value_empty), or app.custom_unique_values holds a
--                   recorded value of the field
--     files         the field's current file on a record of that type (app.field_file_in_use), or an upload for
--                   the field still waiting for confirmation; an earlier version kept by 021020 does not block (184)
--     condition     another field's FLD-09 condition names it as its controller (stored as the bare key, the
--                   rule of app.field_condition_check; "cf:<key>" is matched too)
--     lead_score    a lead score rule (lead fields)
--     automation    an automation's trigger_config, conditions or actions name "cf:<key>" (any record type
--                   of rule: a condition may read a linked record; a key of another record type that happens
--                   to be equal only blocks, the safe side)
--     conversion    a conversion field mapping that picks this lead field onto a target (mode field); a target
--                   field does not block (185): deleting it clears the mapping as before (FK set null, mode none,
--                   target_removed)
--     form          a form's field list (forms take lead fields)
--     card_layout   the card layout of the record type
--     completeness  the completeness setting of the record type
--     saved_view    a saved view of the record type shared with a team or the business; a private view does
--                   not block (183)
--     segment       a segment of the record type
--     routing_rule  a lead routing rule's select field (lead fields)
--   Not counted (183): list_preferences (a person's own list columns and board card fields) and private saved
--   views. They keep the stale "cf:<key>" and the lists skip it as they do today for a field that is gone
--   (resolveColumns keeps only catalog keys; filterToPostgrest skips a condition on an unknown field).
--   Every json setting is matched on the whole stored row as text: "cf:<key>" with no key character on either
--   side, so a sort ("-cf:<key>") and json kept inside a json string (a saved view's filters.f holds the filter
--   tree as text, where the key appears as \"cf:<key>\") are found too, and a later shape of the same settings is
--   still found. Keys are [a-z][a-z0-9_]*, so the key is safe inside the pattern.
--   With a field named (the guard) the values are looked up by that key only, so the exclusive lock is held
--   briefly; the page's form (every field of a record type) expands each record's custom_fields once.
-- * public.custom_field_usage(org, object) (definer, owners/admins only, 42501 otherwise) gives the page
--   one jsonb object {field id: [{reason, uses}]} for a record type.
-- * Trigger field_definitions_delete_guard (before delete, INVOKER: it tells a person's delete by
--   current_user = 'authenticated') takes the exclusive FLD-07 advisory lock of the business and record
--   type (the one app.custom_unique_fill takes; every record write takes it shared in
--   app.custom_unique_sync), so writers in flight end first and their values are seen, then refuses
--   while any use is left (P0001, hint custom_field:in_use, detail = the reasons). Server deletes (the
--   organization's cascade, migrations) are not judged.
-- * A writer whose check (app.check_custom_fields, before) passed while the delete was waiting for the
--   lock would still commit a value under the deleted key. Trigger *_cf_defined_recheck (after insert or
--   update of custom_fields, INVOKER, the same writers app.check_custom_fields judges) takes the shared
--   lock itself and then checks again that every changed, non-empty key still has a definition (hint
--   custom_field:invalid, the existing message "…הוסר בינתיים"). It reads only public.field_definitions.
--   Accepted (review of 9 November 2026): a reference saved at the same moment as the delete (a condition, an
--   automation, a form, a card layout, a completeness setting, a score or routing rule, a saved view, a segment, an
--   upload) is not locked out; it can commit naming a field that is gone. Every reader of those settings skips an
--   unknown key (and an upload for a field that is gone is refused by app.files_field_check from then on).
--   Accepted: a server write (a conversion's carried value, run by a definer function) that races with a
--   delete is not re-checked; it leaves a key without a definition, which nothing shows or judges.
--   Accepted (second review): a person's delete of a UNIQUE field racing a writer of that field's value can meet in
--   40P01 (the delete holds the field row and waits for the exclusive lock; the writer holds the shared lock and needs a
--   key-share on the field row for app.custom_unique_values); one side is aborted and nothing is lost, as with
--   app.custom_unique_fill. An upload that commits while the delete waits keeps the deleted key; a later field with the
--   same key would label that file, which is never "in use".
-- * The existing after-delete triggers stay (lead score requeue, conversion map cascade / set null, unique values
--   cascade), but app.custom_field_files_release_field (trigger field_definitions_files_release) is redefined (184):
--   a deleted file field's files are no longer removed; the server clears their custom_field_key, so each stays a
--   plain file of its record (its previous_id line kept, which the file rules allow for a plain file). No file row is
--   deleted. The business's own cascade still skips it (app.org_exists).
--
-- Safe to run twice. Nothing in this file removes objects or rows.

create or replace function app.custom_field_uses(p_org uuid, p_object text, p_field uuid default null)
returns table (field_id uuid, reason text, uses bigint)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  -- an outsider learns nothing; a server call (no session) is the guard trigger's own path
  if auth.uid() is not null and not app.is_admin(p_org) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_object is null or p_object not in ('lead', 'contact', 'company', 'deal') then
    return;
  end if;
  return query
  with f as (
    select d.id, d.key, '(^|[^a-z0-9_])cf:' || d.key || '([^a-z0-9_]|$)' as pat
      from public.field_definitions d
     where d.organization_id = p_org and d.object_type = p_object and (p_field is null or d.id = p_field)
  ),
  vals as (
    -- one field (the guard): its key only
    select f.key, count(*) as n
      from f join public.leads r on r.organization_id = p_org and r.custom_fields ? f.key
     where p_field is not null and p_object = 'lead' and not app.custom_value_empty(r.custom_fields -> f.key)
     group by f.key
    union all
    select f.key, count(*)
      from f join public.contacts r on r.organization_id = p_org and r.custom_fields ? f.key
     where p_field is not null and p_object = 'contact' and not app.custom_value_empty(r.custom_fields -> f.key)
     group by f.key
    union all
    select f.key, count(*)
      from f join public.companies r on r.organization_id = p_org and r.custom_fields ? f.key
     where p_field is not null and p_object = 'company' and not app.custom_value_empty(r.custom_fields -> f.key)
     group by f.key
    union all
    select f.key, count(*)
      from f join public.deals r on r.organization_id = p_org and r.custom_fields ? f.key
     where p_field is not null and p_object = 'deal' and not app.custom_value_empty(r.custom_fields -> f.key)
     group by f.key
    union all
    -- every field of the record type (the page): each record's values expanded once
    select e.key, count(*)
      from public.leads r cross join lateral jsonb_each(r.custom_fields) e
     where p_field is null and p_object = 'lead' and r.organization_id = p_org and not app.custom_value_empty(e.value)
     group by e.key
    union all
    select e.key, count(*)
      from public.contacts r cross join lateral jsonb_each(r.custom_fields) e
     where p_field is null and p_object = 'contact' and r.organization_id = p_org and not app.custom_value_empty(e.value)
     group by e.key
    union all
    select e.key, count(*)
      from public.companies r cross join lateral jsonb_each(r.custom_fields) e
     where p_field is null and p_object = 'company' and r.organization_id = p_org and not app.custom_value_empty(e.value)
     group by e.key
    union all
    select e.key, count(*)
      from public.deals r cross join lateral jsonb_each(r.custom_fields) e
     where p_field is null and p_object = 'deal' and r.organization_id = p_org and not app.custom_value_empty(e.value)
     group by e.key
  ),
  uses as (
    select f.id, 'values'::text as reason, v.n
      from f join vals v on v.key = f.key
    union all
    select f.id, 'values', (select count(*) from app.custom_unique_values u where u.field_id = f.id and u.norm_value is not null)
      from f
    union all
    select f.id, 'files', (
      select count(*) from public.files x
       where x.organization_id = p_org and x.custom_field_key = f.key
         and (x.unconfirmed_since is not null or app.field_file_in_use(p_org, x.id))
         and case p_object when 'lead' then x.lead_id is not null when 'contact' then x.contact_id is not null
                           when 'company' then x.company_id is not null when 'deal' then x.deal_id is not null else false end)
      from f
    union all
    select f.id, 'condition', (
      select count(*) from public.field_definitions o
       where o.organization_id = p_org and o.object_type = p_object and o.id <> f.id
         and o.condition is not null
         and (o.condition ->> 'field' in (f.key, 'cf:' || f.key) or o.condition -> 'or' ->> 'field' in (f.key, 'cf:' || f.key)))
      from f
    union all
    select f.id, 'lead_score', (
      select count(*) from public.lead_score_rules s
       where s.organization_id = p_org and s.field = 'cf:' || f.key)
      from f where p_object = 'lead'
    union all
    select f.id, 'automation', (
      select count(*) from public.automations a
       where a.organization_id = p_org
         and (a.trigger_config::text ~ f.pat or a.conditions::text ~ f.pat or a.actions::text ~ f.pat))
      from f
    union all
    select f.id, 'conversion', (
      select count(*) from public.conversion_field_maps m
       where m.organization_id = p_org
         and m.lead_field_id = f.id and m.mode = 'field')
      from f
    union all
    select f.id, 'form', (
      select count(*) from public.forms x
       where x.organization_id = p_org and to_jsonb(x)::text ~ f.pat)
      from f where p_object = 'lead'
    union all
    select f.id, 'card_layout', (
      select count(*) from public.card_layouts x
       where x.organization_id = p_org and x.object_type = p_object and to_jsonb(x)::text ~ f.pat)
      from f
    union all
    select f.id, 'completeness', (
      select count(*) from public.completeness_settings x
       where x.organization_id = p_org and x.object_type = p_object and to_jsonb(x)::text ~ f.pat)
      from f
    union all
    select f.id, 'saved_view', (
      select count(*) from public.saved_views x
       where x.organization_id = p_org and x.object_type = p_object and x.scope <> 'private'
         and to_jsonb(x)::text ~ f.pat)
      from f
    union all
    select f.id, 'segment', (
      select count(*) from public.segments x
       where x.organization_id = p_org and x.object_type = p_object and to_jsonb(x)::text ~ f.pat)
      from f where p_object in ('lead', 'contact')
    union all
    select f.id, 'routing_rule', (
      select count(*) from public.lead_routing_rules x
       where x.organization_id = p_org and x.field_key = f.key)
      from f where p_object = 'lead'
  )
  select u.id, u.reason, sum(u.n)::bigint
    from uses u
   where u.n > 0
   group by u.id, u.reason;
end;
$$;

revoke all on function app.custom_field_uses(uuid, text, uuid) from public, anon;
-- the guard trigger below is security invoker (it tells a person's delete by current_user), so a person runs it
grant execute on function app.custom_field_uses(uuid, text, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- The page: every field of a record type and what keeps it
-- -----------------------------------------------------------------------------
create or replace function public.custom_field_usage(p_org uuid, p_object text) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_out jsonb;
begin
  if not app.is_admin(p_org) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  select coalesce(jsonb_object_agg(g.field_id, g.reasons), '{}'::jsonb) into v_out
    from (
      select u.field_id, jsonb_agg(jsonb_build_object('reason', u.reason, 'uses', u.uses) order by u.reason) as reasons
        from app.custom_field_uses(p_org, p_object, null) u
       group by u.field_id
    ) g;
  return v_out;
end;
$$;

revoke all on function public.custom_field_usage(uuid, text) from public, anon;
grant execute on function public.custom_field_usage(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- The guard: a person's delete of a field in use is refused
-- -----------------------------------------------------------------------------
create or replace function app.field_definitions_delete_guard() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_reasons text;
begin
  if current_user <> 'authenticated' then
    return old;
  end if;
  -- the lock FLD-07 writers take shared (app.custom_unique_sync): values written by transactions in
  -- flight are committed before they are counted, and later writers wait for this one
  perform pg_advisory_xact_lock(hashtextextended('custom_unique:' || old.organization_id::text || ':' || old.object_type, 0));
  select string_agg(u.reason, ',' order by u.reason) into v_reasons
    from app.custom_field_uses(old.organization_id, old.object_type, old.id) u;
  if v_reasons is not null then
    raise exception 'the custom field is in use' using errcode = 'P0001', hint = 'custom_field:in_use', detail = v_reasons;
  end if;
  return old;
end;
$$;

revoke all on function app.field_definitions_delete_guard() from public, anon, authenticated;

create or replace trigger field_definitions_delete_guard before delete on public.field_definitions
  for each row execute function app.field_definitions_delete_guard();

-- -----------------------------------------------------------------------------
-- The recheck: a value written while the field was being deleted is refused
-- -----------------------------------------------------------------------------
create or replace function app.custom_fields_defined_recheck() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_object text := tg_argv[0];
  v_old jsonb := '{}'::jsonb;
  v_key text;
begin
  if current_user not in ('authenticated', 'anon') then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    if new.custom_fields is not distinct from old.custom_fields then
      return null;
    end if;
    v_old := coalesce(old.custom_fields, '{}'::jsonb);
  end if;
  if new.custom_fields is null or new.custom_fields = '{}'::jsonb then
    return null;
  end if;
  -- a field delete holds this lock exclusively until it commits; afterwards its row is gone
  perform pg_advisory_xact_lock_shared(hashtextextended('custom_unique:' || new.organization_id::text || ':' || v_object, 0));
  select e.key into v_key
    from jsonb_each(new.custom_fields) e
   where (v_old -> e.key) is distinct from e.value
     and not app.custom_value_empty(e.value)
     and not exists (
       select 1 from public.field_definitions f
        where f.organization_id = new.organization_id and f.object_type = v_object and f.key = e.key)
   limit 1;
  if v_key is not null then
    raise exception 'unknown custom field %', v_key using errcode = 'P0001', hint = 'custom_field:invalid';
  end if;
  return null;
end;
$$;

revoke all on function app.custom_fields_defined_recheck() from public, anon, authenticated;

create or replace trigger leads_cf_defined_recheck after insert or update of custom_fields on public.leads
  for each row execute function app.custom_fields_defined_recheck('lead');
create or replace trigger contacts_cf_defined_recheck after insert or update of custom_fields on public.contacts
  for each row execute function app.custom_fields_defined_recheck('contact');
create or replace trigger companies_cf_defined_recheck after insert or update of custom_fields on public.companies
  for each row execute function app.custom_fields_defined_recheck('company');
create or replace trigger deals_cf_defined_recheck after insert or update of custom_fields on public.deals
  for each row execute function app.custom_fields_defined_recheck('deal');

-- -----------------------------------------------------------------------------
-- (184) ב: a deleted file field's files stay as plain files of their records
-- -----------------------------------------------------------------------------
create or replace function app.custom_field_files_release_field() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if not app.org_exists(old.organization_id) then
    return null;
  end if;
  -- the guard left no current file and no waiting upload for a person's delete; whatever is left (earlier versions,
  -- or anything a server delete leaves) is kept and no longer belongs to the field
  update public.files f
     set custom_field_key = null
   where f.organization_id = old.organization_id and f.custom_field_key = old.key
     and case old.object_type when 'lead' then f.lead_id is not null when 'contact' then f.contact_id is not null
                              when 'company' then f.company_id is not null when 'deal' then f.deal_id is not null else false end;
  return null;
end;
$$;
revoke all on function app.custom_field_files_release_field() from public, anon, authenticated;
