-- =============================================================================
-- Private notes (GAP-05): "me and the organization's admins"
-- =============================================================================
-- * activities.is_private (default false). Only a note can be private
--   (check activities_private_note); calls, meetings, messages and system
--   entries never are.
-- * Who sees a private note: its author and the owners/admins of the
--   organization (app.is_admin), nobody else: not a team manager, not a member
--   who sees the record, not a viewer, not platform support in a support
--   session (app.role_in() gives them 'viewer'). A private note whose author
--   was removed (created_by null) is seen by owners/admins only.
--   This is in the policies themselves (select, update, delete), so every
--   reader that runs with the caller's rights hides it too: the timeline, the
--   record summary (public.record_summary, security invoker), global search
--   (public.search_records, security invoker), the reports (security invoker)
--   and the full export (user's session). The audit log is for admins only.
-- * Update and delete carry the same check, so a team manager cannot pin a
--   private note of their team (REC-01) and nobody reaches one blind, with an
--   UPDATE or DELETE that has no WHERE clause.
-- * Setting it: on insert by whoever writes the note (the insert grant covers
--   every column; created_by is the session's user, touch_row). Changing it later
--   is an edit like changing the text (column grant is_private, trigger
--   activities_edit_window unchanged): the author within 24 hours, an
--   owner/admin at any time, a team manager never ('note:pin_only'). After 24
--   hours the author can no longer hide a note from the team, just as they can no
--   longer delete it. The audit log records the change (app.audit_activity).
-- * Last contact (LEAD-02): a private note does not move last_contacted_at,
--   which everyone who sees the record sees; otherwise the stamp would tell them
--   that something was written. When a note is made public it counts from then
--   (the stamp still only moves forward).
-- Every statement is safe to run twice.

alter table public.activities add column if not exists is_private boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.activities'::regclass and conname = 'activities_private_note'
  ) then
    alter table public.activities
      add constraint activities_private_note check (not is_private or type = 'note');
  end if;
end;
$$;

grant update (is_private) on public.activities to authenticated;

-- ----------------------------------------------------------------------------
-- Policies: alter, not drop and create (they exist since 0004, changed in 0052,
-- 0059 and 0060); everything they checked before stays
-- ----------------------------------------------------------------------------
alter policy activities_select on public.activities
  using (app.is_member(organization_id)
         and app.can_read_activity_subject(lead_id, contact_id, company_id, deal_id)
         and (not is_private
              or created_by = (select auth.uid())
              or app.is_admin(organization_id)));

alter policy activities_update on public.activities
  using (app.can_write(organization_id)
         and (not is_private
              or created_by = (select auth.uid())
              or app.is_admin(organization_id))
         and (app.is_admin(organization_id)
              or (type in ('note', 'call', 'meeting', 'email', 'whatsapp', 'sms')
                  and (created_by = (select auth.uid())
                       or app.manages_activity_subject(organization_id, lead_id, contact_id, company_id, deal_id)))))
  with check (app.can_write(organization_id));

-- the privacy check below changes nothing today (only the author and admins delete, and both
-- see the note); it is here so that a wider delete rule later still cannot reach a private note
alter policy activities_delete on public.activities
  using (app.can_write(organization_id)
         and (not is_private
              or created_by = (select auth.uid())
              or app.is_admin(organization_id))
         and (app.is_admin(organization_id)
              or (created_by = (select auth.uid())
                  and created_at > now() - interval '24 hours'
                  and type in ('note', 'call', 'meeting', 'email', 'whatsapp', 'sms'))));

-- ----------------------------------------------------------------------------
-- Last contact: a private note is not counted (as in 0057, plus is_private)
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
     -- GAP-05: only its author and the admins know it exists
     or new.is_private
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

-- is_private added: a note made public counts from then
create or replace trigger activities_last_contact
  after insert or update of occurred_at, type, created_by, lead_id, contact_id, is_private on public.activities
  for each row execute function app.stamp_last_contact();

-- ----------------------------------------------------------------------------
-- Audit log: a change of privacy is logged like a change of the text
-- (as in 0052, plus is_private)
-- ----------------------------------------------------------------------------
create or replace function app.audit_activity() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old jsonb := to_jsonb(old);
  v_new jsonb;
  v_changes jsonb := '{}'::jsonb;
  v_key text;
begin
  if tg_op = 'DELETE' then
    if not app.org_exists(old.organization_id) then
      return null;
    end if;
    v_changes := v_old - 'updated_at';
  else
    v_new := to_jsonb(new);
    foreach v_key in array array['body', 'occurred_at', 'metadata', 'is_private'] loop
      if (v_new -> v_key) is distinct from (v_old -> v_key) then
        v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_object('old', v_old -> v_key, 'new', v_new -> v_key));
      end if;
    end loop;
    if v_changes = '{}'::jsonb then
      return null;
    end if;
    -- what the entry belongs to, so a privacy erasure of that record finds this entry too
    v_changes := v_changes || jsonb_strip_nulls(jsonb_build_object(
      'type', old.type, 'lead_id', old.lead_id, 'contact_id', old.contact_id,
      'company_id', old.company_id, 'deal_id', old.deal_id));
  end if;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (old.organization_id, auth.uid(), lower(tg_op), 'activities', old.id, v_changes);
  return null;
end;
$$;
revoke all on function app.audit_activity() from public, anon, authenticated;

create or replace trigger activities_audit_update after update on public.activities
  for each row
  when (current_user = 'authenticated'
        and (old.body is distinct from new.body
             or old.occurred_at is distinct from new.occurred_at
             or old.metadata is distinct from new.metadata
             or old.is_private is distinct from new.is_private))
  execute function app.audit_activity();
