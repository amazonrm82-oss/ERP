-- =============================================================================
-- Conversion carries the lead's followers (follow-up of REC-03)
-- =============================================================================
-- When a lead is converted (public.convert_lead() sets converted_at once), the
-- people who follow the lead (record_followers, REC-03, 0104) now also follow the
-- new contact and, when one was created, the new deal.
-- * Only followers who may read the new record (app.user_can_read_record() with
--   its owner and team, migration 0099); a suspended member is never added.
-- * One row per user and record: a row that already exists is kept
--   (on conflict on record_followers_once do nothing), so nothing is doubled and
--   no duplicate-key error stops the conversion.
-- * The lead's rows stay: the lead is still there, as history.
-- * Adding these rows tells nobody: record_followers has no notification trigger,
--   and the follower triggers fire on later changes of the contact or deal only.
--   What a conversion already announced is unchanged (the lead's status change
--   to "converted" for the lead's followers).
-- * A contact or deal in the recycle bin (deleted_at set) gets no rows.
-- * The company is not carried: it is often an existing one, with followers of
--   its own, and following a lead is not following its company.
-- * No backfill: leads converted before this migration keep their followers on
--   the lead only.
-- Runs as a trigger after converted_at is first set (like
-- leads_convert_custom_fields, 0029), so convert_lead() itself is unchanged.
-- Intended: a merge (public.merge_records(), 0020) that gives a never-converted
-- kept lead the conversion of its duplicate also sets converted_at for the first
-- time, so the kept lead's followers follow the contact and deal it now stands
-- for. Followers of a lead follow what it became, whichever way it got there.
--
-- Meetings: since 0070 (RVW-5) convert_lead() already gives every meeting of the
-- lead the new contact and deal (a link it had is kept, lead_id stays). Nothing
-- to change; tests/db/55 now covers the case without a deal too.
-- Every statement is safe to run twice.

create or replace function app.convert_followers() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_team uuid;
begin
  if old.converted_at is not null or new.converted_at is null then
    return null;
  end if;
  -- most leads have no followers: nothing else to look up
  if not exists (select 1 from public.record_followers f
                  where f.organization_id = new.organization_id and f.lead_id = new.id) then
    return null;
  end if;

  if new.converted_contact_id is not null then
    select c.owner_id, c.team_id into v_owner, v_team
      from public.contacts c
     where c.organization_id = new.organization_id and c.id = new.converted_contact_id
       and c.deleted_at is null;
    if found then
      insert into public.record_followers (organization_id, user_id, contact_id)
      select f.organization_id, f.user_id, new.converted_contact_id
        from public.record_followers f
       where f.organization_id = new.organization_id and f.lead_id = new.id
         and app.user_can_read_record(new.organization_id, f.user_id, v_owner, v_team)
      on conflict on constraint record_followers_once do nothing;
    end if;
  end if;

  if new.converted_deal_id is not null then
    select d.owner_id, d.team_id into v_owner, v_team
      from public.deals d
     where d.organization_id = new.organization_id and d.id = new.converted_deal_id
       and d.deleted_at is null;
    if found then
      insert into public.record_followers (organization_id, user_id, deal_id)
      select f.organization_id, f.user_id, new.converted_deal_id
        from public.record_followers f
       where f.organization_id = new.organization_id and f.lead_id = new.id
         and app.user_can_read_record(new.organization_id, f.user_id, v_owner, v_team)
      on conflict on constraint record_followers_once do nothing;
    end if;
  end if;
  return null;
end;
$$;

revoke all on function app.convert_followers() from public, anon, authenticated;

create or replace trigger leads_convert_followers after update of converted_at on public.leads
  for each row
  when (old.converted_at is null and new.converted_at is not null)
  execute function app.convert_followers();
