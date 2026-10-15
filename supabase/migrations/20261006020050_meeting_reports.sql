-- =============================================================================
-- 0200d Meeting reports (CAL-11): meetings per rep, no-show rate, meetings that led to a deal
-- =============================================================================
-- public.report_meetings(org, from, to, owner): security invoker on purpose, like every
-- report (RLS decides what is counted: a meeting, lead or deal the caller may not read is
-- never counted). The meetings are those that START in [from, to); the app sends the
-- period's bounds as UTC instants (src/features/reports/period.ts). "Per rep" is the
-- organizer only (meetings.owner_id; null = no organizer; owner, 15 October 2026);
-- p_owner narrows to one organizer.
-- Definitions (CAL-11, owner's answers of 15 October 2026):
-- * held / no_show / cancelled: meetings.status ('held', 'no_show' = "הלקוח לא הגיע",
--   'cancelled'); not_updated: still 'planned' though it has ended; upcoming: 'planned'
--   and not ended yet.
-- * no_show_rate: no_show / (held + no_show) in percent, rounded to 0.1; cancelled and
--   planned meetings are left out. null while held + no_show is below no_show_min (5), per
--   organizer and in the totals: too few to mean anything.
-- * led to a deal: a HELD meeting, with ONE deal picked for it in this order:
--   1. the meeting has a deal (meetings.deal_id): that deal;
--   2. else its lead was converted with a deal (leads.converted_deal_id, read with the
--      caller's rights): that deal;
--   3. else its contact (meetings.contact_id): among the contact's deals
--      (deals.contact_id) created at or after the meeting started that qualify below, the
--      one closed first (then the earliest created, then the lowest id).
--   The step is decided by the link that exists; a deal picked at step 1 or 2 that does not
--   qualify (or cannot be read) means "not led": there is no falling through to the next
--   step. A lead the caller cannot read has no conversion deal to offer, so step 3 applies:
--   two readers may then see a different result for the same meeting (kept on purpose).
--   The deal qualifies when it is won (deals.status = 'won'), not in the recycle bin, and
--   closed (closed_at) from the meeting's start up to led_window_days (90) days after it.
--   Each deal is counted once per organizer in by_owner, once in totals, and is listed in
--   `deals` (at most 200, newest close first) with its meetings in the period.
-- Also: public.log_export accepts the report key 'meetings' (020000's body, PRM-01's
-- app.can_export check kept; one more key, nothing else changed).
-- Read only. Safe to run twice.

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

create or replace function public.log_export(
  p_org uuid,
  p_kind text,
  p_report text,
  p_rows integer,
  p_format text default 'csv'
) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_role public.membership_role := app.role_in(p_org);
begin
  if p_kind = 'full' then
    if v_role is distinct from 'owner' then
      raise exception 'the full export is for the owner' using errcode = '42501';
    end if;
  elsif p_kind = 'report' then
    if not app.can_export(p_org) then
      raise exception 'export is for owners, admins, team managers and members with the export permission' using errcode = '42501';
    end if;
    -- the report keys of src/features/reports/definitions.ts; keep the two in step
    if p_report is null or p_report not in ('sources', 'funnel', 'response', 'reps', 'activity', 'forecast', 'lost', 'cycle', 'stuck', 'revenue', 'meetings') then
      raise exception 'invalid export' using errcode = '22023';
    end if;
  else
    raise exception 'invalid export' using errcode = '22023';
  end if;
  if p_rows is null or p_rows < 0 or p_rows > 10000000 then
    raise exception 'invalid export' using errcode = '22023';
  end if;
  -- RPT-02: the file formats of a report export
  if p_format is null or p_format not in ('csv', 'xlsx') then
    raise exception 'invalid export' using errcode = '22023';
  end if;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (
    p_org, auth.uid(), 'export',
    case p_kind when 'full' then 'full_export' else 'reports' end,
    null,
    jsonb_build_object('kind', p_kind, 'rows', p_rows, 'format', case p_kind when 'full' then 'zip' else p_format end)
      || case when p_kind = 'report' then jsonb_build_object('report', p_report) else '{}'::jsonb end
  );
end;
$$;


revoke all on function public.log_export(uuid, text, text, integer, text) from public, anon;
grant execute on function public.log_export(uuid, text, text, integer, text) to authenticated;

notify pgrst, 'reload schema';
