-- =============================================================================
-- FLD-06 part B follow-up (owner, 26 October 2026): a record link emptied by a purge leaves a timeline entry
-- =============================================================================
-- * When a record link is emptied because its target was purged for good (app.record_links_clear_ids, called by the
--   *_record_links_clear statement triggers), every linking record gets one `system` entry per emptied field:
--   "הקישור ל-<type> הוסר: הרשומה נמחקה", where <type> is ליד / איש קשר / חברה / עסקה. Never the removed record's name.
--   metadata = {kind: 'record_link_removed', field_key, target_type}; no author (activities_zz_record_link_entry_author).
--   The app draws the text from metadata.target_type in the business's own words (FLD-10, recordTypeNames); the stored
--   body keeps today's words for every other reader.
-- * A merge repoints links (app.merge_field_links) and writes no entry. A business being deleted does nothing
--   (app.org_exists, unchanged).
-- * A person (owners and admins too) never writes, changes or deletes such an entry: app.activities_record_link_entry_guard
--   (invoker; current_user = 'authenticated'), hint activity:record_link_entry. The insert policy of 0072 already refuses a
--   person's `system` entry; the update and delete policies let an admin reach system entries, so the guard is needed.
-- * Privacy erasure: the entry holds no name, no value and no id of the removed record, so app.audit_erase_core is
--   unchanged.
-- app.record_links_clear_ids is the body of 20261006020905 with each update returning the linking ids and the entry
-- written from them. Every statement is safe to run twice. No drops, no row removal.

-- ----------------------------------------------------------------------------
-- The entry
-- ----------------------------------------------------------------------------
create or replace function app.record_links_clear_ids(p_org uuid, p_type text, p_ids text[]) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  r record;
  v_prev text := current_setting('app.field_links_server', true);
  v_body text := 'הקישור ל-' || case p_type when 'lead' then 'ליד' when 'contact' then 'איש קשר'
                                            when 'company' then 'חברה' when 'deal' then 'עסקה' else 'רשומה' end
                 || ' הוסר: הרשומה נמחקה';
  v_meta jsonb;
begin
  if p_ids is null or cardinality(p_ids) = 0 or not app.org_exists(p_org) then
    return;
  end if;
  -- the server's own link write: the automation guard lets it pass (review F1)
  perform set_config('app.field_links_server', 'on', true);
  for r in
    select f.object_type, f.key from public.field_definitions f
     where f.organization_id = p_org and f.field_type = 'record_link' and f.link_target = p_type
  loop
    -- FLD-06 part B follow-up: one system entry on each record whose link was emptied (the type only, never a name)
    v_meta := jsonb_build_object('kind', 'record_link_removed', 'field_key', r.key, 'target_type', p_type);
    case r.object_type
      when 'lead' then
        with u as (
          update public.leads t set custom_fields = t.custom_fields - r.key
           where t.organization_id = p_org and t.custom_fields ->> r.key = any (p_ids)
          returning t.id
        )
        insert into public.activities (organization_id, type, lead_id, body, metadata)
        select p_org, 'system', u.id, v_body, v_meta from u;
      when 'contact' then
        with u as (
          update public.contacts t set custom_fields = t.custom_fields - r.key
           where t.organization_id = p_org and t.custom_fields ->> r.key = any (p_ids)
          returning t.id
        )
        insert into public.activities (organization_id, type, contact_id, body, metadata)
        select p_org, 'system', u.id, v_body, v_meta from u;
      when 'company' then
        with u as (
          update public.companies t set custom_fields = t.custom_fields - r.key
           where t.organization_id = p_org and t.custom_fields ->> r.key = any (p_ids)
          returning t.id
        )
        insert into public.activities (organization_id, type, company_id, body, metadata)
        select p_org, 'system', u.id, v_body, v_meta from u;
      when 'deal' then
        with u as (
          update public.deals t set custom_fields = t.custom_fields - r.key
           where t.organization_id = p_org and t.custom_fields ->> r.key = any (p_ids)
          returning t.id
        )
        insert into public.activities (organization_id, type, deal_id, body, metadata)
        select p_org, 'system', u.id, v_body, v_meta from u;
      else
        null;
    end case;
  end loop;
  perform set_config('app.field_links_server', coalesce(v_prev, ''), true);
end;
$$;
revoke all on function app.record_links_clear_ids(uuid, text, text[]) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- A person never writes, changes or deletes the entry (owners and admins too)
-- ----------------------------------------------------------------------------
-- SECURITY INVOKER on purpose: current_user tells a person's write from the server's (purge, merge, erasure pass).
create or replace function app.activities_record_link_entry_guard() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  if tg_op in ('UPDATE', 'DELETE') and coalesce(old.metadata ->> 'kind', '') = 'record_link_removed' then
    raise exception 'a removed record link on the timeline is history' using errcode = '42501', hint = 'activity:record_link_entry';
  end if;
  if tg_op in ('INSERT', 'UPDATE') and coalesce(new.metadata ->> 'kind', '') = 'record_link_removed' then
    raise exception 'only the server writes a removed record link entry' using errcode = '42501', hint = 'activity:record_link_entry';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
revoke all on function app.activities_record_link_entry_guard() from public, anon, authenticated, service_role;

create or replace trigger activities_record_link_entry_guard before insert or update or delete on public.activities
  for each row execute function app.activities_record_link_entry_guard();

-- the entry has no author (touch_row would name the person whose purge removed the target)
create or replace function app.activities_record_link_entry_author() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_by := null;
  return new;
end;
$$;
revoke all on function app.activities_record_link_entry_author() from public, anon, authenticated, service_role;

create or replace trigger activities_zz_record_link_entry_author before insert on public.activities
  for each row when (new.type = 'system' and coalesce(new.metadata ->> 'kind', '') = 'record_link_removed')
  execute function app.activities_record_link_entry_author();
