-- =============================================================================
-- CNS-06 answer 3: an import's "granted" for a blocked address stays locked, and the import's report counts it
-- =============================================================================
-- Owner's answer of 26 October 2026 (DECISIONS.md, "רשימת חסימה עסקית: פרטים", 3 (א)): an import's "מאשר" for an address
-- that unsubscribed itself, was erased or is on the blocklist stays locked and records nothing (as built in 020950), and
-- the import's report shows "N כתובות חסומות או שהוסרו: לא נרשמה הסכמה".
-- * public.import_jobs.consents_locked (server only: no client update grant; select follows the table's grant): how many
--   'locked' answers public.import_record_consents gave for the job, summed over its calls.
-- * public.import_record_consents: 020985's body; counts its 'locked' answers into the job, and a register refusal with
--   the hint consent:blocklisted (an owner's or admin's import racing an addition to the blocklist) is a 'locked' answer
--   like the other locks, not an error that fails the chunk.
--   The job is now taken FOR NO KEY UPDATE up front (020985 took it FOR SHARE): the call updates the job's count at
--   the end, and two calls of one job holding FOR SHARE and both upgrading to an update would deadlock. NO KEY UPDATE
--   still keeps the job from being finished or undone while entries are written (finishing is an update of status,
--   undo takes the job FOR UPDATE first, then the records: the same order as here, job before records), and two calls
--   of one job now simply wait for each other. A job finished meanwhile is re-checked after the wait (status
--   'running'), so a late call is refused as before.
-- Only adds a column and creates or replaces a function; safe to run twice.

alter table public.import_jobs add column if not exists consents_locked integer not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'import_jobs_consents_locked_check'
                  and conrelid = 'public.import_jobs'::regclass) then
    alter table public.import_jobs add constraint import_jobs_consents_locked_check check (consents_locked >= 0);
  end if;
end;
$$;

comment on column public.import_jobs.consents_locked is
  'CNS-06: consents of the import kept out because the address opted out, was erased or is on the blocklist (server only)';

-- ----------------------------------------------------------------------------
-- The import's consents: 020985's body; 'locked' answers are counted on the job
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
  -- CNS-06 answer 3: the 'locked' answers of this call, added to the job's count
  v_locked integer := 0;
begin
  if auth.uid() is null or p_org is null or p_job is null or not coalesce(app.can_import(p_org), false) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  -- the caller's own running leads or contacts import in this business (the rule of app.guard_import_tag)
  select j.entity_type, j.duplicate_mode, j.consent_method, j.consent_note into v_job
    from public.import_jobs j
   where j.organization_id = p_org and j.id = p_job and j.created_by = auth.uid() and j.status = 'running'
     and j.entity_type in ('lead', 'contact')
     -- CNS-05 undo: held until this call commits, so the job is not finished and undone while entries are still written;
     -- NO KEY UPDATE (CNS-06 answer 3), because the count is updated on the same row below (FOR SHARE then update deadlocks)
     for no key update;
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
          -- the job is kept on the entry, so undoing the import can cancel it (server only)
          insert into public.consents (organization_id, lead_id, contact_id, channel, state, source, method, import_job_id)
          values (p_org, v_lead, v_contact, v_channel, v_state, 'import', v_method, p_job);
          v_result := 'written';
        exception when sqlstate 'P0001' then
          get stacked diagnostics v_hint = pg_exception_hint;
          -- the register's own lock (consents_prepare) agrees with the check above; never lifted
          if v_hint in ('consent:optout_locked', 'consent:erasure_block', 'consent:address_blocked', 'consent:blocklisted') then
            v_result := 'locked';
          else
            raise;
          end if;
        end;
      end if;
    end if;
    if v_result = 'locked' then
      v_locked := v_locked + 1;
    end if;
    v_out := v_out || to_jsonb(v_result);
  end loop;
  -- CNS-06 answer 3: kept on the job (server only), so the import's report shows it after a reload too
  if v_locked > 0 then
    update public.import_jobs j set consents_locked = j.consents_locked + v_locked
     where j.organization_id = p_org and j.id = p_job;
  end if;
  return v_out;
end;
$$;
revoke all on function public.import_record_consents(uuid, uuid, jsonb) from public, anon;
grant execute on function public.import_record_consents(uuid, uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';
