-- =============================================================================
-- FLD-06 part B follow-up (owner, 26 October 2026, DECISIONS.md "החלפת הקובץ של שדה קובץ חובה", answer (ב)): replacing the
-- file of a file field keeps the previous file as the earlier version of the new one
-- =============================================================================
-- The same rule as a document's file (020640): the earlier version stays, is shown in the record's files and counts in
-- storage. Until now *_cf_files_release released (deleted) the old file whenever the value changed.
--   * Replaced (the value moves from one file to another): app.custom_field_file_keep_version links the new file to the old
--     one (files.previous_id), both being files of this record and this field; the old row keeps its custom_field_key, so a
--     field's history stays together. Nothing is deleted. When the link cannot be made (the old file already has a newer
--     version, or the new file has a history of its own: a value set back to an earlier version through the API), the old
--     file is still kept, as a plain earlier file of the field, never deleted.
--   * A merge pick that replaces the kept record's field file goes through the same trigger: the kept record's old file is kept
--     (as the earlier version of the picked one when the link can be made, else as a plain earlier file of the field).
--   * Cleared, the field deleted, a merge's unused duplicate file: unchanged (app.custom_field_file_drop releases the current file as before; a cleared
--     field's earlier versions stay among the record's files, a deleted field takes all its files with it).
--   * The current file stays protected (files_field_guard, record_files_delete via app.field_file_in_use); an earlier version is
--     not in use, so the uploader or an owner/admin removes it like any record file (files_delete), and the version line is
--     relinked by "A_files_relink_versions".
--   * files_custom_field_shape no longer forbids previous_id on a field's file; app.files_field_check refuses every insert that
--     names an earlier version of, or for, a field's file, so only the database links them.
-- Every statement is safe to run twice. No drops, no row removal.

alter table public.files drop constraint if exists files_custom_field_shape;
alter table public.files add constraint files_custom_field_shape
  check (custom_field_key is null
         or (char_length(custom_field_key) between 1 and 100
             and activity_id is null
             and accounting_document_id is null and payment_id is null));

-- ----------------------------------------------------------------------------
-- Linking a replaced field file under the new one (no grants; called by app.custom_field_files_release only)
-- ----------------------------------------------------------------------------
create or replace function app.custom_field_file_keep_version(p_org uuid, p_object text, p_record uuid, p_key text, p_old uuid,
                                                              p_new uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if p_old = p_new then
    return;
  end if;
  update public.files n
     set previous_id = p_old
   where n.organization_id = p_org and n.id = p_new and n.custom_field_key = p_key and n.previous_id is null
     and case p_object when 'lead' then n.lead_id = p_record when 'contact' then n.contact_id = p_record
                       when 'company' then n.company_id = p_record when 'deal' then n.deal_id = p_record else false end
     -- the old file: this record's file of this field, with no newer version yet
     and exists (select 1 from public.files o
                   where o.organization_id = p_org and o.id = p_old and o.custom_field_key = p_key
                     and case p_object when 'lead' then o.lead_id = p_record when 'contact' then o.contact_id = p_record
                                       when 'company' then o.company_id = p_record when 'deal' then o.deal_id = p_record
                                       else false end)
     and not exists (select 1 from public.files x where x.organization_id = p_org and x.previous_id = p_old)
     -- the new file has no history of its own (so the line never loops)
     and not exists (select 1 from public.files x where x.organization_id = p_org and x.previous_id = p_new);
end;
$$;
revoke all on function app.custom_field_file_keep_version(uuid, text, uuid, text, uuid, uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 020905's app.files_field_check: no insert names a version of, or for, a field's file
-- ----------------------------------------------------------------------------
create or replace function app.files_field_check() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_object text;
  v_record uuid;
  v_owner uuid;
  v_team uuid;
  v_found boolean := false;
begin
  -- a field's versions are linked by the database alone when the field's file is replaced (FLD-06 follow-up,
  -- app.custom_field_file_keep_version): no insert names an earlier version of a field's file, and a field's new file never
  -- names an earlier version, for every writer
  if new.previous_id is not null and (new.custom_field_key is not null or exists (
    select 1 from public.files p where p.organization_id = new.organization_id and p.id = new.previous_id and p.custom_field_key is not null
  )) then
    raise exception 'a field''s file has no versions' using errcode = 'P0001', hint = 'file:field';
  end if;
  if new.custom_field_key is null or current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  -- a person who may not write here gets RLS's plain refusal right after
  if not app.can_write(new.organization_id) then
    return new;
  end if;
  v_object := case when new.lead_id is not null then 'lead' when new.contact_id is not null then 'contact'
                   when new.company_id is not null then 'company' when new.deal_id is not null then 'deal' end;
  v_record := coalesce(new.lead_id, new.contact_id, new.company_id, new.deal_id);
  if v_object is null or new.activity_id is not null or not exists (
    select 1 from public.field_definitions f
     where f.organization_id = new.organization_id and f.object_type = v_object and f.key = new.custom_field_key
       and f.field_type = 'file' and f.is_active
  ) then
    raise exception 'not a file field of this record' using errcode = 'P0001', hint = 'file:field';
  end if;
  -- the record as the person reads it (RLS); its value is changed with the same rights, so only an editor uploads
  case v_object
    when 'lead' then select true, x.owner_id, x.team_id into v_found, v_owner, v_team from public.leads x
                      where x.organization_id = new.organization_id and x.id = v_record and x.deleted_at is null;
    when 'contact' then select true, x.owner_id, x.team_id into v_found, v_owner, v_team from public.contacts x
                         where x.organization_id = new.organization_id and x.id = v_record and x.deleted_at is null;
    when 'company' then select true, x.owner_id, x.team_id into v_found, v_owner, v_team from public.companies x
                         where x.organization_id = new.organization_id and x.id = v_record and x.deleted_at is null;
    else select true, x.owner_id, x.team_id into v_found, v_owner, v_team from public.deals x
          where x.organization_id = new.organization_id and x.id = v_record and x.deleted_at is null;
  end case;
  if not coalesce(v_found, false) or not app.can_edit_record(new.organization_id, v_owner, v_team) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function app.files_field_check() from public, anon;
grant execute on function app.files_field_check() to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 020905's app.custom_field_files_release: a replaced file is kept as a version; a cleared one is released as before
-- ----------------------------------------------------------------------------
create or replace function app.custom_field_files_release() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_object text := tg_argv[0];
  r record;
begin
  for r in
    select e.key, e.value #>> '{}' as file_id,
           case when jsonb_typeof(new.custom_fields -> e.key) = 'string' then new.custom_fields ->> e.key end as new_file_id
      from jsonb_each(coalesce(old.custom_fields, '{}'::jsonb)) e
      join public.field_definitions f
        on f.organization_id = old.organization_id and f.object_type = v_object and f.key = e.key and f.field_type = 'file'
     where jsonb_typeof(e.value) = 'string'
       and (new.custom_fields -> e.key) is distinct from e.value
  loop
    if r.file_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      if r.new_file_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        -- FLD-06 follow-up (owner, 26 October 2026, answer (ב)): a replaced file is kept as the earlier version of the new one
        perform app.custom_field_file_keep_version(old.organization_id, v_object, old.id, r.key, r.file_id::uuid, r.new_file_id::uuid);
      else
        -- cleared: released as before
        perform app.custom_field_file_drop(old.organization_id, v_object, old.id, r.key, r.file_id::uuid);
      end if;
    end if;
  end loop;
  return null;
end;
$$;
revoke all on function app.custom_field_files_release() from public, anon, authenticated;
