-- =============================================================================
-- 020115 Blocked time in the calendar (GAP-07, the first half)
-- =============================================================================
-- "זמן תפוס מחוץ למערכת. דף קביעת התור יקבע תורים כפולים עד הסנכרון עם Google (גל 4)" — the small version:
-- "חסימת זמן ביומן, וקריאה של יומן חיצוני מקישור ICS". This migration builds the blocking; reading an external
-- ICS link waits for an owner decision (the server would fetch an outside address on a schedule).
--
-- * A block is a meeting row with meetings.is_block = true (set on insert only; column grant): the person's time is
--   taken, so everything that already reads meetings treats it as busy with no change: the booking page's free times
--   (app.booking_slots, the organizer's meetings and participations), the conflict warnings (public.meeting_busy) and
--   the personal calendar feed. The same rights as a meeting (organizer, creator, managers, admins).
-- * Its shape (constraint meetings_block_shape): no lead, contact, company or deal, no business meeting type, no
--   series, no reminder, no buffers, and only planned or cancelled (never held or no-show), so it is never a meeting in
--   the meeting reports or the goals.
-- * public.report_meetings (020050) leaves blocks out (the not-updated and upcoming counts would grow otherwise).
-- No delete, no drop statement. Safe to run twice.

alter table public.meetings add column if not exists is_block boolean not null default false;

alter table public.meetings
  drop constraint if exists meetings_block_shape,
  add constraint meetings_block_shape check (
    not is_block
    or (lead_id is null and contact_id is null and company_id is null and deal_id is null
        and meeting_type_id is null and series_id is null and reminder_minutes is null
        and buffer_before_minutes = 0 and buffer_after_minutes = 0
        and status in ('planned', 'cancelled')));

-- set when the row is made, never changed: a meeting does not become a block, nor a block a meeting
grant insert (is_block) on public.meetings to authenticated;

-- ----------------------------------------------------------------------------
-- The meeting report without blocks (020050's body, one line added)
-- ----------------------------------------------------------------------------
create or replace function public.report_meetings(
  p_org uuid, p_from timestamptz, p_to timestamptz, p_owner uuid default null)
returns jsonb
language sql stable
set search_path = ''
as $$
  with consts as (
    -- named constants of the definitions above (the window is derived from led_window_days)
    select 90 as led_window_days, 5 as no_show_min
  ),
  m as (
    select mt.id, mt.owner_id, mt.status, mt.starts_at, mt.ends_at, mt.deal_id, mt.lead_id, mt.contact_id
      from public.meetings mt
     where mt.organization_id = p_org
       and mt.starts_at >= p_from and mt.starts_at < p_to
       and (p_owner is null or mt.owner_id = p_owner)
       -- GAP-07: blocked time is not a meeting
       and not mt.is_block
  ),
  pick as (
    -- held meetings and the step that applies to each
    select m.id as meeting_id, m.owner_id, m.starts_at, m.contact_id,
           coalesce(m.deal_id, l.converted_deal_id) as fixed_deal_id
      from m
      left join public.leads l on m.deal_id is null and l.organization_id = p_org and l.id = m.lead_id
     where m.status = 'held'
  ),
  cand as (
    -- steps 1 and 2: the one deal, if it qualifies
    select p.meeting_id, p.owner_id, d.id as deal_id, d.name, d.amount_agorot, d.closed_at, d.owner_id as deal_owner_id
      from pick p
      cross join consts c
      join public.deals d on d.organization_id = p_org and d.id = p.fixed_deal_id
     where d.status = 'won' and d.deleted_at is null
       and d.closed_at >= p.starts_at and d.closed_at <= p.starts_at + make_interval(days => c.led_window_days)
    union all
    -- step 3: the contact's deal created after the meeting started and closed first
    select p.meeting_id, p.owner_id, d.id, d.name, d.amount_agorot, d.closed_at, d.owner_id
      from pick p
      cross join consts c
      cross join lateral (
        select x.id, x.name, x.amount_agorot, x.closed_at, x.owner_id
          from public.deals x
         where x.organization_id = p_org and x.contact_id = p.contact_id
           and x.created_at >= p.starts_at
           and x.status = 'won' and x.deleted_at is null
           and x.closed_at >= p.starts_at and x.closed_at <= p.starts_at + make_interval(days => c.led_window_days)
         order by x.closed_at, x.created_at, x.id
         limit 1) d
     where p.fixed_deal_id is null and p.contact_id is not null
  ),
  led as (select * from cand),
  per_owner as (
    select m.owner_id,
           count(*) as meetings,
           count(*) filter (where m.status = 'held') as held,
           count(*) filter (where m.status = 'no_show') as no_show,
           count(*) filter (where m.status = 'cancelled') as cancelled,
           count(*) filter (where m.status = 'planned' and m.ends_at <= now()) as not_updated,
           count(*) filter (where m.status = 'planned' and m.ends_at > now()) as upcoming
      from m
     group by m.owner_id
  ),
  led_owner as (
    select owner_id, count(distinct meeting_id) as led_meetings, count(distinct deal_id) as won_deals,
           coalesce(sum(amount_agorot) filter (where first_for_owner), 0) as won_amount
      from (select l.*, row_number() over (partition by l.owner_id, l.deal_id order by l.meeting_id) = 1 as first_for_owner from led l) x
     group by owner_id
  )
  select jsonb_build_object(
    'led_window_days', (select led_window_days from consts),
    'no_show_min', (select no_show_min from consts),
    -- each deal once, whoever organized its meetings
    'totals', (
      select jsonb_build_object(
        'meetings', count(*),
        'held', count(*) filter (where m.status = 'held'),
        'no_show', count(*) filter (where m.status = 'no_show'),
        'no_show_rate', case when count(*) filter (where m.status in ('held', 'no_show')) >= (select no_show_min from consts)
                             then round(100.0 * count(*) filter (where m.status = 'no_show')
                                        / count(*) filter (where m.status in ('held', 'no_show')), 1) end,
        'cancelled', count(*) filter (where m.status = 'cancelled'),
        'not_updated', count(*) filter (where m.status = 'planned' and m.ends_at <= now()),
        'upcoming', count(*) filter (where m.status = 'planned' and m.ends_at > now()),
        'led_meetings', (select count(distinct meeting_id) from led),
        'won_deals', (select count(distinct deal_id) from led),
        'won_amount', coalesce((select sum(x.amount_agorot) from (select distinct deal_id, amount_agorot from led) x), 0))
        from m),
    'by_owner', coalesce((
      select jsonb_agg(r order by r.meetings desc, r.owner_id nulls last) from (
        select p.owner_id, p.meetings, p.held, p.no_show,
               case when p.held + p.no_show >= (select no_show_min from consts)
                    then round(100.0 * p.no_show / (p.held + p.no_show), 1) end as no_show_rate,
               p.cancelled, p.not_updated, p.upcoming,
               coalesce(lo.led_meetings, 0) as led_meetings, coalesce(lo.won_deals, 0) as won_deals,
               coalesce(lo.won_amount, 0) as won_amount
          from per_owner p
          left join led_owner lo on lo.owner_id is not distinct from p.owner_id) r), '[]'::jsonb),
    'deals', coalesce((
      select jsonb_agg(r order by r.closed_at desc, r.deal_id) from (
        select l.deal_id, min(l.name) as name, min(l.amount_agorot) as amount, max(l.closed_at) as closed_at,
               (array_agg(l.deal_owner_id))[1] as owner_id, count(distinct l.meeting_id) as meetings
          from led l
         group by l.deal_id
         order by max(l.closed_at) desc, l.deal_id
         limit 200) r), '[]'::jsonb));
$$;
revoke all on function public.report_meetings(uuid, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.report_meetings(uuid, timestamptz, timestamptz, uuid) to authenticated;


notify pgrst, 'reload schema';
