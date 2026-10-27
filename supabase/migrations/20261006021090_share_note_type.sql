-- =============================================================================
-- WAB-06 (owner's answer of 27 October 2026, (ב)): a note saved from a share is its own type, 'share_note'
-- =============================================================================
-- What the share flow saves (src/features/share/: the text and image shared from the phone, on a new lead or contact or on
-- a record picked with "הערה לרשומה") is a timeline entry of type 'share_note' ("הערת שיתוף") whose first line is
-- "שותף מהטלפון", written by the person (created_by = the session's user). It is a person's note on the timeline, but it is
-- NOT contact with the customer, so a lead saved from a share still waits for an answer. Ordinary notes do not change.
--
-- * Contact: 'share_note' is not in app.contact_types() (unchanged), so every contact rule leaves it out with no change:
--   last/first contact (app.stamp_last_contact), activation (app.mark_org_activation), waiting leads (SQL rules and
--   src/features/leads/waiting.ts CONTACT_TYPES), response time and its breakdown, the response target job
--   (app.check_lead_responses), money waiting's unhandled leads (public.report_money_waiting of 20261006021089, which
--   asks app.contact_types()), retention's contact rule
--   (app.lead_retention_candidates), goal progress, the activity report, the funnel, deputy reads, open load and the
--   record summary's "last touch". The lead score's timeline rules (app.lead_score_activity_types) do not list it either.
-- * Activity (lead's decision: like 'import_note', neither contact nor activity): app.scheduled_no_activity,
--   app.automation_run_facts and app.automation_event_still_holds (bodies of 20261006021050) skip it beside
--   'automation_note' and 'import_note'; a deal's "last activity" (app.deal_attention_rows and
--   public.report_pipeline_cleanup, bodies of 20261006021050, kept in step) does not count it.
-- * A person's note otherwise: global search finds it (app.search_notes, body of 20261006021070); its author attaches
--   files to it as REC-07 note files (app.files_links_check, body of 20261006020645); mentions in it notify
--   (app.notify_mentions, body of 20261006009900) and followers are told "הוסיף/ה הערת שיתוף"
--   (app.notify_followers_of_entry, body of 20261006019900); those nine bodies are in 20261006021091_share_note_rules.sql.
--   The author edits or deletes it for 24 hours, owners and admins
--   always, a team manager pins it (activities_update / activities_delete, as of 20261006006700, one type wider).
-- * Who writes it: a person whose business is writable and who may EDIT every record the entry is on
--   (app.can_edit_activity_subjects: live, readable, app.can_edit_record), through the activities_insert policy (as of
--   20261006007200, the contact types unchanged). Trigger activities_zz_share_note (every writer, insert only) asks for an
--   author and the first line "שותף מהטלפון" (hint share_note:mark), so the type is never a disguised entry of another
--   kind; it cannot be private (activities_private_note) or carry a type of the business's list (activities_activity_type).
--   The log form never offers it.
-- * Existing notes the share flow saved as 'note' before this migration stay as they are (no bulk rewrite).
-- Every statement is safe to run twice. Nothing is removed.

-- may the caller edit every record an entry is on (live, readable under the caller's own select policies, and
-- app.can_edit_record). SECURITY INVOKER on purpose, like app.can_read_every_activity_subject.
create or replace function app.can_edit_activity_subjects(p_org uuid, p_lead uuid, p_contact uuid, p_company uuid, p_deal uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select num_nonnulls(p_lead, p_contact, p_company, p_deal) >= 1
     and (p_lead is null or exists (select 1 from public.leads l
                                     where l.organization_id = p_org and l.id = p_lead and l.deleted_at is null
                                       and app.can_edit_record(p_org, l.owner_id, l.team_id)))
     and (p_contact is null or exists (select 1 from public.contacts c
                                        where c.organization_id = p_org and c.id = p_contact and c.deleted_at is null
                                          and app.can_edit_record(p_org, c.owner_id, c.team_id)))
     and (p_company is null or exists (select 1 from public.companies co
                                        where co.organization_id = p_org and co.id = p_company and co.deleted_at is null
                                          and app.can_edit_record(p_org, co.owner_id, co.team_id)))
     and (p_deal is null or exists (select 1 from public.deals d
                                     where d.organization_id = p_org and d.id = p_deal and d.deleted_at is null
                                       and app.can_edit_record(p_org, d.owner_id, d.team_id)));
$$;

revoke all on function app.can_edit_activity_subjects(uuid, uuid, uuid, uuid, uuid) from public, anon;
grant execute on function app.can_edit_activity_subjects(uuid, uuid, uuid, uuid, uuid) to authenticated;

-- altered in place: the policies exist since 0004; everything they checked before stays
alter policy activities_insert on public.activities
  with check (app.can_write(organization_id)
              and (type = any (app.contact_types())
                   or (type = 'share_note'
                       and app.can_edit_activity_subjects(organization_id, lead_id, contact_id, company_id, deal_id)))
              and app.can_read_every_activity_subject(lead_id, contact_id, company_id, deal_id));

alter policy activities_update on public.activities
  using (app.can_write(organization_id)
         and (not is_private
              or created_by = (select auth.uid())
              or app.is_admin(organization_id))
         and (app.is_admin(organization_id)
              or (type in ('note', 'call', 'meeting', 'email', 'whatsapp', 'sms', 'share_note')
                  and (created_by = (select auth.uid())
                       or app.manages_activity_subject(organization_id, lead_id, contact_id, company_id, deal_id)))))
  with check (app.can_write(organization_id));

alter policy activities_delete on public.activities
  using (app.can_write(organization_id)
         and (not is_private
              or created_by = (select auth.uid())
              or app.is_admin(organization_id))
         and (app.is_admin(organization_id)
              or (created_by = (select auth.uid())
                  and created_at > now() - interval '24 hours'
                  and type in ('note', 'call', 'meeting', 'email', 'whatsapp', 'sms', 'share_note'))));

-- a share note has an author and starts with the share mark (named to run after activities_touch, which sets the author)
create or replace function app.activities_share_note_check() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.created_by is null then
    raise exception 'a share note has an author' using errcode = 'P0001', hint = 'share_note:mark';
  end if;
  if new.body is null or split_part(new.body, chr(10), 1) <> 'שותף מהטלפון' then
    raise exception 'a share note starts with the share mark' using errcode = 'P0001', hint = 'share_note:mark';
  end if;
  return new;
end;
$$;

revoke all on function app.activities_share_note_check() from public, anon, authenticated;

create or replace trigger activities_zz_share_note before insert on public.activities
  for each row when (new.type = 'share_note') execute function app.activities_share_note_check();

