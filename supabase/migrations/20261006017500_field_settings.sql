-- =============================================================================
-- Field settings: unique, default value, read-only (FLD-07, wave 2)
-- =============================================================================
-- Three settings on a custom field (public.field_definitions), set by owners and
-- admins on the fields settings page (the table's existing grants and policies:
-- members read, owners/admins of a writable organization write; audited).
--
-- is_unique (default false)
--   * Only for types where one value names one record: text, number, email,
--     phone, url, il_id, il_company_id (hint 'custom_field:unique_type').
--     Mirrored by UNIQUE_TYPES in src/features/custom-fields/settings.ts.
--   * Enforced only while the field is also active: a hidden field is neither
--     checked nor given defaults. Hiding it (or switching unique off, or
--     deleting the field) forgets its values; showing it again is checked like
--     turning unique on.
--   * Within the organization and record type, among live records (not in the
--     recycle bin), compared normalized by app.custom_unique_norm(): text and
--     email trimmed, inner spaces folded, lower case; url with scheme and host in
--     lower case, http and https alike, the path's case kept, no trailing "/";
--     phone by app.normalize_phone() (050-1234567 = +972501234567); number by
--     value (3 = 3.0); il_id / il_company_id by digits without leading zeros. An
--     empty value never clashes.
--   * Indexed: app.custom_unique_values holds one row per (unique field id,
--     record) with the normalized value (no API access, RLS on, no policies; rows
--     go with the field by cascade). Triggers
--     *_custom_unique_sync on leads, contacts, companies and deals keep it (insert,
--     update of custom_fields or deleted_at, delete). A unique constraint on
--     (field, value), DEFERRABLE INITIALLY DEFERRED,
--     makes two recorded values equal impossible for every writer (people,
--     imports, merges, automations), also for two transactions at once, and is
--     judged at commit: a merge first copies the duplicate's values into the kept
--     record and only then removes the duplicate. The exceptions (public forms,
--     restore, conversion) are below. A record put in the bin, or a value cleared, sets its row's value
--     to null (nulls never clash); a purged record's row keeps only ids and a
--     null. Rows go by cascade with their field, and when the field is forgotten
--     (unique off, hidden, retyped): set to null here, removed once migration
--     field_settings_unique_off (pasted by hand, it deletes) has run.
--   * The refusal: the deferred constraint trigger "A_custom_unique_values_message"
--     raises SQLSTATE 23505, hint 'custom_field:unique', detail = the field's
--     label (so an import reports the row instead of stopping as on a plan limit,
--     P0001). If two transactions race, the constraint itself may answer first:
--     a bare 23505 on custom_unique_values_value, which the app maps too.
--   * Leads created by a public form (intake_submit, app.intake = 'on') are never
--     refused (owner, 13 October 2026): refusing would lose the inquiry and tell
--     an anonymous visitor that the value exists in the business. A free value is
--     recorded (so a person who types it later on another record is refused); a
--     taken one is kept on the lead, unrecorded, and marked ("ערך כפול בשדה X").
--     The form's value is judged when the lead is inserted (the constraint set
--     immediate inside a subtransaction), so a value another transaction writes at
--     the same moment never makes the inquiry fail at commit. Editing such a lead
--     without changing that field is never blocked; changing the field to a value
--     another record holds is.
--   * Turning unique on and writing records do not cross: every insert or update
--     of these tables takes a shared transaction advisory lock per organization
--     and record type (custom_unique_sync), and recording a field's values takes
--     the exclusive one on the same key (custom_unique_fill). So the values are
--     read only after the writers in flight end, and a writer that starts later
--     sees the field as unique. One lock per written row, also in organizations
--     without unique fields (a per-field lock cannot work: a writer that started
--     earlier does not know the field is becoming unique).
--   * Known limit (not built): a value held unrecorded (a public-form lead, a
--     record restored from the bin, a contact / deal that got it by conversion,
--     also a conversion done by a merge) is not protected once the record that
--     holds it recorded gives it up (cleared, binned, purged): a third record may
--     then take it, and the unrecorded holder is marked only while a recorded
--     holder exists.
--   * Restoring a record from the bin and lead conversion (the values carried to
--     the new contact and deal, app.convert_custom_fields sets app.convert_carry)
--     never refuse either, so a lead is never stranded: a value another live
--     record holds stays on the record, unrecorded.
--   * Such a record is marked: public.custom_unique_clashes(org, type, ids)
--     (security definer, members; at most 200 ids) answers, for the records the
--     caller reads, the field and the other record, named only when the caller
--     reads it too. The app shows it next to the phone / email duplicates
--     (lead, contact and company pages) and on the waiting-leads screen. Only a
--     clash with a recorded value is found (two unrecorded ones are not).
--   * Only a value that changes is (re)recorded, so an older clash never blocks
--     editing another field.
--   * Turning it on (or creating, showing again or retyping a unique field) while
--     live records already share a value is refused (hint
--     'custom_field:unique_existing', detail = the number of records that share a
--     value with another one, counted on the index right after the field's values
--     are recorded in one statement; the refusal rolls them back).
--   * A unique field cannot have a default value (every new record would get the
--     same value; hint 'custom_field:unique_default').
--
-- default_value (jsonb, null = none)
--   * Must pass app.custom_value_ok() for the field's type and options, also
--     when the options change later (hint 'custom_field:default'); no default for
--     a "user" field.
--   * A default fills an active field left empty when a record is created and
--     never overwrites a value that arrived (owner, 13 October 2026):
--     - a person's or an import's insert (browser session), by trigger
--       *_cf_defaults (before insert, before the value check). A key sent as
--       JSON null means "left empty on purpose": it is removed and gets no
--       default (the create form shows the default prefilled; a person who clears
--       it sends null). An import column mapped to the field whose cell is empty
--       sends null too, so that row gets no default; a field the import does not
--       map gets it.
--     - a lead from a public form: the same trigger acts on the insert made while
--       app.intake = 'on' (set by intake_submit around its lead insert, after
--       the form's values are in NEW); intake_submit is unchanged. The visitor
--       never sees the default.
--     - a contact / deal made by lead conversion: app.convert_custom_fields first
--       copies the lead's values, then fills what is still empty (only for a
--       record this transaction created, so never for an existing contact a
--       merge points at). convert_lead's own insert gets none (server insert).
--     - never on update, never for existing records or records made before the
--       default was set, and not for other server paths (sample data).
--   * A default in a read-only field goes in the same way, and is locked once in.
--   * A default that no longer fits the field (its options changed after it was
--     saved) is skipped without blocking the record, and a system entry on the
--     record says so ("ברירת המחדל של השדה … לא נכנסה כי הערך לא תקין"; no
--     notification).
--
-- is_read_only (default false; owner, 13 October 2026)
--   * An empty value (absent, JSON null, or text that is blank after trimming;
--     0, false and [] are values: app.custom_value_empty) may be filled once, on
--     create or later, by anyone allowed to edit the record; once it holds a
--     value it is locked for everyone: app.check_custom_fields() refuses a
--     browser update (people, and imports, which write with the person's
--     session, on create and on update) that changes, clears or removes it
--     (hint 'custom_field:read_only', detail = the field's label).
--   * No override: changing a locked value means switching read-only off in the
--     field's settings first, which the audit log records (field_definitions_audit,
--     is_read_only old/new).
--   * Automations write no custom fields (app.run_automation_actions). Lead
--     conversion writes new records only (and keeps what the contact holds). A
--     merge copies the duplicate's values only into keys the kept record does not
--     hold (m.custom_fields || k.custom_fields), so it may fill a missing value and
--     never overwrites one (a blank text the kept record holds also stays). Other
--     server paths (security definer, service role) are trusted, as for every
--     custom field check.
--   * The app shows it open while empty and as text marked "שדה לקריאה בלבד" once
--     it holds a value; an edit form never sends a locked value or an empty one.
--
-- app.check_custom_fields() is the definition of migration 0075 with the
-- read-only lines added (marked FLD-07); app.convert_custom_fields() is the
-- definition of migration 0029 with the app.convert_carry lines added. Every statement is safe to run twice.
-- No drops, no deletes.

alter table public.field_definitions add column if not exists is_unique boolean not null default false;
alter table public.field_definitions add column if not exists is_read_only boolean not null default false;
alter table public.field_definitions add column if not exists default_value jsonb;

-- -----------------------------------------------------------------------------
-- Normalized value for the unique comparison (null = empty, never clashes)
-- -----------------------------------------------------------------------------
create or replace function app.custom_unique_norm(p_type text, p_value jsonb) returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v_text text;
  v_digits text;
  v_host text;
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then
    return null;
  end if;
  if p_type = 'number' and jsonb_typeof(p_value) = 'number' then
    return trim_scale((p_value #>> '{}')::numeric)::text;
  end if;
  v_text := case when jsonb_typeof(p_value) = 'string' then p_value #>> '{}' else p_value::text end;
  if p_type = 'phone' then
    return app.normalize_phone(v_text);
  end if;
  if p_type in ('il_id', 'il_company_id') then
    v_digits := regexp_replace(v_text, '[^0-9]', '', 'g');
    if v_digits = '' then
      return null;
    end if;
    return coalesce(nullif(ltrim(v_digits, '0'), ''), '0');
  end if;
  if p_type = 'url' then
    -- http and https alike; scheme and host in lower case, the path as typed
    v_text := regexp_replace(btrim(v_text), '^https?://', '', 'i');
    v_host := substring(v_text from '^[^/?#]*');
    v_text := lower(v_host) || regexp_replace(substr(v_text, char_length(v_host) + 1), '/+$', '');
    return nullif(v_text, '');
  end if;
  return nullif(lower(regexp_replace(btrim(v_text), '\s+', ' ', 'g')), '');
end;
$$;
revoke all on function app.custom_unique_norm(text, jsonb) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- The index of unique values
-- -----------------------------------------------------------------------------
-- Keyed by the field's id (narrow keys: turning unique on writes one row per record); the rows go
-- with the field (cascade), and with the organization through it.
create table if not exists app.custom_unique_values (
  field_id   uuid not null references public.field_definitions (id) on delete cascade,
  record_id  uuid not null,
  -- null: the record is in the bin, removed, has no value, or the field is no longer enforced
  norm_value text,
  primary key (field_id, record_id),
  constraint custom_unique_values_value unique (field_id, norm_value) deferrable initially deferred
);
alter table app.custom_unique_values enable row level security;
revoke all on app.custom_unique_values from public, anon, authenticated;

create or replace function app.custom_unique_table(p_object text) returns text
language sql immutable
set search_path = ''
as $$
  select case p_object when 'lead' then 'leads' when 'contact' then 'contacts'
                       when 'company' then 'companies' when 'deal' then 'deals' end;
$$;
revoke all on function app.custom_unique_table(text) from public, anon, authenticated;

-- Forgets a field's values (unique switched off, field hidden or retyped; a deleted field's rows
-- go with it by cascade). Migration field_settings_unique_off (pasted by hand: it deletes)
-- redefines it to remove the rows, which keeps switching unique on again fast.
create or replace function app.custom_unique_forget(p_field uuid) returns void
language sql security definer
set search_path = ''
as $$
  update app.custom_unique_values v set norm_value = null where v.field_id = p_field and v.norm_value is not null;
$$;
revoke all on function app.custom_unique_forget(uuid) from public, anon, authenticated;

-- Records every live value of a field in one statement, then answers how many
-- live records share a value with another one (counted on the index). A caller
-- that gets more than 0 raises, which rolls the rows back.
create or replace function app.custom_unique_fill(p_field uuid, p_org uuid, p_object text, p_key text, p_type text) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_table text := app.custom_unique_table(p_object);
  v_rows integer;
  v_dups integer;
begin
  if v_table is null then
    return 0;
  end if;
  -- waits for every transaction that is writing records of this type in the organization (they hold
  -- the shared lock from app.custom_unique_sync until they end), and makes new ones wait until this
  -- transaction ends: the values read below are complete, and a record written after it sees the field
  perform pg_advisory_xact_lock(hashtextextended('custom_unique:' || p_org::text || ':' || p_object, 0));
  -- the per-row message trigger is not needed for these rows: the count below answers for them
  perform set_config('app.custom_unique_fill', 'on', true);
  execute format(
    'insert into app.custom_unique_values (field_id, record_id, norm_value)
     select $5, n.id, n.v
       from (select t.id, app.custom_unique_norm($4, t.custom_fields -> $3) as v
               from public.%I t
              where t.organization_id = $1 and t.deleted_at is null and t.custom_fields ? $3
             offset 0) n
      where n.v is not null
      order by n.v
     on conflict (field_id, record_id) do update set norm_value = excluded.norm_value', v_table)
    using p_org, p_object, p_key, p_type, p_field;
  get diagnostics v_rows = row_count;
  perform set_config('app.custom_unique_fill', '', true);
  select coalesce(sum(g.n), 0)::integer into v_dups
    from (select count(*) as n from app.custom_unique_values v
           where v.field_id = p_field and v.norm_value is not null
           group by v.norm_value having count(*) > 1) g;
  -- many rows at once: fresh statistics, so the per-row lookups that follow use the indexes
  if v_rows > 1000 and v_dups = 0 then
    analyze app.custom_unique_values;
  end if;
  return v_dups;
end;
$$;
revoke all on function app.custom_unique_fill(uuid, uuid, text, text, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- The settings themselves
-- -----------------------------------------------------------------------------
create or replace function app.field_settings_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_dups integer;
  v_on_old boolean := false;
  v_on_new boolean := false;
  v_same boolean := false;
begin
  if new.default_value is not null and jsonb_typeof(new.default_value) = 'null' then
    new.default_value := null;
  end if;
  if new.is_unique and new.field_type not in ('text', 'number', 'email', 'phone', 'url', 'il_id', 'il_company_id') then
    raise exception 'a % field cannot be unique', new.field_type using errcode = 'P0001', hint = 'custom_field:unique_type';
  end if;
  if new.default_value is not null then
    if new.is_unique then
      raise exception 'a unique field has no default value' using errcode = 'P0001', hint = 'custom_field:unique_default';
    end if;
    if new.field_type = 'user' or not app.custom_value_ok(new.field_type, new.options, new.default_value) then
      raise exception 'invalid default value' using errcode = 'P0001', hint = 'custom_field:default';
    end if;
  end if;

  v_on_new := new.is_unique and new.is_active;
  if tg_op = 'UPDATE' then
    v_on_old := old.is_unique and old.is_active;
    v_same := new.organization_id = old.organization_id and new.object_type = old.object_type
              and new.key = old.key and new.field_type = old.field_type;
  end if;
  if v_on_old and not (v_on_new and v_same) then
    perform app.custom_unique_forget(old.id);
  end if;
  if v_on_new and not (v_on_old and v_same) then
    -- a person who is not an owner or admin of the row's organization is refused by RLS right after;
    -- nothing about that organization's records is counted or recorded for them
    if auth.uid() is not null and not app.is_admin(new.organization_id) then
      return new;
    end if;
    -- rows left from an earlier time the field was enforced, then this field's values now
    perform app.custom_unique_forget(new.id);
    v_dups := app.custom_unique_fill(new.id, new.organization_id, new.object_type, new.key, new.field_type);
    if v_dups > 0 then
      raise exception 'custom field values are not unique' using errcode = 'P0001', hint = 'custom_field:unique_existing', detail = v_dups::text;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.field_settings_check() from public, anon, authenticated;

create or replace trigger field_definitions_settings_check before insert or update on public.field_definitions
  for each row execute function app.field_settings_check();

-- -----------------------------------------------------------------------------
-- Default values on create (people, imports, public forms, conversion)
-- -----------------------------------------------------------------------------
-- The values with the defaults of the active fields whose key is absent added. A
-- key that holds JSON null was left empty on purpose (a person cleared the
-- prefilled default): it is removed and gets no default. A default that no longer
-- fits the field (its options changed) is skipped and its field's label returned in
-- p_skipped. Security invoker (the browser trigger reads the fields as the person,
-- who reads their organization's fields); the callers decide who gets defaults.
create or replace function app.custom_field_defaults_apply(p_org uuid, p_object text, p_values jsonb, out p_result jsonb, out p_skipped text[])
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_field record;
begin
  p_result := coalesce(p_values, '{}'::jsonb);
  p_skipped := '{}';
  for v_field in
    select f.key, f.label, f.default_value, f.field_type, f.options
      from public.field_definitions f
     where f.organization_id = p_org and f.object_type = p_object and f.is_active and f.default_value is not null
     order by f.position, f.created_at
  loop
    if p_result ? v_field.key then
      if jsonb_typeof(p_result -> v_field.key) = 'null' then
        p_result := p_result - v_field.key;
      end if;
    elsif v_field.field_type <> 'user' and app.custom_value_ok(v_field.field_type, v_field.options, v_field.default_value) then
      p_result := p_result || jsonb_build_object(v_field.key, v_field.default_value);
    else
      p_skipped := p_skipped || v_field.label;
    end if;
  end loop;
end;
$$;
revoke all on function app.custom_field_defaults_apply(uuid, text, jsonb) from public, anon;
grant execute on function app.custom_field_defaults_apply(uuid, text, jsonb) to authenticated;

-- A system entry on the record for each default that did not go in (no notification).
create or replace function app.custom_field_default_warnings(p_org uuid, p_object text, p_record uuid, p_labels text[]) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_label text;
begin
  foreach v_label in array coalesce(p_labels, '{}') loop
    insert into public.activities (organization_id, type, body, metadata, lead_id, contact_id, company_id, deal_id)
    values (p_org, 'system', format('ברירת המחדל של השדה %s לא נכנסה כי הערך לא תקין', v_label),
            jsonb_build_object('kind', 'default_skipped', 'field', v_label),
            case when p_object = 'lead' then p_record end, case when p_object = 'contact' then p_record end,
            case when p_object = 'company' then p_record end, case when p_object = 'deal' then p_record end);
  end loop;
end;
$$;
revoke all on function app.custom_field_default_warnings(uuid, text, uuid, text[]) from public, anon, authenticated;

-- Before insert: a record created by a person or an import (browser session), or a
-- lead created by a public form (intake_submit sets app.intake = 'on' around its lead
-- insert, after the form's values are in NEW; intake_submit itself is unchanged).
-- Not for other server inserts: convert_lead's contact and deal get theirs after the
-- lead's values are copied (app.convert_custom_fields). Skipped defaults wait in
-- app.cf_default_skipped (this transaction) for the after-insert trigger below,
-- because the record does not exist yet.
create or replace function app.custom_field_defaults() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_applied record;
  v_waiting jsonb;
begin
  if current_user not in ('authenticated', 'anon')
     and not (tg_argv[0] = 'lead' and coalesce(current_setting('app.intake', true), '') = 'on') then
    return new;
  end if;
  select * into v_applied from app.custom_field_defaults_apply(new.organization_id, tg_argv[0], new.custom_fields);
  new.custom_fields := v_applied.p_result;
  if cardinality(v_applied.p_skipped) > 0 then
    v_waiting := coalesce(nullif(current_setting('app.cf_default_skipped', true), '')::jsonb, '{}'::jsonb);
    perform set_config('app.cf_default_skipped',
      (v_waiting || jsonb_build_object(new.id::text, to_jsonb(v_applied.p_skipped)))::text, true);
  end if;
  return new;
end;
$$;
revoke all on function app.custom_field_defaults() from public, anon, authenticated;

create or replace function app.custom_field_defaults_logged() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_waiting jsonb := coalesce(nullif(current_setting('app.cf_default_skipped', true), '')::jsonb, '{}'::jsonb);
  v_labels text[];
begin
  if not v_waiting ? new.id::text then
    return null;
  end if;
  select coalesce(array_agg(x), '{}') into v_labels from jsonb_array_elements_text(v_waiting -> new.id::text) x;
  perform set_config('app.cf_default_skipped', (v_waiting - new.id::text)::text, true);
  perform app.custom_field_default_warnings(new.organization_id, tg_argv[0], new.id, v_labels);
  return null;
end;
$$;
revoke all on function app.custom_field_defaults_logged() from public, anon, authenticated;

create or replace trigger leads_cf_defaults_logged after insert on public.leads
  for each row when (coalesce(current_setting('app.cf_default_skipped', true), '') not in ('', '{}'))
  execute function app.custom_field_defaults_logged('lead');
create or replace trigger contacts_cf_defaults_logged after insert on public.contacts
  for each row when (coalesce(current_setting('app.cf_default_skipped', true), '') not in ('', '{}'))
  execute function app.custom_field_defaults_logged('contact');
create or replace trigger companies_cf_defaults_logged after insert on public.companies
  for each row when (coalesce(current_setting('app.cf_default_skipped', true), '') not in ('', '{}'))
  execute function app.custom_field_defaults_logged('company');
create or replace trigger deals_cf_defaults_logged after insert on public.deals
  for each row when (coalesce(current_setting('app.cf_default_skipped', true), '') not in ('', '{}'))
  execute function app.custom_field_defaults_logged('deal');

-- "cf_defaults" sorts before "custom_fields_check", so the check sees the defaults
create or replace trigger leads_cf_defaults before insert on public.leads
  for each row execute function app.custom_field_defaults('lead');
create or replace trigger contacts_cf_defaults before insert on public.contacts
  for each row execute function app.custom_field_defaults('contact');
create or replace trigger companies_cf_defaults before insert on public.companies
  for each row execute function app.custom_field_defaults('company');
create or replace trigger deals_cf_defaults before insert on public.deals
  for each row execute function app.custom_field_defaults('deal');

-- -----------------------------------------------------------------------------
-- Read-only: app.check_custom_fields() of migration 0075 plus the FLD-07 lines
-- -----------------------------------------------------------------------------
-- Empty for the read-only rule: absent, JSON null, or text that is blank after trimming
-- (0, false and an empty list are values). Mirrored by isEmptyCustomValue() in
-- src/features/custom-fields/settings.ts.
create or replace function app.custom_value_empty(p_value jsonb) returns boolean
language sql immutable
set search_path = ''
as $$
  select p_value is null or jsonb_typeof(p_value) = 'null'
         or (jsonb_typeof(p_value) = 'string' and (p_value #>> '{}') ~ '^[[:space:]]*$');
$$;
revoke all on function app.custom_value_empty(jsonb) from public, anon;
grant execute on function app.custom_value_empty(jsonb) to authenticated;
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
    select f.field_type, f.options, f.is_read_only, f.label into v_type, v_options, v_read_only, v_label
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
  end loop;
  return new;
end;
$$;

revoke all on function app.check_custom_fields() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Unique values: kept in app.custom_unique_values for every writer
-- -----------------------------------------------------------------------------
create or replace function app.custom_unique_sync() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_object text := tg_argv[0];
  r record;
  v_norm text;
  v_live boolean;
  v_lenient boolean;
  v_intake boolean;
begin
  if tg_op = 'DELETE' then
    -- by primary key, one enforced field at a time (rows of other fields hold null already)
    update app.custom_unique_values v set norm_value = null
      from public.field_definitions f
     where f.organization_id = old.organization_id and f.object_type = v_object and f.is_unique and f.is_active
       and v.field_id = f.id and v.record_id = old.id and v.norm_value is not null;
    return null;
  end if;
  -- a lead from a public form is never refused (see the header): its value is recorded when free
  v_intake := tg_op = 'INSERT' and coalesce(current_setting('app.intake', true), '') = 'on';
  -- waits while a unique field of this organization and record type is being turned on, so the
  -- fields read below are the ones in force (see app.custom_unique_fill)
  perform pg_advisory_xact_lock_shared(hashtextextended('custom_unique:' || new.organization_id::text || ':' || v_object, 0));
  v_live := new.deleted_at is null;
  -- a public-form lead, restoring from the bin and lead conversion never refuse: a value another live
  -- record holds stays on this record, unrecorded, and is marked (public.custom_unique_clashes)
  v_lenient := v_intake
               or (tg_op = 'UPDATE' and old.deleted_at is not null and v_live)
               or coalesce(current_setting('app.convert_carry', true), '') = 'on';
  for r in
    select f.id, f.key, f.field_type
      from public.field_definitions f
     where f.organization_id = new.organization_id and f.object_type = v_object and f.is_unique and f.is_active
  loop
    v_norm := case when v_live then app.custom_unique_norm(r.field_type, new.custom_fields -> r.key) end;
    -- only a value that changes, or a record that enters or leaves the bin, is (re)recorded
    continue when tg_op = 'UPDATE' and (old.deleted_at is null) = v_live
              and (not v_live or app.custom_unique_norm(r.field_type, old.custom_fields -> r.key) is not distinct from v_norm);
    if v_norm is not null and v_lenient and exists (
      select 1 from app.custom_unique_values v
       where v.field_id = r.id and v.norm_value = v_norm and v.record_id <> new.id
    ) then
      v_norm := null;
    end if;
    if v_norm is null then
      update app.custom_unique_values v set norm_value = null
       where v.field_id = r.id and v.record_id = new.id and v.norm_value is not null;
    elsif v_intake then
      -- judged now, not at commit: a value another transaction is writing at this moment is waited
      -- for, and if it wins the form's lead keeps the value unrecorded instead of failing at commit
      begin
        set constraints app.custom_unique_values_value immediate;
        insert into app.custom_unique_values (field_id, record_id, norm_value)
        values (r.id, new.id, v_norm)
        on conflict (field_id, record_id) do update set norm_value = excluded.norm_value;
        set constraints app.custom_unique_values_value deferred;
      exception when unique_violation then
        null;
      end;
    else
      insert into app.custom_unique_values (field_id, record_id, norm_value)
      values (r.id, new.id, v_norm)
      on conflict (field_id, record_id) do update set norm_value = excluded.norm_value;
    end if;
  end loop;
  return null;
end;
$$;
revoke all on function app.custom_unique_sync() from public, anon, authenticated;

create or replace trigger leads_custom_unique_sync after insert or update of custom_fields, deleted_at or delete on public.leads
  for each row execute function app.custom_unique_sync('lead');
create or replace trigger contacts_custom_unique_sync after insert or update of custom_fields, deleted_at or delete on public.contacts
  for each row execute function app.custom_unique_sync('contact');
create or replace trigger companies_custom_unique_sync after insert or update of custom_fields, deleted_at or delete on public.companies
  for each row execute function app.custom_unique_sync('company');
create or replace trigger deals_custom_unique_sync after insert or update of custom_fields, deleted_at or delete on public.deals
  for each row execute function app.custom_unique_sync('deal');

-- The readable refusal, at commit (before the constraint's own check, which only
-- answers first when two transactions race): an index lookup on the row as it
-- is now.
create or replace function app.custom_unique_message() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_label text;
begin
  if not exists (
    select 1 from app.custom_unique_values v
     where v.field_id = new.field_id and v.record_id = new.record_id and v.norm_value = new.norm_value
  ) then
    return null;
  end if;
  if exists (
    select 1 from app.custom_unique_values v
     where v.field_id = new.field_id and v.norm_value = new.norm_value and v.record_id <> new.record_id
  ) then
    select f.label into v_label from public.field_definitions f
     where f.id = new.field_id;
    raise exception 'custom field value must be unique' using errcode = '23505', hint = 'custom_field:unique', detail = coalesce(v_label, '');
  end if;
  return null;
end;
$$;
revoke all on function app.custom_unique_message() from public, anon, authenticated;

-- CREATE OR REPLACE does not replace a constraint trigger, so it is created only when missing.
-- The WHEN clause is evaluated when the row is written, so app.custom_unique_fill skips it.
-- At commit the deferred triggers of one row run in name order (bytes); the constraint's own
-- check is the internal "Unique_ConstraintTrigger_<oid>", so this one is named with a capital
-- "A" to run before it.
do $$
begin
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'app.custom_unique_values'::regclass and tgname = 'A_custom_unique_values_message' and not tgisinternal
  ) then
    create constraint trigger "A_custom_unique_values_message"
      after insert or update of norm_value on app.custom_unique_values
      deferrable initially deferred
      for each row
      when (new.norm_value is not null and current_setting('app.custom_unique_fill', true) is distinct from 'on')
      execute function app.custom_unique_message();
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Lead conversion: app.convert_custom_fields() of migration 0029 with the FLD-07
-- lines: app.convert_carry (a carried value that is taken is kept and marked), it
-- also runs for a lead without custom values, and the defaults of the new contact /
-- deal fill what is still empty after the lead's values are copied
-- -----------------------------------------------------------------------------
create or replace function app.convert_custom_fields() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_applied record;
  v_new boolean;
begin
  if old.converted_at is not null or new.converted_at is null then
    return null;
  end if;
  perform set_config('app.convert_carry', 'on', true);
  if new.converted_contact_id is not null then
    -- FLD-07: defaults only for a contact this transaction created (convert_lead), never for an older one (a merge)
    select c.created_at = now() into v_new from public.contacts c
     where c.organization_id = new.organization_id and c.id = new.converted_contact_id;
    if new.custom_fields <> '{}'::jsonb then
      update public.contacts c
         set custom_fields = app.carry_custom_fields(new.organization_id, new.custom_fields, 'contact') || c.custom_fields
       where c.organization_id = new.organization_id and c.id = new.converted_contact_id;
    end if;
    if v_new then
      select a.* into v_applied from public.contacts c
        cross join lateral app.custom_field_defaults_apply(new.organization_id, 'contact', c.custom_fields) a
       where c.organization_id = new.organization_id and c.id = new.converted_contact_id;
      update public.contacts c set custom_fields = v_applied.p_result
       where c.organization_id = new.organization_id and c.id = new.converted_contact_id
         and c.custom_fields is distinct from v_applied.p_result;
      perform app.custom_field_default_warnings(new.organization_id, 'contact', new.converted_contact_id, v_applied.p_skipped);
    end if;
  end if;
  if new.converted_deal_id is not null then
    select d.created_at = now() into v_new from public.deals d
     where d.organization_id = new.organization_id and d.id = new.converted_deal_id;
    if new.custom_fields <> '{}'::jsonb then
      update public.deals d
         set custom_fields = app.carry_custom_fields(new.organization_id, new.custom_fields, 'deal') || d.custom_fields
       where d.organization_id = new.organization_id and d.id = new.converted_deal_id;
    end if;
    if v_new then
      select a.* into v_applied from public.deals d
        cross join lateral app.custom_field_defaults_apply(new.organization_id, 'deal', d.custom_fields) a
       where d.organization_id = new.organization_id and d.id = new.converted_deal_id;
      update public.deals d set custom_fields = v_applied.p_result
       where d.organization_id = new.organization_id and d.id = new.converted_deal_id
         and d.custom_fields is distinct from v_applied.p_result;
      perform app.custom_field_default_warnings(new.organization_id, 'deal', new.converted_deal_id, v_applied.p_skipped);
    end if;
  end if;
  perform set_config('app.convert_carry', '', true);
  return null;
end;
$$;
revoke all on function app.convert_custom_fields() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- The mark: records (of those asked, that the caller reads) whose value of an
-- enforced unique field another live record holds: a public-form lead, a record
-- restored from the bin, or a contact / deal made by conversion. The other record
-- is named only when the caller may read it (the select policy's own rule,
-- app.can_read_record); otherwise other_id is null and the app shows the mark
-- without a link. Security definer because the index lives in schema app.
-- -----------------------------------------------------------------------------
create or replace function public.custom_unique_clashes(p_org uuid, p_type text, p_ids uuid[])
returns table (record_id uuid, field_key text, field_label text, other_id uuid)
language plpgsql stable security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_table text := app.custom_unique_table(p_type);
  v_self record;
  v_field record;
  v_norm text;
  v_other uuid;
  v_readable boolean;
begin
  if v_table is null or p_ids is null or cardinality(p_ids) > 200 then
    raise exception 'invalid arguments' using errcode = '22023';
  end if;
  for v_self in execute format(
    'select t.id, t.custom_fields from public.%I t
      where t.organization_id = $1 and t.id = any ($2) and t.deleted_at is null
        and app.can_read_record(t.organization_id, t.owner_id, t.team_id)', v_table)
    using p_org, p_ids
  loop
    for v_field in
      select d.id, d.key, d.label, d.field_type from public.field_definitions d
       where d.organization_id = p_org and d.object_type = p_type and d.is_unique and d.is_active
       order by d.position, d.created_at
    loop
      v_norm := app.custom_unique_norm(v_field.field_type, v_self.custom_fields -> v_field.key);
      continue when v_norm is null;
      select v.record_id into v_other from app.custom_unique_values v
       where v.field_id = v_field.id and v.norm_value = v_norm and v.record_id <> v_self.id
       limit 1;
      continue when v_other is null;
      v_readable := false;
      execute format(
        'select app.can_read_record(t.organization_id, t.owner_id, t.team_id) from public.%I t
          where t.organization_id = $1 and t.id = $2 and t.deleted_at is null', v_table)
        into v_readable using p_org, v_other;
      record_id := v_self.id;
      field_key := v_field.key;
      field_label := v_field.label;
      other_id := case when coalesce(v_readable, false) then v_other end;
      return next;
    end loop;
  end loop;
end;
$$;
revoke all on function public.custom_unique_clashes(uuid, text, uuid[]) from public, anon;
grant execute on function public.custom_unique_clashes(uuid, text, uuid[]) to authenticated;
