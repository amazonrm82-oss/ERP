-- =============================================================================
-- FLD-06 part B: address, record link and file custom fields (owner, 18 October 2026; every plan, no key)
-- =============================================================================
-- * address: one line of text (up to 500 characters, no line breaks). The app shows it with Waze and Google Maps
--   links built from the text itself (URL-encoded; no API key, no geocoding).
-- * record_link: a link to ONE record. The field names its target type in field_definitions.link_target (lead |
--   contact | company | deal; required for this type and only for it; never changed later, nor the type, hint
--   'custom_field:type_locked'). The value is the record's id. A person's write (app.check_custom_fields, security
--   invoker, so RLS decides) must name a live record (not in the recycle bin) of the same business that the writer
--   can read (hint 'custom_field:record_link'); an unchanged value is never re-judged, so editing another field of a
--   record whose link the editor cannot read is never blocked. The app shows the record's name, with a link, only to
--   a viewer who reads it, else a neutral "רשומה".
--   Purged for good (not the recycle bin): statement triggers *_record_links_clear (after delete, transition table)
--   remove the key from every record of the business whose link field targets that type and holds a removed id
--   (a server write: app.check_custom_fields and FLD-07's read-only rule leave server writes alone; a record link
--   is never unique). Skipped while the business itself is being deleted. A merge first points every link at the
--   duplicate to the kept record (trigger activities_merge_field_links on the "merged" entry), so a merge empties
--   nothing.
-- * file: one file per field. The file is a public.files row (bucket record-files) whose subject is the record and
--   whose new column custom_field_key names the field; the value is the file's id. Why both: the row ties the file
--   to its record (reading follows the record through the files policies as they are; the record's purge takes it
--   by the existing cascade and the existing orphan cleanup removes the object), and the value says which of the
--   field's files is current (a replaced file is released, below). So every upload check of record files applies
--   unchanged: size, type and storage quota (app.files_before_insert), the 20 waiting uploads per hour, and
--   confirm_file_upload. Trigger files_field_check (invoker) lets a person upload a field file only to an active
--   file field of the record's type, on a record they may edit, never on a note or as a version
--   (hint 'file:field'). A person's value must be a confirmed file of that record and that field
--   (hint 'custom_field:file'), so a new record gets its file after it is saved.
--   The current file of a field is never removed by a person directly (trigger files_field_guard and the Storage
--   delete policy, hint 'file:field'): it goes when the value changes or is cleared. Then trigger
--   *_cf_files_release (after update) releases the old file through app.custom_field_file_drop, and deleting a file
--   field releases its files. app.custom_field_file_drop holds a delete, so it is a no-op here and migration
--   20261006020910_field_file_release (pasted by hand) gives it its body; until then a replaced file stays, hidden
--   and counted in the storage, and its uploader or an admin may remove it (it is no longer in use).
--   A merge moves the duplicate's files to the kept record (app.merge_move_links, unchanged); the duplicate's field
--   file that the kept record's value does not use is released by the "merged" entry trigger.
--   Conversion never copies a file value (its file belongs to the lead), and copies a record link only to a field of
--   the same target type (app.carry_custom_fields, the body of 0162 with those two conditions).
-- * Automations (AUT-01 set_field) never set or clear a record link or a file: the engine runs as the server, so
--   trigger *_cf_zz_automation_guard (named to run after *_cf_merge, so a {"$merge"} patch is judged expanded) refuses such a change while app.automation_running is on, with the step error
--   'the value does not fit the field'. The builder does not offer these fields.
-- * A record link or file field has no default value (hint 'custom_field:default'); none of the three is unique
--   (app.field_settings_check's list is unchanged), a condition controller or a score rule other than
--   'filled' / 'empty' (their lists are unchanged).
-- * Purge clearing and merge repointing are ordinary updates of the linking records (audit entry, outbox "updated" event,
--   updated_at), so the importer's "undo own import" (records unchanged) may then refuse such a record (review F7).
-- * The server's own link writes (purge clearing, merge repointing) set app.field_links_server = 'on' around their
--   updates; the automation guard lets them pass (also inside sample_data_remove, which runs with
--   app.automation_running on; review F1). app.sample_untouched is unchanged: removing sample data still removes a
--   sample record a real record links to, and the link is emptied.
-- * A record link or file value is the canonical lower-case uuid text only (ids are compared as text; review F2).
-- * The key and the record type of a record link or file field never change either (review F6).
-- * public.intake_form / public.intake_submit: the bodies of 020830 with only the type skips widened, so a record link
--   or a file field is never on a public form nor read from one (defence in depth; review F3).
-- app.check_custom_fields() is the body of 0175 with the record_link and file lines added (marked FLD-06 part B);
-- app.custom_value_ok() is the body of 020265 with the three types added. Every statement is safe to run twice.
-- No drops of objects, no row removal.

alter table public.field_definitions drop constraint if exists field_definitions_field_type_check;
alter table public.field_definitions add constraint field_definitions_field_type_check check (field_type in (
  'text', 'long_text', 'number', 'currency', 'percent', 'rating',
  'select', 'multi_select', 'checkbox', 'date', 'datetime',
  'phone', 'email', 'url', 'il_id', 'il_company_id', 'user',
  'rich_text', 'duration', 'status',
  'address', 'record_link', 'file'));

-- the record type a record_link field points at (src/features/custom-fields/types.ts LINK_TARGETS)
alter table public.field_definitions add column if not exists link_target text;
alter table public.field_definitions drop constraint if exists field_definitions_link_target_check;
alter table public.field_definitions add constraint field_definitions_link_target_check
  check ((field_type = 'record_link') = (link_target is not null)
         and (link_target is null or link_target in ('lead', 'contact', 'company', 'deal')));

-- -----------------------------------------------------------------------------
-- Values
-- -----------------------------------------------------------------------------
-- 020265's check, plus the three new types
create or replace function app.custom_value_ok(p_type text, p_options jsonb, p_value jsonb) returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  v_text text;
  v_item jsonb;
  v_number numeric;
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then
    return true;
  end if;
  if p_type in ('number', 'currency', 'percent') then
    return jsonb_typeof(p_value) = 'number';
  end if;
  if p_type = 'duration' then
    -- FLD-06: whole minutes, from 0 to a year (values.ts MAX_DURATION_MINUTES)
    if jsonb_typeof(p_value) <> 'number' then
      return false;
    end if;
    v_number := (p_value #>> '{}')::numeric;
    return v_number between 0 and 525600 and v_number = trunc(v_number);
  end if;
  if p_type = 'rating' then
    -- a whole number from 1 to 5, as values.ts (RVW-14)
    if jsonb_typeof(p_value) <> 'number' then
      return false;
    end if;
    v_number := (p_value #>> '{}')::numeric;
    return v_number between 1 and 5 and v_number = trunc(v_number);
  end if;
  if p_type = 'checkbox' then
    return jsonb_typeof(p_value) = 'boolean';
  end if;
  if p_type = 'multi_select' then
    if jsonb_typeof(p_value) <> 'array' then
      return false;
    end if;
    for v_item in select a.value from jsonb_array_elements(p_value) a loop
      if jsonb_typeof(v_item) <> 'string' or not coalesce(p_options, '[]'::jsonb) @> jsonb_build_array(v_item) then
        return false;
      end if;
    end loop;
    return true;
  end if;

  if jsonb_typeof(p_value) <> 'string' then
    return false;
  end if;
  v_text := p_value #>> '{}';
  case p_type
    when 'long_text', 'rich_text' then
      -- rich_text (FLD-06): REC-04's cleaned Markdown, as typed; rendered as React elements, never as HTML
      return char_length(v_text) <= 5000;
    when 'select', 'status' then
      return coalesce(p_options, '[]'::jsonb) @> jsonb_build_array(v_text);
    when 'email' then
      return char_length(v_text) <= 254 and v_text ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$';
    when 'phone' then
      return v_text ~ '^\+?[0-9[:space:]().*-]{3,24}$';
    when 'url' then
      return char_length(v_text) <= 2000 and v_text ~* '^https?://[^[:space:]/]+\.[^[:space:]]+$';
    when 'date' then
      if v_text !~ '^\d{4}-\d{2}-\d{2}$' then
        return false;
      end if;
      begin
        return to_char(v_text::date, 'YYYY-MM-DD') = v_text;
      exception when others then
        return false;
      end;
    when 'datetime' then
      if char_length(v_text) > 40 then
        return false;
      end if;
      begin
        perform v_text::timestamptz;
        return true;
      exception when others then
        return false;
      end;
    when 'user' then
      return v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    when 'record_link', 'file' then
      -- FLD-06 part B: a record link holds the record's id, a file field the file's id, as the canonical lower-case text
      -- (they are compared as text); app.check_custom_fields checks what the id names for a person's write
      return v_text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    when 'il_id', 'il_company_id' then
      return app.valid_israeli_id(v_text);
    when 'address' then
      -- FLD-06 part B: one line of text
      return char_length(v_text) <= 500 and position(chr(10) in v_text) = 0 and position(chr(13) in v_text) = 0;
    else
      -- text
      return char_length(v_text) <= 500;
  end case;
end;
$$;

revoke all on function app.custom_value_ok(text, jsonb, jsonb) from public, anon;
grant execute on function app.custom_value_ok(text, jsonb, jsonb) to authenticated;

-- 0175's check, plus what a record link and a file value name (FLD-06 part B)
create or replace function app.check_custom_fields() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_object text := tg_argv[0];
  v_old jsonb := '{}'::jsonb;
  v_key text;
  v_value jsonb;
  v_type text;
  v_options jsonb;
  v_read_only boolean;
  v_label text;
  v_target text;
  v_id uuid;
  v_found boolean;
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if new.custom_fields is not distinct from old.custom_fields then
      return new;
    end if;
    v_old := coalesce(old.custom_fields, '{}'::jsonb);
    -- FLD-07: a read-only value that is filled may not be cleared (nor removed with its key)
    select f.label into v_label
      from jsonb_each(v_old) e
      join public.field_definitions f
        on f.organization_id = new.organization_id and f.object_type = v_object and f.key = e.key
     where f.is_read_only and not app.custom_value_empty(e.value)
       and app.custom_value_empty(new.custom_fields -> e.key)
     limit 1;
    if v_label is not null then
      raise exception 'custom field is read-only' using errcode = 'P0001', hint = 'custom_field:read_only', detail = v_label;
    end if;
  end if;

  for v_key, v_value in select e.key, e.value from jsonb_each(new.custom_fields) e loop
    continue when v_old -> v_key is not distinct from v_value;
    v_type := null;
    select f.field_type, f.options, f.is_read_only, f.label, f.link_target into v_type, v_options, v_read_only, v_label, v_target
      from public.field_definitions f
     where f.organization_id = new.organization_id and f.object_type = v_object and f.key = v_key;
    if v_type is null then
      raise exception 'unknown custom field %', v_key using errcode = 'P0001', hint = 'custom_field:invalid';
    end if;
    -- FLD-07 (owner, 13 October 2026): an empty read-only value may be filled once; a filled one is locked
    if tg_op = 'UPDATE' and v_read_only and not app.custom_value_empty(v_old -> v_key) then
      raise exception 'custom field is read-only' using errcode = 'P0001', hint = 'custom_field:read_only', detail = v_label;
    end if;
    if not app.custom_value_ok(v_type, v_options, v_value) then
      raise exception 'invalid value for custom field %', v_key using errcode = 'P0001', hint = 'custom_field:invalid';
    end if;
    -- a "user" field holds a member of the record's organization (RVW-14); the app offers every
    -- membership, a deactivated one included. custom_value_ok has no organization, so it is checked here,
    -- with the caller's rights (members read their organization's memberships). The value is a uuid by now.
    if v_type = 'user' and jsonb_typeof(v_value) = 'string' and not exists (
      select 1 from public.memberships m
       where m.organization_id = new.organization_id and m.user_id = (v_value #>> '{}')::uuid
    ) then
      raise exception 'invalid value for custom field %', v_key using errcode = 'P0001', hint = 'custom_field:invalid';
    end if;
    -- FLD-06 part B: a record link names a live record of the field's target type in this business that the
    -- writer reads (this function is security invoker: RLS decides what is found)
    if v_type = 'record_link' and jsonb_typeof(v_value) = 'string' then
      v_id := (v_value #>> '{}')::uuid;
      v_found := case v_target
        when 'lead' then exists (select 1 from public.leads x where x.organization_id = new.organization_id and x.id = v_id and x.deleted_at is null)
        when 'contact' then exists (select 1 from public.contacts x where x.organization_id = new.organization_id and x.id = v_id and x.deleted_at is null)
        when 'company' then exists (select 1 from public.companies x where x.organization_id = new.organization_id and x.id = v_id and x.deleted_at is null)
        when 'deal' then exists (select 1 from public.deals x where x.organization_id = new.organization_id and x.id = v_id and x.deleted_at is null)
        else false
      end;
      if not v_found then
        raise exception 'the linked record was not found' using errcode = 'P0001', hint = 'custom_field:record_link', detail = v_label;
      end if;
    end if;
    -- FLD-06 part B: a file field names a confirmed file of this record, uploaded for this field
    if v_type = 'file' and jsonb_typeof(v_value) = 'string' then
      v_id := (v_value #>> '{}')::uuid;
      if not exists (
        select 1 from public.files x
         where x.organization_id = new.organization_id and x.id = v_id and x.custom_field_key = v_key
           and x.unconfirmed_since is null
           and case v_object when 'lead' then x.lead_id = new.id when 'contact' then x.contact_id = new.id
                             when 'company' then x.company_id = new.id when 'deal' then x.deal_id = new.id else false end
      ) then
        raise exception 'the file was not found' using errcode = 'P0001', hint = 'custom_field:file', detail = v_label;
      end if;
    end if;
  end loop;
  return new;
end;
$$;

revoke all on function app.check_custom_fields() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- The definition: a record link's target and the type of a record link or file field never change; no default
-- -----------------------------------------------------------------------------
create or replace function app.field_definitions_part_b_check() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and (new.link_target is distinct from old.link_target
          or (old.field_type in ('record_link', 'file')
              and (new.key is distinct from old.key or new.object_type is distinct from old.object_type))
          or (new.field_type is distinct from old.field_type
              and (new.field_type in ('record_link', 'file') or old.field_type in ('record_link', 'file')))) then
    raise exception 'the type of this field cannot change' using errcode = 'P0001', hint = 'custom_field:type_locked';
  end if;
  if new.field_type in ('record_link', 'file') and new.default_value is not null and jsonb_typeof(new.default_value) <> 'null' then
    raise exception 'invalid default value' using errcode = 'P0001', hint = 'custom_field:default';
  end if;
  return new;
end;
$$;
revoke all on function app.field_definitions_part_b_check() from public, anon, authenticated;

create or replace trigger field_definitions_part_b_check before insert or update on public.field_definitions
  for each row execute function app.field_definitions_part_b_check();

-- -----------------------------------------------------------------------------
-- File fields: the files row names its field
-- -----------------------------------------------------------------------------
alter table public.files add column if not exists custom_field_key text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'files_custom_field_shape') then
    -- a field's file belongs to a record (never a note, a document or a payment) and has no versions
    alter table public.files add constraint files_custom_field_shape
      check (custom_field_key is null
             or (char_length(custom_field_key) between 1 and 100
                 and activity_id is null and previous_id is null
                 and accounting_document_id is null and payment_id is null));
  end if;
end;
$$;

grant insert (custom_field_key) on public.files to authenticated;

-- Whether the file is the current value of its record's field. Definer: the Storage policy and the delete guard ask
-- it for any row (the answer says nothing a person who may delete the row could not read).
create or replace function app.field_file_in_use(p_org uuid, p_file uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.files f
     where f.organization_id = p_org and f.id = p_file and f.custom_field_key is not null
       and (exists (select 1 from public.leads x where f.lead_id is not null and x.organization_id = f.organization_id and x.id = f.lead_id
                     and x.custom_fields ->> f.custom_field_key = f.id::text)
            or exists (select 1 from public.contacts x where f.contact_id is not null and x.organization_id = f.organization_id and x.id = f.contact_id
                        and x.custom_fields ->> f.custom_field_key = f.id::text)
            or exists (select 1 from public.companies x where f.company_id is not null and x.organization_id = f.organization_id and x.id = f.company_id
                        and x.custom_fields ->> f.custom_field_key = f.id::text)
            or exists (select 1 from public.deals x where f.deal_id is not null and x.organization_id = f.organization_id and x.id = f.deal_id
                        and x.custom_fields ->> f.custom_field_key = f.id::text)))
$$;
revoke all on function app.field_file_in_use(uuid, uuid) from public, anon;
grant execute on function app.field_file_in_use(uuid, uuid) to authenticated, service_role;

-- A person's field file: an active file field of the record's type, on a record the person may edit
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
  -- a new version of a field's file is not a thing: a field holds one file, replaced by a new upload
  if new.previous_id is not null and exists (
    select 1 from public.files p where p.organization_id = new.organization_id and p.id = new.previous_id and p.custom_field_key is not null
  ) then
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

create or replace trigger files_field_check before insert on public.files
  for each row execute function app.files_field_check();

-- A person never removes a field's current file directly; it goes when the value changes (released below)
create or replace function app.files_field_guard() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon') and app.field_file_in_use(old.organization_id, old.id) then
    raise exception 'a field''s file is removed from its field' using errcode = 'P0001', hint = 'file:field';
  end if;
  return old;
end;
$$;
revoke all on function app.files_field_guard() from public, anon;
grant execute on function app.files_field_guard() to authenticated, service_role;

create or replace trigger files_field_guard before delete on public.files
  for each row when (old.custom_field_key is not null)
  execute function app.files_field_guard();

-- Storage keeps the object of a field's current file (020645's policy, plus that line)
alter policy record_files_delete on storage.objects
  using (bucket_id = 'record-files'
         and exists (select 1 from public.files f
                      where f.storage_path = objects.name and app.can_write(f.organization_id)
                        and (f.uploaded_by = (select auth.uid()) or app.is_admin(f.organization_id))
                        and ((f.accounting_document_id is null and f.payment_id is null)
                             or (f.unconfirmed_since is not null and f.uploaded_by = (select auth.uid())))
                        and (f.custom_field_key is null or not app.field_file_in_use(f.organization_id, f.id))));

-- -----------------------------------------------------------------------------
-- Releasing a field's file. The delete lives in 20261006020910_field_file_release (pasted by hand); here it waits.
-- -----------------------------------------------------------------------------
-- Made only when it does not exist yet, so running this file again never undoes 20261006020910's body (review F5).
do $do$
begin
  if to_regprocedure('app.custom_field_file_drop(uuid, text, uuid, text, uuid)') is null then
    execute $f$
      create function app.custom_field_file_drop(p_org uuid, p_object text, p_record uuid, p_key text, p_file uuid) returns void
      language plpgsql security definer
      set search_path = ''
      as $b$
      begin
        -- 20261006020910 removes the files row here (only a field file of this record and field); its object then goes
        -- to the orphan cleanup (app.orphan_files)
        null;
      end;
      $b$
    $f$;
  end if;
end;
$do$;
revoke all on function app.custom_field_file_drop(uuid, text, uuid, text, uuid) from public, anon, authenticated;

-- After a record's values change: the files that were the old value of a file field and no longer are
create or replace function app.custom_field_files_release() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_object text := tg_argv[0];
  r record;
begin
  for r in
    select e.key, e.value #>> '{}' as file_id
      from jsonb_each(coalesce(old.custom_fields, '{}'::jsonb)) e
      join public.field_definitions f
        on f.organization_id = old.organization_id and f.object_type = v_object and f.key = e.key and f.field_type = 'file'
     where jsonb_typeof(e.value) = 'string'
       and (new.custom_fields -> e.key) is distinct from e.value
  loop
    if r.file_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      perform app.custom_field_file_drop(old.organization_id, v_object, old.id, r.key, r.file_id::uuid);
    end if;
  end loop;
  return null;
end;
$$;
revoke all on function app.custom_field_files_release() from public, anon, authenticated;

create or replace trigger leads_cf_files_release after update of custom_fields on public.leads
  for each row when (old.custom_fields is distinct from new.custom_fields)
  execute function app.custom_field_files_release('lead');
create or replace trigger contacts_cf_files_release after update of custom_fields on public.contacts
  for each row when (old.custom_fields is distinct from new.custom_fields)
  execute function app.custom_field_files_release('contact');
create or replace trigger companies_cf_files_release after update of custom_fields on public.companies
  for each row when (old.custom_fields is distinct from new.custom_fields)
  execute function app.custom_field_files_release('company');
create or replace trigger deals_cf_files_release after update of custom_fields on public.deals
  for each row when (old.custom_fields is distinct from new.custom_fields)
  execute function app.custom_field_files_release('deal');

-- Deleting a file field releases its files (the business's own deletion takes them by cascade)
create or replace function app.custom_field_files_release_field() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  r record;
begin
  if not app.org_exists(old.organization_id) then
    return null;
  end if;
  for r in
    select f.id, coalesce(f.lead_id, f.contact_id, f.company_id, f.deal_id) as record_id
      from public.files f
     where f.organization_id = old.organization_id and f.custom_field_key = old.key
       and case old.object_type when 'lead' then f.lead_id is not null when 'contact' then f.contact_id is not null
                                when 'company' then f.company_id is not null when 'deal' then f.deal_id is not null else false end
  loop
    perform app.custom_field_file_drop(old.organization_id, old.object_type, r.record_id, old.key, r.id);
  end loop;
  return null;
end;
$$;
revoke all on function app.custom_field_files_release_field() from public, anon, authenticated;

create or replace trigger field_definitions_files_release after delete on public.field_definitions
  for each row when (old.field_type = 'file')
  execute function app.custom_field_files_release_field();

-- -----------------------------------------------------------------------------
-- Record links: emptied when the target is purged for good
-- -----------------------------------------------------------------------------
-- p_ids: the removed records of one business and type. Every link field of the business that targets the type loses
-- the key on the records that hold one of those ids.
create or replace function app.record_links_clear_ids(p_org uuid, p_type text, p_ids text[]) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  r record;
  v_prev text := current_setting('app.field_links_server', true);
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
    case r.object_type
      when 'lead' then
        update public.leads t set custom_fields = t.custom_fields - r.key
         where t.organization_id = p_org and t.custom_fields ->> r.key = any (p_ids);
      when 'contact' then
        update public.contacts t set custom_fields = t.custom_fields - r.key
         where t.organization_id = p_org and t.custom_fields ->> r.key = any (p_ids);
      when 'company' then
        update public.companies t set custom_fields = t.custom_fields - r.key
         where t.organization_id = p_org and t.custom_fields ->> r.key = any (p_ids);
      when 'deal' then
        update public.deals t set custom_fields = t.custom_fields - r.key
         where t.organization_id = p_org and t.custom_fields ->> r.key = any (p_ids);
      else
        null;
    end case;
  end loop;
  perform set_config('app.field_links_server', coalesce(v_prev, ''), true);
end;
$$;
revoke all on function app.record_links_clear_ids(uuid, text, text[]) from public, anon, authenticated;

create or replace function app.record_links_clear() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_type text := tg_argv[0];
  r record;
begin
  for r in
    select g.organization_id, array_agg(g.id::text) as ids from gone g group by g.organization_id
  loop
    -- only businesses that have a link field to this type do any work
    if exists (select 1 from public.field_definitions f
                where f.organization_id = r.organization_id and f.field_type = 'record_link' and f.link_target = v_type) then
      perform app.record_links_clear_ids(r.organization_id, v_type, r.ids);
    end if;
  end loop;
  return null;
end;
$$;
revoke all on function app.record_links_clear() from public, anon, authenticated;

create or replace trigger leads_record_links_clear after delete on public.leads
  referencing old table as gone for each statement execute function app.record_links_clear('lead');
create or replace trigger contacts_record_links_clear after delete on public.contacts
  referencing old table as gone for each statement execute function app.record_links_clear('contact');
create or replace trigger companies_record_links_clear after delete on public.companies
  referencing old table as gone for each statement execute function app.record_links_clear('company');
create or replace trigger deals_record_links_clear after delete on public.deals
  referencing old table as gone for each statement execute function app.record_links_clear('deal');

-- -----------------------------------------------------------------------------
-- Merge: links to the duplicate point at the kept record; the duplicate's unused field files are released
-- -----------------------------------------------------------------------------
-- Runs on the "merged" system entry merge_records writes after app.merge_move_links (the files are on the kept
-- record by then) and before the duplicate is removed (so app.record_links_clear finds nothing left to empty).
create or replace function app.merge_field_links() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_merged uuid;
  v_keep uuid := coalesce(new.lead_id, new.contact_id, new.company_id);
  v_type text := case when new.lead_id is not null then 'lead' when new.contact_id is not null then 'contact' else 'company' end;
  v_exists boolean;
  v_kept jsonb;
  v_snapshot jsonb := coalesce(new.metadata -> 'merged' -> 'custom_fields', '{}'::jsonb);
  v_prev text := current_setting('app.field_links_server', true);
  r record;
begin
  if (new.metadata ->> 'merged_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or v_keep is null then
    return null;
  end if;
  v_merged := (new.metadata ->> 'merged_id')::uuid;
  if v_merged = v_keep then
    return null;
  end if;
  -- only a merge's own entry: the duplicate still exists here
  execute format('select exists (select 1 from public.%I where organization_id = $1 and id = $2)',
                 case v_type when 'lead' then 'leads' when 'contact' then 'contacts' else 'companies' end)
    into v_exists using new.organization_id, v_merged;
  if not v_exists then
    return null;
  end if;
  -- the server's own link write: the automation guard lets it pass (review F1)
  perform set_config('app.field_links_server', 'on', true);
  for r in
    select f.object_type, f.key from public.field_definitions f
     where f.organization_id = new.organization_id and f.field_type = 'record_link' and f.link_target = v_type
  loop
    case r.object_type
      when 'lead' then
        update public.leads t set custom_fields = jsonb_set(t.custom_fields, array[r.key], to_jsonb(v_keep::text))
         where t.organization_id = new.organization_id and t.custom_fields ->> r.key = v_merged::text;
      when 'contact' then
        update public.contacts t set custom_fields = jsonb_set(t.custom_fields, array[r.key], to_jsonb(v_keep::text))
         where t.organization_id = new.organization_id and t.custom_fields ->> r.key = v_merged::text;
      when 'company' then
        update public.companies t set custom_fields = jsonb_set(t.custom_fields, array[r.key], to_jsonb(v_keep::text))
         where t.organization_id = new.organization_id and t.custom_fields ->> r.key = v_merged::text;
      when 'deal' then
        update public.deals t set custom_fields = jsonb_set(t.custom_fields, array[r.key], to_jsonb(v_keep::text))
         where t.organization_id = new.organization_id and t.custom_fields ->> r.key = v_merged::text;
      else
        null;
    end case;
  end loop;
  -- the duplicate's file values the kept record did not take (it had its own): their files moved with the
  -- duplicate's files and are released
  execute format('select custom_fields from public.%I where organization_id = $1 and id = $2',
                 case v_type when 'lead' then 'leads' when 'contact' then 'contacts' else 'companies' end)
    into v_kept using new.organization_id, v_keep;
  for r in
    select f.key, v_snapshot ->> f.key as file_id from public.field_definitions f
     where f.organization_id = new.organization_id and f.object_type = v_type and f.field_type = 'file'
       and jsonb_typeof(v_snapshot -> f.key) = 'string'
       and (coalesce(v_kept, '{}'::jsonb) ->> f.key) is distinct from (v_snapshot ->> f.key)
  loop
    if r.file_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      perform app.custom_field_file_drop(new.organization_id, v_type, v_keep, r.key, r.file_id::uuid);
    end if;
  end loop;
  perform set_config('app.field_links_server', coalesce(v_prev, ''), true);
  return null;
end;
$$;
revoke all on function app.merge_field_links() from public, anon, authenticated;

create or replace trigger activities_merge_field_links after insert on public.activities
  for each row
  when (new.type = 'system' and (new.lead_id is not null or new.contact_id is not null or new.company_id is not null)
        and new.metadata ? 'merged_id')
  execute function app.merge_field_links();

-- -----------------------------------------------------------------------------
-- Automations never set or clear a record link or a file
-- -----------------------------------------------------------------------------
-- Security invoker, so it knows who writes: the server's own link writes (app.field_links_server, honoured only when the
-- writer is not a person) pass.
create or replace function app.custom_fields_automation_guard() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_object text := tg_argv[0];
begin
  if current_user not in ('authenticated', 'anon') and coalesce(current_setting('app.field_links_server', true), '') = 'on' then
    return new;
  end if;
  if exists (
    select 1 from public.field_definitions f
     where f.organization_id = new.organization_id and f.object_type = v_object and f.field_type in ('record_link', 'file')
       and (new.custom_fields -> f.key) is distinct from (old.custom_fields -> f.key)
  ) then
    raise exception 'the value does not fit the field' using errcode = 'P0001', hint = 'custom_field:automation';
  end if;
  return new;
end;
$$;
revoke all on function app.custom_fields_automation_guard() from public, anon;
grant execute on function app.custom_fields_automation_guard() to authenticated, service_role;

create or replace trigger leads_cf_zz_automation_guard before update of custom_fields on public.leads
  for each row when (current_setting('app.automation_running', true) = 'on' and old.custom_fields is distinct from new.custom_fields)
  execute function app.custom_fields_automation_guard('lead');
create or replace trigger contacts_cf_zz_automation_guard before update of custom_fields on public.contacts
  for each row when (current_setting('app.automation_running', true) = 'on' and old.custom_fields is distinct from new.custom_fields)
  execute function app.custom_fields_automation_guard('contact');
create or replace trigger companies_cf_zz_automation_guard before update of custom_fields on public.companies
  for each row when (current_setting('app.automation_running', true) = 'on' and old.custom_fields is distinct from new.custom_fields)
  execute function app.custom_fields_automation_guard('company');
create or replace trigger deals_cf_zz_automation_guard before update of custom_fields on public.deals
  for each row when (current_setting('app.automation_running', true) = 'on' and old.custom_fields is distinct from new.custom_fields)
  execute function app.custom_fields_automation_guard('deal');

-- -----------------------------------------------------------------------------
-- Conversion: 0162's carry, never a file, and a record link only to a field of the same target
-- -----------------------------------------------------------------------------
create or replace function app.carry_custom_fields(p_org uuid, p_from jsonb, p_type text) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(c.key, c.value), '{}'::jsonb)
    from (
      select distinct on (t.key) t.key, v.value
        from jsonb_each(p_from) v
        join public.field_definitions s
          on s.organization_id = p_org and s.object_type = 'lead' and s.key = v.key
        left join public.conversion_field_maps m
          on m.organization_id = p_org and m.lead_field_id = s.id and m.target_type = p_type
        join lateral (
          -- picked by hand: that field only, while it is active and of the same type
          select d.key, d.field_type, d.options
            from public.field_definitions d
           where m.mode = 'field' and d.organization_id = p_org and d.id = m.target_field_id
             and d.object_type = p_type and d.is_active and d.field_type = s.field_type
             and d.link_target is not distinct from s.link_target
          union all
          -- "auto": same label and type, as before (0029), never a field picked by hand
          select x.key, x.field_type, x.options
            from (
              select d.key, d.field_type, d.options
                from public.field_definitions d
               where (m.id is null or m.mode = 'auto')
                 and d.organization_id = p_org and d.object_type = p_type and d.is_active
                 and lower(btrim(d.label)) = lower(btrim(s.label)) and d.field_type = s.field_type
                 and d.link_target is not distinct from s.link_target
                 and not exists (
                   select 1 from public.conversion_field_maps o
                    where o.organization_id = p_org and o.target_type = p_type and o.mode = 'field' and o.target_field_id = d.id
                 )
               order by d.position, d.created_at
               limit 1
            ) x
        ) t on true
       where jsonb_typeof(v.value) <> 'null' and app.custom_value_ok(t.field_type, t.options, v.value)
         -- FLD-06 part B: a file belongs to the lead; it is never copied
         and s.field_type <> 'file'
       order by t.key, s.position, s.created_at
    ) c;
$$;
revoke all on function app.carry_custom_fields(uuid, jsonb, text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- public.intake_form: the body of 020830; FLD-06 part B: a record link or a file field is never on a public form
-- ----------------------------------------------------------------------------
create or replace function public.intake_form(p_token text) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_form public.forms%rowtype;
  v_fields jsonb;
  v_brand jsonb;
  v_whatsapp text;
  -- SPD-05
  v_callback jsonb;
  -- FLD-04: the "נבנה ב-Mexuz" line
  v_built_with boolean;
  -- LEAD-04 / CAP-08 (020830): the products the form offers (id and name only)
  v_products jsonb;
begin
  select * into v_form from public.forms f
   where f.token = coalesce(p_token, '') and f.kind = 'form';
  if not found or not v_form.is_active then
    return null;
  end if;
  -- 0163: a business whose public pages are closed (cancelled, deleted): a marker and nothing else
  if not app.org_public_pages_open(v_form.organization_id) then
    return jsonb_build_object('inactive', true);
  end if;

  select coalesce(jsonb_agg(x.field order by x.ord), '[]'::jsonb) into v_fields
    from (
      select a.ord,
             jsonb_build_object(
               'key', a.item ->> 'key',
               'required', coalesce(a.item -> 'required' = 'true'::jsonb, false),
               'help', coalesce(nullif(btrim(a.item ->> 'help'), ''), d.help_text),
               'show_if', case when jsonb_typeof(a.item -> 'show_if') = 'object' then a.item -> 'show_if' end,
               'label', d.label,
               'type', d.field_type,
               'options', d.options) as field
        from jsonb_array_elements(case when jsonb_typeof(v_form.fields) = 'array' then v_form.fields else '[]'::jsonb end)
               with ordinality as a(item, ord)
        left join public.field_definitions d
          on (a.item ->> 'key') like 'cf:%'
         and d.organization_id = v_form.organization_id
         and d.object_type = 'lead'
         and d.key = substr(a.item ->> 'key', 4)
         and d.is_active
         and d.field_type not in ('user', 'record_link', 'file')
       where (a.item ->> 'key') in ('full_name', 'phone', 'email', 'company_name', 'message')
          or d.id is not null
    ) x;

  -- FLD-04: only the logo's object name and the colour; nothing else of the organization
  select jsonb_build_object('logo', o.logo_path, 'color', o.brand_color) into v_brand
    from public.organizations o
   where o.id = v_form.organization_id;

  -- CAP-05: the WhatsApp number of the thank-you page, only when the form turns it on:
  -- the form's own number, else the business phone; only a valid E.164 number leaves
  if v_form.whatsapp_button then
    select app.normalize_phone(coalesce(nullif(btrim(v_form.whatsapp_phone), ''), o.phone)) into v_whatsapp
      from public.organizations o
     where o.id = v_form.organization_id;
    if v_whatsapp !~ '^\+[1-9][0-9]{7,14}$' then
      v_whatsapp := null;
    end if;
  end if;

  -- SPD-05: the call-back choice: the business's time zone, whether "now" is
  -- offered, and the slots still open today and on the next working day
  if v_form.callback_choice then
    select jsonb_build_object('time_zone', app.intake_zone(o.timezone))
           || app.intake_callback_offer(v_form.organization_id, v_form.callback_slots_off, now())
      into v_callback
      from public.organizations o
     where o.id = v_form.organization_id;
  end if;

  -- LEAD-04 / CAP-08 (020830): when the form asks for a product and the business has the products flag: the offered
  -- products, id and name only (no price, SKU or anything else); none offerable = no question
  if v_form.product_choice and app.org_has_feature(v_form.organization_id, 'products') then
    select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.ord) into v_products
      from app.intake_form_products(v_form.organization_id, v_form.product_ids, v_form.product_category_ids) p;
  end if;

  -- FLD-04: shown unless the plan or the override turns remove_built_with on; a bad
  -- plan value never fails the form (the line then shows)
  begin
    v_built_with := coalesce(app.show_built_with(v_form.organization_id), true);
  exception when others then
    v_built_with := true;
  end;

  return case when v_products is not null then jsonb_build_object('products', v_products) else '{}'::jsonb end
  || jsonb_build_object(
    'built_with', v_built_with,
    'callback', v_callback,
    -- CON-10: ask how the person likes to be contacted (the four channels)
    'channel_choice', v_form.channel_choice,
    -- CAP-08: ask the person's preferred language (the contacts' codes)
    'locale_choice', v_form.locale_choice,
    'title', coalesce(nullif(btrim(v_form.title), ''), v_form.name),
    'intro', v_form.intro,
    'submit_label', v_form.submit_label,
    'fields', v_fields,
    'brand', coalesce(v_brand, jsonb_build_object('logo', null, 'color', null)),
    'thanks', jsonb_build_object(
      'whatsapp', v_whatsapp,
      'whatsapp_text', case when v_whatsapp is not null then nullif(btrim(v_form.whatsapp_text), '') end));
end;
$$;
revoke all on function public.intake_form(text) from public, anon, authenticated;
grant execute on function public.intake_form(text) to service_role;


-- ----------------------------------------------------------------------------
-- public.intake_submit: the body of 020830; FLD-06 part B: a record link or a file field is never read from a form
-- ----------------------------------------------------------------------------
create or replace function public.intake_submit(
  p_token      text,
  p_kind       text,
  p_payload    jsonb,
  p_ip_hash    text default null,
  p_user_agent text default null,
  p_is_spam    boolean default false
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_form public.forms%rowtype;
  v_status uuid;
  v_owner uuid;
  v_lead uuid;
  v_phone_e164 text;
  -- matched lead (and the contact it became) or matched contact
  v_lead_match uuid;
  v_lead_owner uuid;
  v_lead_contact uuid;
  v_contact_match uuid;
  v_contact_owner uuid;
  v_field jsonb;
  v_key text;
  v_full_name text := nullif(left(btrim(coalesce(p_payload ->> 'full_name', '')), 200), '');
  v_phone text := nullif(left(btrim(coalesce(p_payload ->> 'phone', '')), 40), '');
  v_email text := nullif(lower(left(btrim(coalesce(p_payload ->> 'email', '')), 254)), '');
  v_company text := nullif(left(btrim(coalesce(p_payload ->> 'company_name', '')), 200), '');
  v_message text := nullif(left(btrim(coalesce(p_payload ->> 'message', '')), 5000), '');
  -- CAP-02 / ADS-01: where the visit came from (cleaned, known keys only)
  v_attr jsonb := app.intake_attribution(p_payload -> 'attribution');
  -- CAP-01: custom values as sent, and what is kept of them
  v_custom_in jsonb := case when jsonb_typeof(p_payload -> 'custom') = 'object' then p_payload -> 'custom' else '{}'::jsonb end;
  v_custom jsonb := '{}'::jsonb;
  -- values of the shown fields by form key, for the conditions of later fields
  v_values jsonb := '{}'::jsonb;
  v_shown text[] := '{}';
  v_value jsonb;
  v_cond jsonb;
  v_type text;
  v_options jsonb;
  -- SPD-05: when the person asked to be called back ('now' or a slot 'YYYY-MM-DD-HH', its business date and start hour)
  v_callback text := nullif(left(btrim(coalesce(p_payload ->> 'callback', '')), 40), '');
  v_callback_at timestamptz;
  v_callback_phrase text;
  v_callback_note text;
  v_task_owner uuid;
  v_task uuid;
  -- CAP-09: the rotation has members, but none is in working hours (or all are on leave)
  v_rotation_closed boolean := false;
  -- CAP-08: the team the new lead belongs to and is distributed in (the form's, or a matching rule's)
  v_team uuid;
  -- HEB-08: the form's owner was away with no usable deputy
  v_absent uuid;
  -- CON-10: how the person likes to be contacted, when the form asks (one of the four, else none)
  v_channel text := case when p_payload ->> 'preferred_channel' in ('phone', 'whatsapp', 'email', 'sms')
                         then p_payload ->> 'preferred_channel' end;
  -- CAP-08: the person's language, when the form asks (one of the contacts' codes, else none)
  v_locale text := case when p_payload ->> 'preferred_locale' in ('he', 'ar', 'en', 'ru', 'am', 'fr', 'es')
                        then p_payload ->> 'preferred_locale' end;
  -- CAP-08: a distribution rule that names one person
  v_rule_user uuid;
  -- LEAD-08 (owner, 18 October 2026, answer (א)): the business switched leads off; the inquiry becomes a contact
  v_leads_on boolean;
  v_contact uuid;
  v_name text;
  -- LEAD-04 / CAP-08 (020830): the product the person asked about, when the form asks (checked below)
  v_product_raw text := case when jsonb_typeof(p_payload -> 'requested_product_id') = 'string'
                             then nullif(left(btrim(p_payload ->> 'requested_product_id'), 64), '') end;
  v_product uuid;
  v_product_name text;
begin
  select * into v_form from public.forms f
   where f.token = coalesce(p_token, '') and f.kind = p_kind;
  if not found or not v_form.is_active then
    raise exception 'form not found' using errcode = 'P0002';
  end if;
  -- read-only and suspended businesses keep taking leads (owner, 8 and 13 October 2026)
  if not app.org_takes_leads(v_form.organization_id) then
    raise exception 'the organization is read-only' using errcode = 'P0001', hint = 'org:read_only';
  end if;

  v_leads_on := app.org_leads_enabled(v_form.organization_id);

  -- rate limits: per sender (10 in 10 minutes) and per form (500 an hour)
  if p_ip_hash is not null and (
    select count(*) from public.form_submissions s
     where s.form_id = v_form.id and s.ip_hash = p_ip_hash and s.created_at > now() - interval '10 minutes'
  ) >= 10 then
    raise exception 'too many submissions' using errcode = 'P0001', hint = 'rate_limited';
  end if;
  if (
    select count(*) from public.form_submissions s
     where s.form_id = v_form.id and s.created_at > now() - interval '1 hour'
  ) >= 500 then
    raise exception 'too many submissions' using errcode = 'P0001', hint = 'rate_limited';
  end if;

  if p_is_spam then
    insert into public.form_submissions (organization_id, form_id, status, payload, ip_hash, user_agent)
    values (v_form.organization_id, v_form.id, 'spam', coalesce(p_payload, '{}'::jsonb), p_ip_hash, left(p_user_agent, 300));
    return jsonb_build_object('status', 'spam', 'success_message', v_form.success_message, 'redirect_url', v_form.redirect_url);
  end if;

  -- CAP-01: the form's fields in order. A hidden field loses its value and is
  -- never required; a shown custom field must hold a valid value.
  if v_form.kind = 'form' then
    for v_field in
      select a.value from jsonb_array_elements(case when jsonb_typeof(v_form.fields) = 'array' then v_form.fields else '[]'::jsonb end) a
    loop
      continue when jsonb_typeof(v_field) <> 'object';
      v_key := v_field ->> 'key';
      continue when v_key is null or v_key = any (v_shown);
      v_type := null;
      v_options := null;
      if v_key like 'cf:%' then
        select d.field_type, d.options into v_type, v_options
          from public.field_definitions d
         where d.organization_id = v_form.organization_id and d.object_type = 'lead'
           and d.key = substr(v_key, 4) and d.is_active;
        -- a field that is gone, switched off or picks a team member is not on the form (FLD-06 part B: nor a record link or a file)
        continue when v_type is null or v_type in ('user', 'record_link', 'file');
        v_value := v_custom_in -> substr(v_key, 4);
      elsif v_key = 'full_name' then v_value := to_jsonb(v_full_name);
      elsif v_key = 'phone' then v_value := to_jsonb(v_phone);
      elsif v_key = 'email' then v_value := to_jsonb(v_email);
      elsif v_key = 'company_name' then v_value := to_jsonb(v_company);
      elsif v_key = 'message' then v_value := to_jsonb(v_message);
      else
        continue;
      end if;
      if v_value is not null and jsonb_typeof(v_value) = 'null' then
        v_value := null;
      end if;

      v_cond := v_field -> 'show_if';
      if jsonb_typeof(v_cond) = 'object'
         and not coalesce((v_cond ->> 'field') = any (v_shown)
                          and app.intake_condition_met(v_values -> (v_cond ->> 'field'), v_cond ->> 'value'), false) then
        -- hidden: whatever was sent for it is dropped
        if v_key = 'full_name' then v_full_name := null;
        elsif v_key = 'phone' then v_phone := null;
        elsif v_key = 'email' then v_email := null;
        elsif v_key = 'company_name' then v_company := null;
        elsif v_key = 'message' then v_message := null;
        end if;
        continue;
      end if;

      v_shown := v_shown || v_key;
      if v_type is not null and app.intake_has_value(v_value) then
        if not app.custom_value_ok(v_type, v_options, v_value) then
          raise exception 'invalid custom field: %', substr(v_key, 4) using errcode = '22023';
        end if;
        v_custom := v_custom || jsonb_build_object(substr(v_key, 4), v_value);
      end if;
      if app.intake_has_value(v_value) then
        v_values := v_values || jsonb_build_object(v_key, v_value);
      end if;
      if v_field -> 'required' = 'true'::jsonb and not app.intake_has_value(v_value) then
        raise exception 'required field missing: %', v_key using errcode = '22023';
      end if;
    end loop;
  end if;

  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid email address' using errcode = '22023';
  end if;
  if v_full_name is null and v_phone is null and v_email is null then
    raise exception 'a name, phone or email is required' using errcode = '22023';
  end if;

  -- CON-10: a channel counts only when the form asks
  if v_form.kind <> 'form' or not v_form.channel_choice then
    v_channel := null;
  end if;
  -- CAP-08: a language counts only when the form asks
  if v_form.kind <> 'form' or not v_form.locale_choice then
    v_locale := null;
  end if;
  -- LEAD-04 / CAP-08 (020830): a requested product counts only when the form asks and the business has the products
  -- flag. It must be one the form offers now (app.intake_form_products, the list intake_form shows); any other id,
  -- whatever it is (another business's, archived, not picked, unknown), gets the same refusal
  if v_form.kind = 'form' and v_form.product_choice and v_product_raw is not null
     and app.org_has_feature(v_form.organization_id, 'products') then
    if v_product_raw ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      select p.id, p.name into v_product, v_product_name
        from app.intake_form_products(v_form.organization_id, v_form.product_ids, v_form.product_category_ids) p
       where p.id = v_product_raw::uuid;
    end if;
    if v_product is null then
      raise exception 'invalid requested product' using errcode = '22023', hint = 'requested_product:invalid';
    end if;
  end if;

  -- SPD-05: a call-back time counts only when the form offers the choice; a
  -- choice that is not one of the slots, or a slot that has ended, is refused
  -- (SPD-05 follow-ups: the slots this form offers now, app.intake_callback_pick())
  if v_form.kind = 'form' and v_form.callback_choice and v_callback is not null then
    select p.at, p.phrase into v_callback_at, v_callback_phrase
      from app.intake_callback_pick(v_form.organization_id, v_form.callback_slots_off, v_callback, now()) p;
    v_callback_note := 'ביקשו שנחזור אליהם ' || v_callback_phrase;
  else
    v_callback := null;
  end if;

  -- A repeat inquiry (same phone or email as a live lead, or as a contact)
  -- goes onto the existing record's timeline instead of creating a new lead.
  v_phone_e164 := app.normalize_phone(v_phone);
  -- LEAD-08: with leads off only contacts are matched (the business's old leads stay as they are)
  if v_leads_on then
    select l.id, l.owner_id, l.converted_contact_id into v_lead_match, v_lead_owner, v_lead_contact
      from public.leads l
     where l.organization_id = v_form.organization_id and l.deleted_at is null
       and ((v_phone_e164 is not null and l.phone_e164 = v_phone_e164)
            or (v_email is not null and lower(l.email) = v_email))
     order by l.created_at desc
     limit 1;
  end if;
  if v_lead_match is null then
    -- CON-01: the contact's primary phone or email, or any of its other ones
    select c.id, c.owner_id into v_contact_match, v_contact_owner
      from public.contacts c
     where c.organization_id = v_form.organization_id and c.deleted_at is null
       and c.id in (
         select c2.id from public.contacts c2
          where c2.organization_id = v_form.organization_id
            and ((v_phone_e164 is not null and c2.phone_e164 = v_phone_e164)
                 or (v_email is not null and lower(c2.email) = v_email))
         union
         select ch.contact_id from public.contact_channels ch
          where ch.organization_id = v_form.organization_id
            and ((v_phone_e164 is not null and ch.value_e164 = v_phone_e164)
                 or (v_email is not null and ch.kind = 'email' and ch.value = v_email)))
     order by c.created_at desc
     limit 1;
  end if;

  if v_lead_match is not null or v_contact_match is not null then
    -- first touch wins: the lead keeps its attribution and custom fields;
    -- this visit's are kept on the inquiry
    insert into public.activities (organization_id, type, body, lead_id, contact_id, metadata)
    values (
      v_form.organization_id, 'inquiry', v_message, v_lead_match,
      coalesce(v_lead_contact, v_contact_match),
      jsonb_build_object('form_id', v_form.id, 'form_name', v_form.name,
                         'full_name', v_full_name, 'phone', v_phone, 'email', v_email, 'company_name', v_company)
        || case when v_attr <> '{}'::jsonb then jsonb_build_object('attribution', v_attr) else '{}'::jsonb end
        || case when v_custom <> '{}'::jsonb then jsonb_build_object('custom_fields', v_custom) else '{}'::jsonb end
        || case when v_callback_at is not null then jsonb_build_object('callback_at', v_callback_at) else '{}'::jsonb end
        || case when v_channel is not null then jsonb_build_object('preferred_channel', v_channel) else '{}'::jsonb end
        || case when v_locale is not null then jsonb_build_object('preferred_locale', v_locale) else '{}'::jsonb end
        || case when v_product is not null
                then jsonb_build_object('requested_product_id', v_product, 'requested_product', v_product_name)
                else '{}'::jsonb end);
    -- CAP-08: the form's language fills an empty one only
    if v_locale is not null then
      if v_lead_match is not null then
        update public.leads l set preferred_locale = v_locale
         where l.organization_id = v_form.organization_id and l.id = v_lead_match and l.preferred_locale is null;
      end if;
      if coalesce(v_lead_contact, v_contact_match) is not null then
        update public.contacts c set preferred_locale = v_locale
         where c.organization_id = v_form.organization_id and c.id = coalesce(v_lead_contact, v_contact_match)
           and c.preferred_locale is null;
      end if;
    end if;
    -- LEAD-04 (020830): the form's product fills a matched lead's empty one only (a contact has no requested product;
    -- it stays on the inquiry entry)
    if v_product is not null and v_lead_match is not null then
      update public.leads l set requested_product_id = v_product
       where l.organization_id = v_form.organization_id and l.id = v_lead_match and l.requested_product_id is null;
    end if;
    -- CON-10 (owner, 14 October 2026): the form's channel fills an empty one, or replaces one
    -- that came from a form; a channel a person set (or one older than its source) stays
    if v_channel is not null then
      if v_lead_match is not null then
        update public.leads l
           set preferred_channel = v_channel, preferred_channel_source = 'form'
         where l.organization_id = v_form.organization_id and l.id = v_lead_match
           and (l.preferred_channel is null or l.preferred_channel_source = 'form')
           and l.preferred_channel is distinct from v_channel;
      end if;
      if coalesce(v_lead_contact, v_contact_match) is not null then
        update public.contacts c
           set preferred_channel = v_channel, preferred_channel_source = 'form'
         where c.organization_id = v_form.organization_id and c.id = coalesce(v_lead_contact, v_contact_match)
           and (c.preferred_channel is null or c.preferred_channel_source = 'form')
           and c.preferred_channel is distinct from v_channel;
      end if;
    end if;
    v_owner := coalesce(v_lead_owner, v_contact_owner);
    if v_owner is not null then
      -- SPD-05: the requested call-back time, when there is one, in the body
      insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
      values (v_form.organization_id, v_owner, 'inquiry', 'פנייה חוזרת מלקוח קיים', v_callback_note,
              case when v_lead_match is not null then 'lead' else 'contact' end,
              coalesce(v_lead_match, v_contact_match));
    end if;
    -- SPD-05: a call task for the record's owner, else the form's owner
    if v_callback_at is not null then
      -- the record's owner while an active member who is not a viewer, else the form's owner, same check
      select m.user_id into v_task_owner from public.memberships m
       where m.organization_id = v_form.organization_id and m.user_id = v_owner
         and m.status = 'active' and m.role <> 'viewer';
      if v_task_owner is null then
        select m.user_id into v_task_owner from public.memberships m
         where m.organization_id = v_form.organization_id and m.user_id = v_form.owner_id
           and m.status = 'active' and m.role <> 'viewer';
      end if;
      v_task := app.intake_call_task(v_form.organization_id, v_task_owner, v_lead_match,
                                     coalesce(v_lead_contact, v_contact_match), v_callback = 'now', v_callback_at,
                                     v_callback_phrase, coalesce(v_full_name, v_phone, v_email), v_form.name);
      -- SPD-01: the lead's call task follows "לקחתי"
      if v_lead_match is not null then
        insert into app.intake_callback_tasks (task_id, organization_id, lead_id)
        values (v_task, v_form.organization_id, v_lead_match) on conflict do nothing;
      end if;
    end if;
    -- LEAD-08: with leads off a repeat inquiry from a contact also gets "לחזור ללקוח" (the call-back task does it when asked)
    if not v_leads_on and v_callback_at is null then
      -- the contact's own team (its task and, with no owner, who is told)
      perform app.intake_contact_follow_up(v_form.organization_id, v_owner, v_form.owner_id,
                                           (select c.team_id from public.contacts c
                                             where c.organization_id = v_form.organization_id and c.id = v_contact_match),
                                           v_contact_match,
                                           -- LEAD-04 (020830): the product's name in the task's title
                                           nullif(concat_ws(' · ', coalesce(v_full_name, v_phone, v_email), v_product_name), ''),
                                           v_form.name, false);
    end if;
    insert into public.form_submissions (organization_id, form_id, status, lead_id, payload, ip_hash, user_agent)
    values (v_form.organization_id, v_form.id, 'duplicate', v_lead_match, coalesce(p_payload, '{}'::jsonb), p_ip_hash, left(p_user_agent, 300));
    return jsonb_build_object(
      'status', 'duplicate',
      'lead_id', v_lead_match,
      'contact_id', coalesce(v_lead_contact, v_contact_match),
      'success_message', v_form.success_message,
      'redirect_url', v_form.redirect_url);
  end if;

  if v_leads_on then
    select s.id into v_status from public.lead_statuses s
     where s.organization_id = v_form.organization_id and s.kind = 'open'
     order by s.is_default desc, s.position
     limit 1;
    if v_status is null then
      raise exception 'the organization has no open lead status' using errcode = 'P0001';
    end if;
  end if;

  v_team := v_form.team_id;
  if v_form.assign_mode = 'round_robin' then
    -- CAP-08: the rules (source, language, list field; a team or one person), then the pick
    select p.owner_id, p.team_id, p.rule_user, p.absent_user into v_owner, v_team, v_rule_user, v_absent
      from app.lead_distribution_route(v_form.organization_id, v_form.team_id, now(),
                                       jsonb_build_object('source_id', v_form.source_id, 'locale', v_locale,
                                                          -- LEAD-04 (020830): the product rule sees the form's product
                                                          'product_id', v_product,
                                                          -- the values the lead will hold: with the
                                                          -- fields' defaults (FLD-07) the insert adds
                                                          'custom_fields', (select d.p_result from app.custom_field_defaults_apply(
                                                                              v_form.organization_id, 'lead', v_custom) d)),
                                       '{}'::uuid[]) p;
    -- CAP-09 (owner, 13 October 2026): nobody of the rotation in hours: the lead waits
    -- with no owner for a "לקחתי"; nobody available at all keeps the form owner's fallback
    v_rotation_closed := v_owner is null and v_rule_user is null and app.rotation_has_members(v_form.organization_id, v_team);
  end if;
  -- CAP-08: a rule's person (HEB-08 already applied) never falls back to the form's owner
  if v_owner is null and not v_rotation_closed and v_rule_user is null then
    select m.user_id into v_owner from public.memberships m
     where m.organization_id = v_form.organization_id and m.user_id = v_form.owner_id
       and m.status = 'active' and m.role <> 'viewer';
    -- HEB-08: an absent form owner's new lead goes to their deputy; with no usable
    -- deputy it has no owner and takes the SPD-01 route (no chain)
    -- (app.auto_lead_owner: the rule every automatic assigner of a fixed person uses)
    if v_owner is not null then
      select a.owner_id, a.absent_user into v_owner, v_absent
        from app.auto_lead_owner(v_form.organization_id, v_owner, now()) a;
    end if;
  end if;

  -- LEAD-08 (owner, 18 October 2026, answer (א)): leads are off: the same owner pick made a contact's owner, the
  -- inquiry is a contact with the details on its timeline, and someone is asked to call back ("לחזור ללקוח").
  -- With no owner (the rotation closed, an absent owner with no deputy) the contact waits for whoever takes the
  -- task: there is no waiting list for contacts, so nobody is handed it later.
  if not v_leads_on then
    v_name := coalesce(v_full_name, '');
    insert into public.contacts (organization_id, first_name, last_name, phone, email, source_id, owner_id, team_id,
                                 preferred_channel, preferred_channel_source, preferred_locale)
    values (v_form.organization_id,
            case when position(' ' in v_name) > 0 then split_part(v_name, ' ', 1) else nullif(v_name, '') end,
            case when position(' ' in v_name) > 0 then btrim(substr(v_name, position(' ' in v_name) + 1)) end,
            v_phone, v_email, v_form.source_id, v_owner, v_team,
            v_channel, case when v_channel is not null then 'form' end, v_locale)
    returning id into v_contact;
    -- what a lead would have held and a contact has no field for (message, company name, campaign, the form's own
    -- fields) is kept on the contact's timeline
    insert into public.activities (organization_id, type, body, contact_id, metadata)
    values (
      v_form.organization_id, 'inquiry', v_message, v_contact,
      jsonb_build_object('form_id', v_form.id, 'form_name', v_form.name,
                         'full_name', v_full_name, 'phone', v_phone, 'email', v_email, 'company_name', v_company)
        || case when v_attr <> '{}'::jsonb then jsonb_build_object('attribution', v_attr) else '{}'::jsonb end
        || case when v_custom <> '{}'::jsonb then jsonb_build_object('custom_fields', v_custom) else '{}'::jsonb end
        || case when v_callback_at is not null then jsonb_build_object('callback_at', v_callback_at) else '{}'::jsonb end
        || case when v_channel is not null then jsonb_build_object('preferred_channel', v_channel) else '{}'::jsonb end
        || case when v_locale is not null then jsonb_build_object('preferred_locale', v_locale) else '{}'::jsonb end
        || case when v_product is not null
                then jsonb_build_object('requested_product_id', v_product, 'requested_product', v_product_name)
                else '{}'::jsonb end);
    if v_callback_at is not null then
      -- SPD-05: the requested time is the follow-up; told first, so the task itself is quiet for the owner
      perform app.intake_contact_notice(v_form.organization_id, v_owner, v_team, v_contact, v_callback_note);
      v_task := app.intake_call_task(v_form.organization_id, v_owner, null, v_contact, v_callback = 'now', v_callback_at,
                                     v_callback_phrase, coalesce(v_full_name, v_phone, v_email), v_form.name);
      -- the call task takes the contact's team, as "לחזור ללקוח" does (intake_call_task finds a team on a lead only)
      update public.tasks t set team_id = v_team
       where t.organization_id = v_form.organization_id and t.id = v_task and v_team is not null
         and t.team_id is distinct from v_team;
    else
      perform app.intake_contact_follow_up(v_form.organization_id, v_owner, null, v_team, v_contact,
                                           -- LEAD-04 (020830): the product's name in the task's title
                                           nullif(concat_ws(' · ', coalesce(v_full_name, v_phone, v_email), v_product_name), ''),
                                           v_form.name, true);
    end if;
    insert into public.form_submissions (organization_id, form_id, status, lead_id, payload, ip_hash, user_agent)
    values (v_form.organization_id, v_form.id, 'accepted', null, coalesce(p_payload, '{}'::jsonb), p_ip_hash, left(p_user_agent, 300));
    return jsonb_build_object(
      'status', 'accepted',
      'contact_id', v_contact,
      'success_message', v_form.success_message,
      'redirect_url', v_form.redirect_url);
  end if;

  -- SPD-01: the owner is told as 'lead_new' (app.notify_assignment())
  perform set_config('app.intake', 'on', true);
  insert into public.leads (organization_id, status_id, source_id, owner_id, team_id,
                            full_name, phone, email, company_name, message,
                            campaign, utm, referrer_url, landing_url, gclid, fbclid, ctwa_clid,
                            custom_fields, preferred_channel, preferred_channel_source, preferred_locale,
                            requested_product_id)
  values (v_form.organization_id, v_status, v_form.source_id, v_owner, v_team,
          v_full_name, v_phone, v_email, v_company, v_message,
          v_attr ->> 'utm_campaign',
          jsonb_strip_nulls(jsonb_build_object(
            'utm_source', v_attr -> 'utm_source', 'utm_medium', v_attr -> 'utm_medium',
            'utm_campaign', v_attr -> 'utm_campaign', 'utm_term', v_attr -> 'utm_term',
            'utm_content', v_attr -> 'utm_content',
            -- CAP-02: the extra parameters of the closed list, in one place
            'extra', v_attr -> 'extra')),
          v_attr ->> 'referrer_url', v_attr ->> 'landing_url',
          v_attr ->> 'gclid', v_attr ->> 'fbclid', v_attr ->> 'ctwa_clid',
          v_custom, v_channel, case when v_channel is not null then 'form' end, v_locale,
          v_product)
  returning id into v_lead;
  perform set_config('app.intake', '', true);

  -- CAP-09: if nobody takes it, the rotation gives it to the first member back in hours
  if v_rotation_closed then
    insert into app.rotation_waiting_leads (lead_id, organization_id, team_id)
    values (v_lead, v_form.organization_id, v_team) on conflict do nothing;
  end if;

  -- HEB-08: back from the absence, the form's owner gets it if nobody took it (app.return_absence_leads())
  if v_owner is null and v_absent is not null then
    perform app.lead_waits_for_absent(v_form.organization_id, v_lead, v_form.id, v_absent);
  end if;

  -- SPD-01: nobody owns it: whoever may take it is told, and the first "לקחתי" wins
  if v_owner is null then
    insert into public.notifications (organization_id, user_id, type, title, entity_type, entity_id)
    select v_form.organization_id, r.user_id, 'lead_new', 'ליד חדש מחכה למי שייקח אותו', 'lead', v_lead
      from app.intake_unowned_recipients(v_form.organization_id, v_team) r;
  end if;

  -- SPD-05: a call task for the new lead's owner, and the requested time in the
  -- body of the new-lead notification (whichever kind it was sent as)
  if v_callback_at is not null then
    v_task := app.intake_call_task(v_form.organization_id, v_owner, v_lead, null, v_callback = 'now', v_callback_at,
                                   v_callback_phrase, coalesce(v_full_name, v_phone, v_email), v_form.name);
    -- SPD-01: the lead's call task follows "לקחתי"
    insert into app.intake_callback_tasks (task_id, organization_id, lead_id)
    values (v_task, v_form.organization_id, v_lead) on conflict do nothing;
    update public.notifications n set body = v_callback_note
     where n.organization_id = v_form.organization_id and n.entity_type = 'lead' and n.entity_id = v_lead
       and n.body is null;
  end if;

  insert into public.form_submissions (organization_id, form_id, status, lead_id, payload, ip_hash, user_agent)
  values (v_form.organization_id, v_form.id, 'accepted', v_lead, coalesce(p_payload, '{}'::jsonb), p_ip_hash, left(p_user_agent, 300));

  return jsonb_build_object(
    'status', 'accepted',
    'lead_id', v_lead,
    'success_message', v_form.success_message,
    'redirect_url', v_form.redirect_url);
end;
$$;
revoke all on function public.intake_submit(text, text, jsonb, text, text, boolean) from public, anon, authenticated;
grant execute on function public.intake_submit(text, text, jsonb, text, text, boolean) to service_role;

notify pgrst, 'reload schema';
