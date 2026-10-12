-- =============================================================================
-- A meeting that took place counts as contact with the customer (RVW-1)
-- =============================================================================
-- Since CAL-01 a meeting is its own record (public.meetings), and marking it
-- "held" changed only that row. Everything that measures contact reads the
-- timeline (public.activities): last_contacted_at (app.stamp_last_contact),
-- the waiting leads screen, report_activity, the "no activity for X days"
-- automation (app.scheduled_no_activity), record_summary's last touch and the
-- timeline's "meetings" tab. One definition, in one place:
--
-- * When a meeting becomes "held" (inserted as held, or its status changes to
--   held), trigger meetings_held_activity writes ONE timeline entry of type
--   'meeting' on the records the meeting is linked to (lead, contact, company,
--   deal, as they are at that moment). Every measure above then sees it with no
--   change of its own.
--   - occurred_at: the meeting's start; a meeting marked held before its start
--     time is dated now (it took place, so it is not in the future).
--   - created_by: the meeting's organizer (meetings.owner_id, a member's user
--     id), who gets the credit in report_activity and may edit or remove the
--     entry like one they logged. Only when the meeting has no organizer is it
--     whoever marked it held (auth.uid()); a server write with no user then
--     leaves it null, and like every entry with no person behind it, it does
--     not count as contact. A participant who marks it held but cannot see the
--     linked record is therefore not the author and cannot reach the entry.
--     touch_row stamps created_by = auth.uid() on every insert, so the author
--     travels in the transaction setting app.meeting_entry_author, which only
--     trigger activities_verify_meeting_entry reads, and only for a server
--     write (current_user not a client role); the setting is cleared right
--     after the insert.
--   - body: the meeting's title, and its outcome (if any) as a second paragraph.
--   - metadata: {"meeting_id": <id>}. The unique index
--     activities_meeting_once_idx allows one such entry per meeting, so
--     held -> planned -> held again writes nothing new (on conflict do nothing).
--   - The meeting_id key is the server's: trigger activities_verify_meeting_entry
--     (security invoker, it reads current_user) refuses a browser insert that
--     carries it and a browser update that adds, changes or removes it (42501,
--     hint 'meeting:entry'). Otherwise a writer could pre-empt the real entry
--     with a forged one, or remove the key and get a second entry.
--   - Meetings already held before this migration get no entry: there is no
--     backfill (that would be a bulk insert, which needs the owner's go-ahead).
--   - Un-marking (held -> planned / cancelled / no_show), editing the meeting,
--     changing its links or removing it later leaves the entry as it is: it is
--     a timeline entry like any other (its author may edit or remove it for 24
--     hours, an admin at any time). Last contact only ever moves forward.
-- * Visibility: a meeting with no linked record (an internal meeting) writes
--   nothing. Otherwise the entry is read through activities_select (whoever may
--   read any linked record); each of those people may also read the meeting
--   itself (meetings_select: app.meeting_subject_ok on any linked record), so the
--   entry shows nothing about a meeting its reader could not already see. A link
--   was set by someone allowed to set it (meetings_check_links).
-- * Automations: activities have no emit_event trigger, so the entry starts no
--   automation; the last-contact stamp it causes runs with
--   app.automation_running on, exactly as for a meeting logged by hand.
-- * security definer, so a participant who may mark the meeting held but not
--   write on the linked record still gets the entry written; it touches nothing
--   but the one new entry. search_path pinned; no client may call it.
--
-- The next step of a deal and of a customer card (follow-up to CAL-01 / DEAL-02 /
-- REC-10): a planned meeting that has not ended yet counts like an open task.
-- * report_stuck_deals: new column next_meeting_at (the nearest planned meeting
--   of the deal); no_next_step is true only when there is neither an open task
--   nor such a meeting. Still security invoker: RLS decides.
-- * record_summary: new key next_meeting {id, title, starts_at} for the contact
--   (or the company and its live contacts). Still security invoker.
-- Both are redefined with create or replace; everything else in them is as it was.
--
-- Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- One entry per meeting
-- ----------------------------------------------------------------------------
create unique index if not exists activities_meeting_once_idx
  on public.activities (organization_id, (metadata ->> 'meeting_id'))
  where type = 'meeting' and metadata ? 'meeting_id';

-- ----------------------------------------------------------------------------
-- The meeting_id key: set by the server only; and the entry's author
-- ----------------------------------------------------------------------------
-- SECURITY INVOKER on purpose: current_user tells a browser write from a server one.
-- The name sorts after activities_touch, so it runs after touch_row has stamped created_by.
create or replace function app.activities_verify_meeting_entry() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_author text;
begin
  if current_user in ('authenticated', 'anon') then
    if (tg_op = 'INSERT' and new.metadata ? 'meeting_id')
       or (tg_op = 'UPDATE' and (new.metadata -> 'meeting_id') is distinct from (old.metadata -> 'meeting_id')) then
      raise exception 'meeting entry link is set by the server' using errcode = '42501', hint = 'meeting:entry';
    end if;
    return new;
  end if;
  if tg_op = 'INSERT' and new.metadata ? 'meeting_id' then
    v_author := nullif(current_setting('app.meeting_entry_author', true), '');
    if v_author is not null then
      new.created_by := v_author::uuid;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.activities_verify_meeting_entry() from public, anon, authenticated;

create or replace trigger activities_verify_meeting_entry
  before insert or update of metadata on public.activities
  for each row execute function app.activities_verify_meeting_entry();

-- ----------------------------------------------------------------------------
-- The entry
-- ----------------------------------------------------------------------------
create or replace function app.meeting_held_activity() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.status <> 'held' or (tg_op = 'UPDATE' and old.status = 'held') then
    return null;
  end if;
  -- an internal meeting is nobody's contact, and must not show up on any timeline
  if num_nonnulls(new.lead_id, new.contact_id, new.company_id, new.deal_id) = 0 then
    return null;
  end if;

  -- the organizer is the author (see the header); read by activities_verify_meeting_entry
  perform set_config('app.meeting_entry_author', coalesce(coalesce(new.owner_id, auth.uid())::text, ''), true);
  insert into public.activities (
    organization_id, type, body, occurred_at, lead_id, contact_id, company_id, deal_id, metadata, created_by)
  values (
    new.organization_id, 'meeting',
    btrim(new.title) || coalesce(E'\n\n' || nullif(btrim(new.outcome), ''), ''),
    least(new.starts_at, now()),
    new.lead_id, new.contact_id, new.company_id, new.deal_id,
    jsonb_build_object('meeting_id', new.id),
    auth.uid())
  on conflict (organization_id, (metadata ->> 'meeting_id'))
    where type = 'meeting' and metadata ? 'meeting_id'
    do nothing;
  perform set_config('app.meeting_entry_author', '', true);
  return null;
end;
$$;
revoke all on function app.meeting_held_activity() from public, anon, authenticated;

create or replace trigger meetings_held_activity
  after insert or update of status on public.meetings
  for each row
  when (new.status = 'held')
  execute function app.meeting_held_activity();

-- ----------------------------------------------------------------------------
-- Stuck deals: a planned meeting is a next step too (as in 0011, plus meetings)
-- ----------------------------------------------------------------------------
create or replace function public.report_stuck_deals(
  p_org uuid, p_pipeline uuid default null, p_owner uuid default null, p_days integer default 14)
returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(r order by r.idle_days desc, r.amount_agorot desc), '[]'::jsonb)
    from (
      select x.*, (x.idle_days >= x.limit_days) as idle,
             (x.next_task_at is null and x.next_meeting_at is null) as no_next_step
        from (
          select d.id, d.name, d.amount_agorot, d.owner_id, d.pipeline_id, s.name as stage_name,
                 coalesce(s.rot_days, greatest(coalesce(p_days, 14), 1)) as limit_days,
                 floor(extract(epoch from now() - d.stage_entered_at) / 86400)::int as days_in_stage,
                 la.last_at as last_activity_at,
                 floor(extract(epoch from now() - coalesce(la.last_at, d.created_at)) / 86400)::int as idle_days,
                 (select min(coalesce(t.due_at, t.created_at)) from public.tasks t
                   where t.organization_id = d.organization_id and t.deal_id = d.id
                     and t.status = 'open' and t.deleted_at is null) as next_task_at,
                 (select min(m.starts_at) from public.meetings m
                   where m.organization_id = d.organization_id and m.deal_id = d.id
                     and m.status = 'planned' and m.ends_at > now()) as next_meeting_at
            from public.deals d
            join public.stages s on s.organization_id = d.organization_id and s.id = d.stage_id
            left join lateral (
              select max(a.occurred_at) as last_at from public.activities a
               where a.organization_id = d.organization_id and a.deal_id = d.id and a.created_by is not null
            ) la on true
           where d.organization_id = p_org and d.deleted_at is null and d.status = 'open'
             and (p_pipeline is null or d.pipeline_id = p_pipeline)
             and (p_owner is null or d.owner_id = p_owner)
        ) x
       where x.idle_days >= x.limit_days or (x.next_task_at is null and x.next_meeting_at is null)
       order by x.idle_days desc
       limit 200
    ) r;
$$;
revoke all on function public.report_stuck_deals(uuid, uuid, uuid, integer) from public, anon;
grant execute on function public.report_stuck_deals(uuid, uuid, uuid, integer) to authenticated;

-- ----------------------------------------------------------------------------
-- Card summary: the next planned meeting (as in 0056, plus next_meeting)
-- ----------------------------------------------------------------------------
create or replace function public.record_summary(p_org uuid, p_type text, p_id uuid) returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_contacts uuid[];
  v_company uuid;
begin
  if p_type = 'contact' then
    v_contacts := array[p_id];
    v_company := null;
  elsif p_type = 'company' then
    select coalesce(array_agg(c.id), '{}') into v_contacts
      from public.contacts c
     where c.organization_id = p_org and c.company_id = p_id and c.deleted_at is null;
    v_company := p_id;
  else
    raise exception 'record_summary: unknown type %', p_type using errcode = '22023';
  end if;

  return jsonb_build_object(
    'deals', (
      select coalesce(jsonb_agg(jsonb_build_object('status', x.status, 'currency', x.currency, 'count', x.n, 'sum', x.total)
                                order by x.status, x.currency), '[]'::jsonb)
        from (select d.status, d.currency, count(*) as n, sum(d.amount_agorot) as total
                from public.deals d
               where d.organization_id = p_org
                 and d.deleted_at is null
                 and d.status in ('open', 'won')
                 and (d.contact_id = any(v_contacts) or d.company_id = v_company)
               group by d.status, d.currency) x
    ),
    'last_touch', (
      select jsonb_build_object('type', a.type, 'occurred_at', a.occurred_at)
        from public.activities a
       where a.organization_id = p_org
         and a.type in ('note', 'call', 'meeting', 'email', 'whatsapp', 'sms')
         and a.occurred_at <= now()
         and (a.contact_id = any(v_contacts) or a.company_id = v_company)
       order by a.occurred_at desc, a.id desc
       limit 1
    ),
    'next_task', (
      select jsonb_build_object('id', t.id, 'title', t.title, 'task_type', t.task_type, 'due_at', t.due_at)
        from public.tasks t
       where t.organization_id = p_org
         and t.deleted_at is null
         and t.status = 'open'
         and (t.contact_id = any(v_contacts) or t.company_id = v_company)
       order by t.due_at asc nulls last, t.created_at asc, t.id asc
       limit 1
    ),
    'open_tasks', (
      select count(*)
        from public.tasks t
       where t.organization_id = p_org
         and t.deleted_at is null
         and t.status = 'open'
         and (t.contact_id = any(v_contacts) or t.company_id = v_company)
    ),
    'next_meeting', (
      select jsonb_build_object('id', m.id, 'title', m.title, 'starts_at', m.starts_at)
        from public.meetings m
       where m.organization_id = p_org
         and m.status = 'planned'
         and m.ends_at > now()
         and (m.contact_id = any(v_contacts) or m.company_id = v_company)
       order by m.starts_at asc, m.id asc
       limit 1
    )
  );
end;
$$;
revoke all on function public.record_summary(uuid, text, uuid) from public, anon;
grant execute on function public.record_summary(uuid, text, uuid) to authenticated;
