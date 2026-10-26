-- =============================================================================
-- CNS-05: marketing consent columns in a leads or contacts import
-- =============================================================================
-- SPEC-ADDITIONS 12 (CNS-05): in an import, a consent column can be mapped. Without one the state stays
-- "unknown" (nothing is written), and then nothing marketing is sent (CNS-07 enforces it). The importer
-- declares where the consents came from. Consents are law and privacy: open on every plan (no plan key).
--
-- * import_jobs.consent_method / consent_note: the importer's declaration, made when the job is created (insert
--   column grants, never changed: no update grant). A closed list of how the consents were obtained (DRAFT wording
--   until the lawyer edits it; app.import_consent_method_label mirrors IMPORT_CONSENT_METHOD_LABELS in
--   src/features/imports/consent.ts, a unit test reads this file) and a required short note (1..500). Only a leads or
--   contacts job takes one (hint import_consent:entity). Each declaration is written to the audit log (action
--   import_consent, entity import_jobs, the method, note, object and file name).
-- * public.import_record_consents(org, job, items): the one writer of import consents (consents.source 'import';
--   browsers may insert only 'manual'). Security definer, granted to authenticated, and it checks first: the caller
--   may import (app.can_import, writable business), and the job is the caller's own RUNNING leads or contacts job in
--   this business (the rule of app.guard_import_tag) that has a declaration (hint import_consent:undeclared). Each
--   item {record_id, channel email|sms|whatsapp, state granted|denied, address} answers one word, in order:
--     written       one row in public.consents (state, source 'import', method = the declaration, recorded_by = the
--                   caller), hashed by app.consent_prepare with consent_hash_key, or kept pending while the key is
--                   missing (the backfill hashes it later), exactly like every other server writer;
--     locked        a 'granted' for an address that opted out or asked to be erased in this business: never lifted by
--                   an import (owner's rule of 26 October 2026 for anonymous and third-party claims, CAP-07 answer 3;
--                   the shared check app.consent_address_locked, also used by the public form). A 'denied' is always
--                   written: it only adds protection;
--     other_address the record's own primary address for the channel is not the address in the file (the register
--                   hashes the record's address; e.g. an update matched through a further phone or email, CON-01);
--     refused       not a live record of this job's type that the job created, nor a live record the caller may edit
--                   (app.can_edit_record) that the job may touch: an update-mode job any state, any other job a
--                   'denied' only (a row skipped as a duplicate still records an opt-out on the matched record; a
--                   'granted' there stays refused, review of 8274c04);
--     invalid       a malformed item.
--   At most 1,000 items per call (hint import_consent:too_many).
-- * Undoing an import never deletes consents (append-only, CNS-02): the records go to the recycle bin with their
--   consent history, and a purge 30 days later leaves the rows with their hash and state, as for any record.
-- * app.intake_marketing_consent (CAP-07) is the body of 020935 with its opt-out check moved into
--   app.consent_address_locked, unchanged in behaviour.
-- Every statement is safe to run twice.

alter table public.import_jobs add column if not exists consent_method text;
alter table public.import_jobs add column if not exists consent_note text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'import_jobs_consent_method_known' and conrelid = 'public.import_jobs'::regclass) then
    alter table public.import_jobs add constraint import_jobs_consent_method_known
      check (consent_method in ('website_form', 'signed_form', 'event', 'purchase', 'previous_system', 'other'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'import_jobs_consent_declared' and conrelid = 'public.import_jobs'::regclass) then
    alter table public.import_jobs add constraint import_jobs_consent_declared
      check ((consent_method is null) = (consent_note is null) and char_length(consent_note) between 1 and 500);
  end if;
end;
$$;

comment on column public.import_jobs.consent_method is
  'CNS-05: how the marketing consents in the file were obtained (the importer''s declaration, closed list); null = no consent column';
comment on column public.import_jobs.consent_note is
  'CNS-05: the importer''s short note on the consents'' source (1..500), required with consent_method';

grant insert (consent_method, consent_note) on public.import_jobs to authenticated;

-- ----------------------------------------------------------------------------
-- The declaration's labels (DRAFT until the lawyer edits them)
-- ----------------------------------------------------------------------------
create or replace function app.import_consent_method_label(p_method text) returns text
language sql immutable
set search_path = ''
as $$
  select case p_method
    when 'website_form' then 'טופס הרשמה באתר או בדף נחיתה'
    when 'signed_form' then 'טופס או הסכם חתום'
    when 'event' then 'הרשמה באירוע, בכנס או בחנות'
    when 'purchase' then 'אישור דיוור בזמן קנייה'
    when 'previous_system' then 'מערכת קודמת שבה נרשמו ההסכמות'
    when 'other' then 'אחר'
  end;
$$;
revoke all on function app.import_consent_method_label(text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The declaration: only on a leads or contacts job, trimmed, audited
-- ----------------------------------------------------------------------------
create or replace function app.import_jobs_consent_check() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  new.consent_note := nullif(btrim(new.consent_note), '');
  if new.consent_method is not null and new.entity_type not in ('lead', 'contact') then
    raise exception 'consents are imported with leads or contacts only' using errcode = 'P0001', hint = 'import_consent:entity';
  end if;
  if (new.consent_method is null) <> (new.consent_note is null) then
    raise exception 'a consent declaration needs its source and a note' using errcode = 'P0001', hint = 'import_consent:note';
  end if;
  return new;
end;
$$;
revoke all on function app.import_jobs_consent_check() from public, anon, authenticated;

create or replace trigger import_jobs_consent_check before insert on public.import_jobs
  for each row execute function app.import_jobs_consent_check();

create or replace function app.import_jobs_consent_audit() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.consent_method is not null then
    insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
    values (new.organization_id, auth.uid(), 'import_consent', 'import_jobs', new.id,
            jsonb_build_object('consent_method', new.consent_method, 'consent_note', new.consent_note,
                               'entity_type', new.entity_type, 'file_name', new.file_name));
  end if;
  return null;
end;
$$;
revoke all on function app.import_jobs_consent_audit() from public, anon, authenticated;

create or replace trigger import_jobs_consent_audit after insert on public.import_jobs
  for each row execute function app.import_jobs_consent_audit();

-- ----------------------------------------------------------------------------
-- Has this address opted out (or asked to be erased) on this channel in the business?
-- ----------------------------------------------------------------------------
-- The check of app.intake_marketing_consent (020935), moved here unchanged so the public form (CAP-07) and the import
-- (CNS-05) share it. True = a 'granted' from a public form tick or an import must not be written. Read with the
-- existing rule (app.consent_state_of) by the address hash across the business; entries still waiting for their hash
-- are compared by their stored address. While the key is missing: the record's own entries, and any hashed opt-out of
-- the business on this channel blocks (fail closed: nothing is lifted that cannot be compared). p_address is the
-- normalized address (phone_e164, lower-cased email). No grants: definer callers only.
create or replace function app.consent_address_locked(p_org uuid, p_lead uuid, p_contact uuid, p_channel text, p_address text)
returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_hash text;
  v_state text;
begin
  v_hash := app.consent_address_hash(p_org, app.consent_address_kind(p_channel), p_address, 1::smallint);
  if v_hash is not null then
    v_state := app.consent_state_of(p_org, p_channel, v_hash, null, null);
  else
    v_state := app.consent_state_of(p_org, p_channel, null, p_lead, p_contact);
    if v_state is distinct from 'out' and v_state is distinct from 'blocked' and exists (
      select 1 from public.consents c
       where c.organization_id = p_org and c.channel = p_channel and c.state in ('withdrawn', 'denied')
         and c.address_hash is not null and c.hash_version = 1) then
      v_state := 'out';
    end if;
  end if;
  if v_state in ('out', 'blocked') then
    return true;
  end if;
  -- entries still waiting for their hash, by the address they were written for
  return exists (
    select 1 from public.consents c
      join app.consent_pending_address p on p.consent_id = c.id
     where c.organization_id = p_org and c.channel = p_channel and c.state in ('withdrawn', 'denied')
       and c.address_hash is null and p.organization_id = p_org
       and p.kind = app.consent_address_kind(p_channel) and p.value = p_address);
end;
$$;
revoke all on function app.consent_address_locked(uuid, uuid, uuid, text, text) from public, anon, authenticated;

-- CAP-07: the body of 020935 with its opt-out check in app.consent_address_locked (same rule, same order)
create or replace function app.intake_marketing_consent(p_org uuid, p_lead uuid, p_contact uuid, p_channels text[],
                                                        p_wording jsonb, p_email text, p_phone_e164 text)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_channel text;
  v_address text;
  v_count integer := 0;
begin
  if num_nonnulls(p_lead, p_contact) <> 1 then
    return 0;
  end if;
  foreach v_channel in array coalesce(p_channels, '{}'::text[]) loop
    continue when v_channel not in ('email', 'sms', 'whatsapp');
    v_address := case when v_channel = 'email' then p_email else p_phone_e164 end;
    continue when v_address is null;
    continue when app.consent_record_address(p_org, p_lead, p_contact, v_channel) is distinct from v_address;
    -- an opt-out or erasure block of this address is never lifted by a public-form tick
    continue when app.consent_address_locked(p_org, p_lead, p_contact, v_channel, v_address);

    insert into public.consents (organization_id, lead_id, contact_id, channel, state, source, wording, wording_version)
    values (p_org, p_lead, p_contact, v_channel, 'granted', 'form',
            nullif(p_wording ->> v_channel, ''), app.marketing_consent_version());
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function app.intake_marketing_consent(uuid, uuid, uuid, text[], jsonb, text, text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The import's consents (the only writer of source 'import')
-- ----------------------------------------------------------------------------
create or replace function public.import_record_consents(p_org uuid, p_job uuid, p_items jsonb) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_job record;
  v_item jsonb;
  v_out jsonb := '[]'::jsonb;
  v_result text;
  v_record uuid;
  v_channel text;
  v_state text;
  v_address text;
  v_lead uuid;
  v_contact uuid;
  v_ok boolean;
  v_method text;
  v_hint text;
begin
  if auth.uid() is null or p_org is null or p_job is null or not coalesce(app.can_import(p_org), false) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  -- the caller's own running leads or contacts import in this business (the rule of app.guard_import_tag)
  select j.entity_type, j.duplicate_mode, j.consent_method, j.consent_note into v_job
    from public.import_jobs j
   where j.organization_id = p_org and j.id = p_job and j.created_by = auth.uid() and j.status = 'running'
     and j.entity_type in ('lead', 'contact');
  if not found then
    raise exception 'not a running import of this user' using errcode = '42501';
  end if;
  if v_job.consent_method is null then
    raise exception 'the import has no consent declaration' using errcode = 'P0001', hint = 'import_consent:undeclared';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'items must be an array' using errcode = '22023', hint = 'import_consent:items';
  end if;
  if jsonb_array_length(p_items) > 1000 then
    raise exception 'too many consents in one call' using errcode = 'P0001', hint = 'import_consent:too_many';
  end if;
  v_method := left(app.import_consent_method_label(v_job.consent_method) || ': ' || v_job.consent_note, 500);

  for v_item in select e from jsonb_array_elements(p_items) as e loop
    v_result := null;
    v_record := null;
    v_ok := null;
    if jsonb_typeof(v_item) = 'object' then
      begin
        v_record := (v_item ->> 'record_id')::uuid;
      exception when others then
        v_record := null;
      end;
    end if;
    v_channel := case when jsonb_typeof(v_item) = 'object' then v_item ->> 'channel' end;
    v_state := case when jsonb_typeof(v_item) = 'object' then v_item ->> 'state' end;
    v_address := case when jsonb_typeof(v_item) = 'object' then nullif(btrim(v_item ->> 'address'), '') end;
    if v_record is null or v_channel is null or v_channel not in ('email', 'sms', 'whatsapp')
       or v_state is null or v_state not in ('granted', 'denied') then
      v_result := 'invalid';
    else
      if v_job.entity_type = 'lead' then
        v_lead := v_record;
        v_contact := null;
        select true into v_ok from public.leads l
         where l.organization_id = p_org and l.id = v_record and l.deleted_at is null
           and (l.import_job_id = p_job
                or ((v_job.duplicate_mode = 'update' or v_state = 'denied')
                    and app.can_edit_record(l.organization_id, l.owner_id, l.team_id)));
      else
        v_lead := null;
        v_contact := v_record;
        select true into v_ok from public.contacts c
         where c.organization_id = p_org and c.id = v_record and c.deleted_at is null
           and (c.import_job_id = p_job
                or ((v_job.duplicate_mode = 'update' or v_state = 'denied')
                    and app.can_edit_record(c.organization_id, c.owner_id, c.team_id)));
      end if;
      v_address := case when v_channel = 'email' then lower(v_address) else app.normalize_phone(v_address) end;
      if not coalesce(v_ok, false) then
        v_result := 'refused';
      elsif v_address is null
            or app.consent_record_address(p_org, v_lead, v_contact, v_channel) is distinct from v_address then
        v_result := 'other_address';
      elsif v_state = 'granted' and app.consent_address_locked(p_org, v_lead, v_contact, v_channel, v_address) then
        v_result := 'locked';
      else
        begin
          insert into public.consents (organization_id, lead_id, contact_id, channel, state, source, method)
          values (p_org, v_lead, v_contact, v_channel, v_state, 'import', v_method);
          v_result := 'written';
        exception when sqlstate 'P0001' then
          get stacked diagnostics v_hint = pg_exception_hint;
          -- the register's own lock (consents_prepare) agrees with the check above; never lifted
          if v_hint in ('consent:optout_locked', 'consent:erasure_block', 'consent:address_blocked') then
            v_result := 'locked';
          else
            raise;
          end if;
        end;
      end if;
    end if;
    v_out := v_out || to_jsonb(v_result);
  end loop;
  return v_out;
end;
$$;
revoke all on function public.import_record_consents(uuid, uuid, jsonb) from public, anon;
grant execute on function public.import_record_consents(uuid, uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';
