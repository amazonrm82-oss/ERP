-- =============================================================================
-- Last contact updates itself from the timeline (LEAD-02)
-- =============================================================================
-- * "Contact with the customer" is the same as in the reports and the waiting
--   leads screen: an entry a person logged (created_by set) of one of
--   app.contact_types() (note, call, meeting, email, WhatsApp, SMS).
-- * Trigger activities_last_contact (after insert, or an update of occurred_at,
--   type, created_by, lead_id or contact_id) moves last_contacted_at of the lead
--   and/or the contact the entry belongs to forward to the entry's time. It never
--   moves it back: editing or deleting an entry leaves it as it was. An entry
--   dated in the future (a planned meeting) is not contact yet; a time a few
--   seconds ahead of the server's clock counts as now.
-- * Companies have no last_contacted_at column; nothing changes for them.
-- * security definer, so it works for browser and server writes alike (a user
--   who may log a note on a lead may not always update the lead). It touches only
--   the one lead / contact the entry points to, in the entry's organization.
-- * The stamp is not an edit of the record:
--   - app.automation_running is on during the stamp, so the lead.updated /
--     contact.updated event is written already handled and starts no automation
--     (as in transfer_records); the previous value is put back afterwards.
--   - app.contact_stamp is on during the stamp; trigger *_touch_contact_stamp,
--     which runs after *_touch, keeps updated_at / updated_by as they were and
--     refuses any other column change while the flag is on.
--   - The audit log still records the change of last_contacted_at (audit_row is
--     shared and unchanged here).
-- * No backfill of existing rows here (a bulk rewrite needs the owner's go-ahead).
-- Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- The stamp
-- ----------------------------------------------------------------------------
create or replace function app.stamp_last_contact() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_at timestamptz;
  v_automation text;
begin
  if new.created_by is null
     or not (new.type = any (app.contact_types()))
     or (new.lead_id is null and new.contact_id is null)
     -- planned, not done yet
     or new.occurred_at > now() + interval '5 minutes' then
    return null;
  end if;
  v_at := least(new.occurred_at, now());

  v_automation := current_setting('app.automation_running', true);
  perform set_config('app.automation_running', 'on', true);
  perform set_config('app.contact_stamp', 'on', true);

  if new.lead_id is not null then
    update public.leads l
       set last_contacted_at = v_at
     where l.organization_id = new.organization_id
       and l.id = new.lead_id
       and (l.last_contacted_at is null or l.last_contacted_at < v_at);
  end if;
  if new.contact_id is not null then
    update public.contacts c
       set last_contacted_at = v_at
     where c.organization_id = new.organization_id
       and c.id = new.contact_id
       and (c.last_contacted_at is null or c.last_contacted_at < v_at);
  end if;

  perform set_config('app.contact_stamp', 'off', true);
  perform set_config('app.automation_running', coalesce(v_automation, ''), true);
  return null;
end;
$$;
revoke all on function app.stamp_last_contact() from public, anon, authenticated;

create or replace trigger activities_last_contact
  after insert or update of occurred_at, type, created_by, lead_id, contact_id on public.activities
  for each row execute function app.stamp_last_contact();

-- ----------------------------------------------------------------------------
-- The stamp is not an edit: keep updated_at / updated_by, allow nothing else
-- ----------------------------------------------------------------------------
-- The trigger names sort after *_touch, so these run after app.touch_row().
create or replace function app.keep_touch_on_contact_stamp() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  -- what the stamp may change: the column itself, and what other triggers recompute
  v_free text[] := array['last_contacted_at', 'updated_at', 'updated_by', 'phone_e164'];
begin
  if current_setting('app.contact_stamp', true) = 'on' then
    -- contacts.full_name is generated: still empty in a before trigger
    if tg_table_name = 'contacts' then
      v_free := v_free || 'full_name'::text;
    end if;
    if (to_jsonb(new) - v_free) is distinct from (to_jsonb(old) - v_free) then
      raise exception 'the last contact stamp changes nothing else' using errcode = '42501';
    end if;
    new.updated_at := old.updated_at;
    new.updated_by := old.updated_by;
  end if;
  return new;
end;
$$;
revoke all on function app.keep_touch_on_contact_stamp() from public, anon, authenticated;

create or replace trigger leads_touch_contact_stamp before update on public.leads
  for each row execute function app.keep_touch_on_contact_stamp();
create or replace trigger contacts_touch_contact_stamp before update on public.contacts
  for each row execute function app.keep_touch_on_contact_stamp();

-- ----------------------------------------------------------------------------
-- Sorting and "no contact for X days" on the lists
-- ----------------------------------------------------------------------------
create index if not exists leads_last_contacted_idx on public.leads (organization_id, last_contacted_at) where deleted_at is null;
create index if not exists contacts_last_contacted_idx on public.contacts (organization_id, last_contacted_at) where deleted_at is null;
