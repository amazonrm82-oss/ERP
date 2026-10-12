-- =============================================================================
-- One-time backfill of last_contacted_at from the timeline (LEAD-02)
-- =============================================================================
-- Since 0057 trigger activities_last_contact (app.stamp_last_contact(), latest
-- version in 0067) keeps last_contacted_at of leads and contacts up to date, but
-- only for entries logged after it existed. The owner approved on 12 October 2026
-- a one-time fill of the records that still have no value, under these rules:
--
-- * Only leads / contacts whose last_contacted_at is null. A value already there
--   is never touched, so the second run finds nothing to do.
-- * "Contact" is exactly what app.stamp_last_contact() counts: an entry with
--   created_by set, type = any (app.contact_types()), not is_private, linked to
--   the record (lead_id / contact_id, same organization), and occurred_at not
--   more than 5 minutes ahead of now(). The value is least(occurred_at, now())
--   of the latest such entry, which is what the live stamp ends with when those
--   entries are logged now (it only ever moves forward). Records in the recycle
--   bin are filled too, as the live stamp does.
--   An entry that was dated in the future when it was logged and whose time has
--   passed since does count here (the live stamp checks the time once, when the
--   entry is written).
-- * first_contacted_at is not touched: the live stamp does not set it either.
-- * Same mechanism as the live stamp (0057), so it is not an edit of the record:
--   - app.contact_stamp = on: trigger *_touch_contact_stamp keeps updated_at /
--     updated_by as they were and refuses any other column change.
--   - app.automation_running = on: emit_event writes the lead.updated /
--     contact.updated event with origin 'automation', and outbox_skip_internal
--     stores it already processed, so no automation starts.
--   - Both settings are put back to their previous values afterwards.
--   Other triggers that fire on this update: touch_row (its updated_at /
--   updated_by are put back by the stamp guard), normalize_contact_fields
--   (recomputes phone_e164 and email from unchanged input, so they stay as they
--   are), and audit_row, which logs the change of last_contacted_at with no actor,
--   as it does for the live stamp. Triggers bound to other columns (owner_id ->
--   notify_assignment, custom_fields, status_id, deleted_at, converted_at,
--   import_job_id, type_id) do not fire. No notification is written.
-- * Only updates; the counts are reported with RAISE NOTICE.
-- Safe to run twice.

do $$
declare
  v_automation text := current_setting('app.automation_running', true);
  v_stamp text := current_setting('app.contact_stamp', true);
  v_leads integer;
  v_contacts integer;
begin
  perform set_config('app.automation_running', 'on', true);
  perform set_config('app.contact_stamp', 'on', true);

  update public.leads l
     set last_contacted_at = x.v_at
    from (
      select a.organization_id, a.lead_id, max(least(a.occurred_at, now())) as v_at
        from public.activities a
       where a.lead_id is not null
         and a.created_by is not null
         and a.type = any (app.contact_types())
         and a.is_private is not true
         and a.occurred_at <= now() + interval '5 minutes'
       group by a.organization_id, a.lead_id
    ) x
   where l.organization_id = x.organization_id
     and l.id = x.lead_id
     and l.last_contacted_at is null;
  get diagnostics v_leads = row_count;

  update public.contacts c
     set last_contacted_at = x.v_at
    from (
      select a.organization_id, a.contact_id, max(least(a.occurred_at, now())) as v_at
        from public.activities a
       where a.contact_id is not null
         and a.created_by is not null
         and a.type = any (app.contact_types())
         and a.is_private is not true
         and a.occurred_at <= now() + interval '5 minutes'
       group by a.organization_id, a.contact_id
    ) x
   where c.organization_id = x.organization_id
     and c.id = x.contact_id
     and c.last_contacted_at is null;
  get diagnostics v_contacts = row_count;

  perform set_config('app.contact_stamp', coalesce(v_stamp, ''), true);
  perform set_config('app.automation_running', coalesce(v_automation, ''), true);

  raise notice 'last_contacted_at backfill: leads filled %, contacts filled %', v_leads, v_contacts;
  raise notice 'last_contacted_at backfill: still without contact: leads % (% outside the recycle bin), contacts % (% outside the recycle bin)',
    (select count(*) from public.leads where last_contacted_at is null),
    (select count(*) from public.leads where last_contacted_at is null and deleted_at is null),
    (select count(*) from public.contacts where last_contacted_at is null),
    (select count(*) from public.contacts where last_contacted_at is null and deleted_at is null);
end;
$$;
