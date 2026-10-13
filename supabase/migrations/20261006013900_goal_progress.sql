-- =============================================================================
-- Progress against goals (GOL-03)
-- =============================================================================
-- public.report_goal_progress(org, period, period_start, user) returns one row
-- per goal the caller may read (goals_select decides), with what was actually
-- done in the goal's period. The app shows it on the manager dashboard, in
-- "My day" and in the rep performance report, with the percent and the linear
-- pace to the end of the period (src/features/goals/progress.ts).
--
-- * Which goals: with p_period and p_period_start, the goals of exactly that
--   period; without them, every goal whose period holds today (the
--   organization's time zone). p_user keeps only that person's own goals
--   (scope user). No goal means no row: nothing is ever shown against nothing.
-- * The period in time: from period_start 00:00 to the start of the next
--   month, quarter or year, in the organization's time zone (default
--   Asia/Jerusalem), like report_revenue. elapsed is the share of that time
--   already gone (0..1); the pace is the app's: actual / elapsed.
-- * Actuals, each with the definition of the report it belongs to:
--   - won_amount / won_deals: report_rep_performance and report_revenue: deals
--     not in the recycle bin, status won, closed_at in the period; the sum of
--     amount_agorot / the count. Every pipeline. Credited to the deal's owner.
--   - leads_handled: the contact rule of report_response_time (0114): an
--     activity a person logged (created_by set) of a contact type, not a
--     private note. A lead counts in the period of its FIRST such activity
--     (leads not in the recycle bin). Credited to the lead's owner.
--   - meetings_held: report_activity's "meeting" column: timeline entries of
--     type meeting a person logged, occurred_at in the period. A meeting marked
--     held writes exactly one such entry with its organizer as the author
--     (0069), so held meetings and logged meetings are one number. Credited to
--     the author (created_by).
--   - Entries dated more than 5 minutes ahead are not counted (the rule of
--     app.stamp_last_contact): only what has happened.
--   - Who (owner, 13 October 2026, option A): a person's goal counts what is
--     credited to them (owner, or author for meetings). A team's goal counts by
--     the TEAM SET ON THE RECORD: deals.team_id (won_amount, won_deals),
--     leads.team_id (leads_handled), and for a meeting entry the team of its
--     record (its deal, else lead, else contact, else company; chosen without
--     RLS by app.activity_goal_team, so every viewer gets the same), in the team or a
--     team below it (10 levels, like app.manages_team). A record with no team
--     counts in no team's goal. The organization's goal counts everything.
-- * SECURITY INVOKER, like every report: RLS decides which goals are read
--   and which deals, leads and activities are counted.
-- * Only goals whose actual the caller sees in full are returned (a partial
--   number is never shown):
--   - owners, admins and an open support session (of staff who are not members): every goal they read; under
--     'org' visibility, everyone;
--   - a team's goal: a manager (role) who manages the team or a parent of it,
--     under every visibility, since a manager reads the records of those teams
--     (app.can_read_record by team_id); under 'team' visibility also a member
--     who is in the team and in every team below it;
--   - a person's own goal; meetings_held only while every meeting entry they
--     wrote in the period is on a record they may still read
--     (app.goal_entries_readable), since activities_select hides the others.
--   Personal goals count by owner, not by team, so a colleague's goal (also a
--   managed person's, for a manager) is shown only under the first rule.
-- Every statement is safe to run twice. No deletes, no drops.

-- ----------------------------------------------------------------------------
-- Are all of a person's own meeting entries in a window on records they may
-- read? (A meeting entry they wrote on a record they no longer read is hidden
-- from them by activities_select, so their own meetings_held actual would be
-- short.) SECURITY DEFINER to see the hidden entries; it answers only about the
-- caller's own entries and returns only a boolean. Mirrors activities_select:
-- an entry is readable when any record it is on passes app.can_read_record.
-- ----------------------------------------------------------------------------
create or replace function app.goal_entries_readable(p_org uuid, p_user uuid, p_from timestamptz, p_to timestamptz) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_user is not null and p_user = auth.uid() and app.is_member(p_org)
     and not exists (
       select 1 from public.activities a
        where a.organization_id = p_org and a.type = 'meeting' and a.created_by = p_user
          and a.occurred_at >= p_from and a.occurred_at < p_to
          and a.occurred_at <= now() + interval '5 minutes'
          and not (
            exists (select 1 from public.leads l
                     where l.organization_id = p_org and l.id = a.lead_id and app.can_read_record(p_org, l.owner_id, l.team_id))
            or exists (select 1 from public.contacts c
                        where c.organization_id = p_org and c.id = a.contact_id and app.can_read_record(p_org, c.owner_id, c.team_id))
            or exists (select 1 from public.companies co
                        where co.organization_id = p_org and co.id = a.company_id and app.can_read_record(p_org, co.owner_id, co.team_id))
            or exists (select 1 from public.deals d
                        where d.organization_id = p_org and d.id = a.deal_id and app.can_read_record(p_org, d.owner_id, d.team_id))))
$$;
revoke all on function app.goal_entries_readable(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function app.goal_entries_readable(uuid, uuid, timestamptz, timestamptz) to authenticated;

-- ----------------------------------------------------------------------------
-- The team a meeting entry counts for in team goals: the team of its deal, else
-- its lead, contact, company, read WITHOUT RLS so the choice does not depend on
-- who is looking (an entry on a lead the caller reads and a deal they do not
-- would otherwise fall to the lead's team for one viewer and the deal's for
-- another). SECURITY DEFINER; it returns the team only when the caller may read
-- that team's records anyway (app.can_read_record by team), else null. So it
-- tells nothing the caller could not already see by opening the record: every
-- caller who sees a team's goal (admins, 'org' visibility, the team's manager,
-- an in-team member under 'team' visibility) can read that team's records and
-- gets the same answer; for anyone else the entry is in no team they can see.
-- ----------------------------------------------------------------------------
create or replace function app.activity_goal_team(p_org uuid, p_deal uuid, p_lead uuid, p_contact uuid, p_company uuid) returns uuid
language sql stable security definer
set search_path = ''
as $$
  select case when app.is_member(p_org) and app.can_read_record(p_org, null, t.team_id) then t.team_id end
    from (
      select coalesce(
               (select d.team_id from public.deals d where d.organization_id = p_org and d.id = p_deal),
               (select l.team_id from public.leads l where l.organization_id = p_org and l.id = p_lead),
               (select c.team_id from public.contacts c where c.organization_id = p_org and c.id = p_contact),
               (select co.team_id from public.companies co where co.organization_id = p_org and co.id = p_company)) as team_id
    ) t
$$;
revoke all on function app.activity_goal_team(uuid, uuid, uuid, uuid, uuid) from public, anon;
grant execute on function app.activity_goal_team(uuid, uuid, uuid, uuid, uuid) to authenticated;

create or replace function public.report_goal_progress(
  p_org uuid, p_period text default null, p_period_start date default null, p_user uuid default null)
returns jsonb
language sql stable
set search_path = ''
as $$
  with org as (
    select coalesce(o.timezone, 'Asia/Jerusalem') as tz, o.record_visibility::text as visibility,
           (now() at time zone coalesce(o.timezone, 'Asia/Jerusalem'))::date as today
      from public.organizations o
     where o.id = p_org
  ), g as (
    select g.id, g.scope, g.user_id, g.team_id, g.period, g.period_start, g.metric, g.target,
           (g.period_start::timestamp at time zone org.tz) as t_from,
           ((g.period_start + case g.period when 'month' then interval '1 month'
                                            when 'quarter' then interval '3 months'
                                            else interval '1 year' end)::timestamp at time zone org.tz) as t_to
      from public.goals g
      cross join org
     where g.organization_id = p_org
       and (p_user is null or (g.scope = 'user' and g.user_id = p_user))
       and case when p_period is not null or p_period_start is not null
                then g.period = p_period and g.period_start = p_period_start
                else g.period_start <= org.today
                     and org.today < g.period_start + case g.period when 'month' then interval '1 month'
                                                                    when 'quarter' then interval '3 months'
                                                                    else interval '1 year' end
           end
  ), windows as (
    select distinct g.period, g.period_start, g.t_from, g.t_to from g
  ), contacted as (
    -- leads with a contact entry inside a goal's window first; their first entry ever is then
    -- looked up for those leads only
    select distinct a.lead_id
      from windows w
      join public.activities a on a.organization_id = p_org and a.lead_id is not null
                              and a.occurred_at >= w.t_from and a.occurred_at < w.t_to
     where a.created_by is not null and a.type = any (app.contact_types()) and not a.is_private
       and a.occurred_at <= now() + interval '5 minutes'
       and exists (select 1 from g where g.metric = 'leads_handled')
  ), first_contact as (
    select a.lead_id, min(a.occurred_at) as at
      from public.activities a
     where a.organization_id = p_org and a.lead_id in (select c.lead_id from contacted c)
       and a.created_by is not null and a.type = any (app.contact_types()) and not a.is_private
       and a.occurred_at <= now() + interval '5 minutes'
     group by a.lead_id
  ), facts as (
    -- what each person did, and on records of which team
    select w.period, w.period_start, 'won_amount'::text as metric, d.owner_id as user_id, d.team_id,
           sum(d.amount_agorot)::numeric as value
      from windows w
      join public.deals d on d.organization_id = p_org and d.deleted_at is null and d.status = 'won'
                         and d.closed_at >= w.t_from and d.closed_at < w.t_to
     where exists (select 1 from g where g.metric = 'won_amount')
     group by 1, 2, 4, 5
    union all
    select w.period, w.period_start, 'won_deals', d.owner_id, d.team_id, count(*)::numeric
      from windows w
      join public.deals d on d.organization_id = p_org and d.deleted_at is null and d.status = 'won'
                         and d.closed_at >= w.t_from and d.closed_at < w.t_to
     where exists (select 1 from g where g.metric = 'won_deals')
     group by 1, 2, 4, 5
    union all
    select w.period, w.period_start, 'leads_handled', l.owner_id, l.team_id, count(*)::numeric
      from windows w
      join first_contact f on f.at >= w.t_from and f.at < w.t_to
      join public.leads l on l.organization_id = p_org and l.id = f.lead_id and l.deleted_at is null
     group by 1, 2, 4, 5
    union all
    select w.period, w.period_start, 'meetings_held', a.created_by,
           app.activity_goal_team(p_org, a.deal_id, a.lead_id, a.contact_id, a.company_id), count(*)::numeric
      from windows w
      join public.activities a on a.organization_id = p_org and a.type = 'meeting' and a.created_by is not null
                              and a.occurred_at >= w.t_from and a.occurred_at < w.t_to
                              and a.occurred_at <= now() + interval '5 minutes'
     where exists (select 1 from g where g.metric = 'meetings_held')
     group by 1, 2, 4, 5
  ), tree as (
    -- each team goal's team and the teams below it
    with recursive t (root, team_id, depth) as (
      select tm.id, tm.id, 1
        from public.teams tm
       where tm.organization_id = p_org and tm.id in (select g.team_id from g where g.scope = 'team')
      union all
      select t.root, c.id, t.depth + 1
        from t join public.teams c on c.organization_id = p_org and c.parent_team_id = t.team_id
       where t.depth < 10
    )
    select distinct t.root, t.team_id from t
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'goal_id', r.id,
           'scope', r.scope,
           'user_id', r.user_id,
           'team_id', r.team_id,
           'period', r.period,
           'period_start', r.period_start,
           'metric', r.metric,
           'target', r.target,
           'actual', r.actual,
           'elapsed', r.elapsed)
         order by array_position(array['org', 'team', 'user'], r.scope),
                  array_position(array['won_amount', 'won_deals', 'leads_handled', 'meetings_held'], r.metric),
                  array_position(array['month', 'quarter', 'year'], r.period),
                  r.period_start, r.id), '[]'::jsonb)
    from (
      select g.id, g.scope, g.user_id, g.team_id, g.period, g.period_start, g.metric, g.target,
             coalesce((
               select sum(f.value) from facts f
                where f.period = g.period and f.period_start = g.period_start and f.metric = g.metric
                  and (g.scope = 'org'
                       or (g.scope = 'user' and f.user_id = g.user_id)
                       or (g.scope = 'team' and f.team_id in (select tree.team_id from tree where tree.root = g.team_id)))
             ), 0)::bigint as actual,
             round(greatest(0, least(1,
               extract(epoch from (now() - g.t_from)) / nullif(extract(epoch from (g.t_to - g.t_from)), 0)))::numeric, 4) as elapsed
        from g
       where app.is_admin(p_org)
          -- platform support in an open session, unless they are also a member (then their role decides)
          or (app.membership_role(p_org) is null and app.support_session(p_org))
          or (select visibility from org) = 'org'
          -- a team's goal: its manager reads every record of the team and the teams below it
          -- (and of every team the goal counts: a tree deeper than app.manages_team reaches is not whole)
          or (g.scope = 'team' and app.goals_manages_team(p_org, g.team_id)
              and not exists (select 1 from tree where tree.root = g.team_id and not app.manages_team(tree.team_id)))
          or (g.scope = 'team' and (select visibility from org) = 'team'
              and not exists (select 1 from tree where tree.root = g.team_id and not app.in_team(tree.team_id)))
          -- a person's own goal; for meetings only while every entry they wrote in the period is on
          -- a record they may still read (activities_select would hide the others)
          or (g.scope = 'user' and g.user_id = (select auth.uid())
              and (g.metric <> 'meetings_held' or app.goal_entries_readable(p_org, g.user_id, g.t_from, g.t_to)))
    ) r;
$$;

revoke all on function public.report_goal_progress(uuid, text, date, uuid) from public, anon;
grant execute on function public.report_goal_progress(uuid, text, date, uuid) to authenticated;
