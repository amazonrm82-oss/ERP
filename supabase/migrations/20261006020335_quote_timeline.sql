-- QUO-16, the timeline part (owner, 18 October 2026, answer 15).
--
-- When a quote is sent, accepted or declined, one entry goes on the timeline of its deal and its contact (one row carrying
-- both ids, so it shows on each; the deal alone when there is no contact; whichever is still there after a purge; none when
-- neither is). The entry names the quote's number only; the screen adds the quote's title as it reads now (so a privacy
-- erasure, which resets the title, leaves nothing behind here). No amounts.
--
-- * "נשלחה" is a person's action and counts as contact with the customer: the entry is a 'note' by the sender, which the
--   existing contact rule (app.stamp_last_contact, app.contact_types) stamps like any other note. Neither is changed here.
--   metadata.kind = 'quote_sent' tells the screen it is not a typed note. With no person (no server path sends today)
--   it is a 'system' entry and counts as nothing.
-- * "אושרה" and "נדחתה" are 'system' entries with no author (kinds quote_accepted, quote_rejected); nothing sets those
--   statuses yet (QUO-09 will), so this trigger is ready for it.
--
-- A quote entry is history (lead, 18 October 2026): a person can neither write one nor change or delete it, owners and
-- admins included, and the 24-hour edit window does not apply. The browser may insert activities and update their
-- metadata (column grants of 0004), so the guard is a trigger, not a grant: app.activities_quote_entry_guard (security
-- invoker, because it tells a person, current_user = 'authenticated', from the server) refuses, with hint
-- 'activity:quote_entry', a person's insert of a quote_* kind, an update that sets one or touches such an entry, and a
-- delete of one. Server paths are not people: this trigger's own insert (definer), a purge (app.purge_links and the
-- foreign keys' set null), a merge and a privacy erasure (definer functions) are unchanged.
--
-- The timeline trigger is security definer because it writes the timeline for the person whose update changed the status; inside it
-- current_user is the owner, so the mention and follower triggers, which act on a person's own writes only, stay quiet.

create or replace function app.quote_timeline_entry() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_person uuid := auth.uid();
  v_type text;
begin
  if new.status is not distinct from old.status or (new.deal_id is null and new.contact_id is null) then
    return null;
  end if;
  v_kind := case new.status when 'sent' then 'quote_sent' when 'accepted' then 'quote_accepted' when 'rejected' then 'quote_rejected' end;
  if v_kind is null then
    return null;
  end if;
  v_type := case when v_kind = 'quote_sent' and v_person is not null then 'note' else 'system' end;

  insert into public.activities (organization_id, type, deal_id, contact_id, body, metadata, created_by)
  values (new.organization_id, v_type, new.deal_id, new.contact_id,
          'הצעת מחיר' || coalesce(' ' || new.number_display, '')
            || case v_kind when 'quote_sent' then ' נשלחה' when 'quote_accepted' then ' אושרה' else ' נדחתה' end,
          jsonb_build_object('kind', v_kind, 'quote_id', new.id, 'number', new.number_display),
          case when v_type = 'note' then v_person end);
  return null;
end;
$$;
revoke all on function app.quote_timeline_entry() from public, anon, authenticated, service_role;

create or replace trigger quotes_timeline after update of status on public.quotes
  for each row execute function app.quote_timeline_entry();

create or replace function app.activities_quote_entry_guard() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    if coalesce(old.metadata ->> 'kind', '') like 'quote\_%' then
      raise exception 'a quote entry on the timeline is history' using errcode = '42501', hint = 'activity:quote_entry';
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    if coalesce(new.metadata ->> 'kind', '') like 'quote\_%' then
      raise exception 'only the server writes a quote entry' using errcode = '42501', hint = 'activity:quote_entry';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
revoke all on function app.activities_quote_entry_guard() from public, anon, authenticated, service_role;

create or replace trigger activities_quote_entry_guard before insert or update or delete on public.activities
  for each row execute function app.activities_quote_entry_guard();
