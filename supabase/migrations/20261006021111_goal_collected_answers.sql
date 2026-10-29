-- =============================================================================
-- GOL-01 collection goals, the owner's answers of 29 October 2026 (docs/DECISIONS.md "יעד גבייה"; 021106 built (א) (א) (א)):
-- (15) (ב) a collection goal needs the plan keys payments, documents AND collection, as the collection screen and report.
--      Trigger goals_collected (app.goals_collected_check) refuses a new collection goal, or a change of one's target or
--      identity, while any is missing, with that key's own hint (feature:payments, then feature:documents, then
--      feature:collection). An unchanged update and a removal stay allowed. The goals grid offers the metric only with all
--      three (goalMetricKeysFor).
-- (16) (ב) only someone who may record payments (app.can_record_payments: owners, admins and managers by role, or the
--      PRM-01 key record_payments) sees a collection goal's actual. For anyone else public.report_goal_progress leaves the
--      collection goal out (the answer's shape is unchanged: `actual` stays a number), as COL-01 answers them
--      {"allowed": false}; COL-01's "partial" (a recorder who does not read every payment) keeps 021106's per-goal rule: the
--      goal is left out unless the caller reads every payment it counts. The target stays visible on the goals grid
--      (goals_select). app.goal_payments_counted answers null to a non-recorder and without the three keys.
-- (17) (ג) counted: payments recorded or confirmed by paid_on in the period, but a cheque (PAY-04: cheque_status set) only
--      once it is cleared or its cheque_due_date has come (on or before the business's today); a bounced cheque never
--      (its payment is failed too). report_goal_progress and app.goal_payments_counted apply the same rule, so the
--      full-read check still compares like with like. COL-06's report is unchanged (it counts every recorded payment).
-- Redefined from 021106 (their latest definitions): app.goals_collected_check, app.goal_payments_counted,
-- public.report_goal_progress; same signatures and grants. Every statement is safe to run twice. No object or row is removed.
-- =============================================================================

create or replace function app.goals_collected_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and not app.is_member(new.organization_id) then
    return new;
  end if;
  if new.metric <> 'collected' then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.organization_id = old.organization_id
     and new.scope = old.scope
     and new.user_id is not distinct from old.user_id
     and new.team_id is not distinct from old.team_id
     and new.period = old.period
     and new.period_start = old.period_start
     and new.metric = old.metric
     and new.target = old.target then
    return new;
  end if;
  -- GOL-01 (15) (ב): the keys of the collection screen and report (COL-01, COL-06), each refused with its own hint
  if not app.org_has_feature(new.organization_id, 'payments') then
    raise exception 'collection goals need the payments module'
      using errcode = 'P0001', hint = 'feature:payments';
  end if;
  if not app.org_has_feature(new.organization_id, 'documents') then
    raise exception 'collection goals need the documents module'
      using errcode = 'P0001', hint = 'feature:documents';
  end if;
  if not app.org_has_feature(new.organization_id, 'collection') then
    raise exception 'collection goals need the collection module'
      using errcode = 'P0001', hint = 'feature:collection';
  end if;
  return new;
end;
$$;
revoke all on function app.goals_collected_check() from public, anon, authenticated;

create or replace trigger goals_collected before insert or update on public.goals
  for each row execute function app.goals_collected_check();

create or replace function app.goal_payments_counted(p_org uuid, p_goal uuid) returns bigint
language sql stable security definer
set search_path = ''
as $$
  with g as (
    select g.scope, g.user_id, g.team_id, g.period_start,
           (now() at time zone coalesce(o.timezone, 'Asia/Jerusalem'))::date as today,
           (g.period_start + case g.period when 'month' then interval '1 month'
                                           when 'quarter' then interval '3 months'
                                           else interval '1 year' end)::date as period_end
      from public.goals g
      join public.organizations o on o.id = g.organization_id
     where g.organization_id = p_org and g.id = p_goal and g.metric = 'collected'
       and (app.is_member(p_org) or app.support_session(p_org))
       -- GOL-01 (16) (ב): an actual only for those who record payments, (15) (ב) with the three keys
       and app.can_record_payments(p_org)
       and app.org_has_feature(p_org, 'payments') and app.org_has_feature(p_org, 'documents')
       and app.org_has_feature(p_org, 'collection')
       and (app.is_admin(p_org)
            or g.scope = 'org'
            or app.support_session(p_org)
            or (g.scope = 'user' and g.user_id = auth.uid())
            or (g.scope = 'user' and app.goals_manages_user(p_org, g.user_id))
            or (g.scope = 'team' and (app.in_team(g.team_id) or app.goals_manages_team(p_org, g.team_id))))
  ), tree as (
    with recursive t (team_id, depth) as (
      select g.team_id, 1 from g where g.scope = 'team'
      union all
      select c.id, t.depth + 1
        from t join public.teams c on c.organization_id = p_org and c.parent_team_id = t.team_id
       where t.depth < 10
    )
    select distinct t.team_id from t
  )
  select case when exists (select 1 from g) then (
    select count(*)
      from g
      join public.payments p on p.organization_id = p_org
                            and p.status in ('recorded', 'confirmed')
                            and p.paid_on >= g.period_start and p.paid_on < g.period_end
                            -- GOL-01 (17) (ג): a cheque counts once cleared or its due date has come (the business's today);
                            -- a bounced one never (its payment is failed too). Keep in step with report_goal_progress
                            and (p.cheque_status is null or p.cheque_status = 'cleared'
                                 or (p.cheque_status <> 'bounced' and p.cheque_due_date <= g.today))
      left join public.deals dl on dl.organization_id = p.organization_id and dl.id = p.deal_id
      left join public.contacts ct on ct.organization_id = p.organization_id and ct.id = p.contact_id
     where g.scope = 'org'
        or (g.scope = 'user' and coalesce(dl.owner_id, ct.owner_id) = g.user_id)
        or (g.scope = 'team' and coalesce(dl.team_id, ct.team_id) in (select tree.team_id from tree))
  ) end
$$;
revoke all on function app.goal_payments_counted(uuid, uuid) from public, anon, service_role;
-- report_goal_progress is invoker, so the caller runs this
grant execute on function app.goal_payments_counted(uuid, uuid) to authenticated;

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
       -- GOL-01 collection: only while the plan holds payments, documents and collection ((15) ב), and only for those
       -- who record payments ((16) ב: COL-01's rule; for anyone else the goal is left out, as COL-01 answers them
       -- {"allowed": false}; the goal's target stays visible on the goals grid per goals_select)
       and (g.metric <> 'collected'
            or (app.org_has_feature(p_org, 'payments') and app.org_has_feature(p_org, 'documents')
                and app.org_has_feature(p_org, 'collection') and app.can_record_payments(p_org)))
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
  ), pay_facts as (
    -- GOL-01 collection: payments recorded or confirmed with paid_on in the period, a cheque only once cleared or due
    -- (owner's answer (17) ג), by rep
    -- (the deal's owner, else the contact's) and team (the deal's, else the contact's), as the caller reads them
    select w.period, w.period_start, coalesce(dl.owner_id, ct.owner_id) as user_id, coalesce(dl.team_id, ct.team_id) as team_id,
           sum(p.amount_agorot)::numeric as value, count(*)::bigint as n
      from windows w
      cross join org
      join public.payments p on p.organization_id = p_org and p.status in ('recorded', 'confirmed')
                            and p.paid_on >= w.period_start
                            and p.paid_on < (w.period_start + case w.period when 'month' then interval '1 month'
                                                                            when 'quarter' then interval '3 months'
                                                                            else interval '1 year' end)::date
                            -- (17) (ג): a cheque once cleared or due (keep in step with app.goal_payments_counted)
                            and (p.cheque_status is null or p.cheque_status = 'cleared'
                                 or (p.cheque_status <> 'bounced' and p.cheque_due_date <= org.today))
      left join public.deals dl on dl.organization_id = p.organization_id and dl.id = p.deal_id
      left join public.contacts ct on ct.organization_id = p.organization_id and ct.id = p.contact_id
     where exists (select 1 from g where g.metric = 'collected')
     group by 1, 2, 3, 4
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
    union all
    select pf.period, pf.period_start, 'collected', pf.user_id, pf.team_id, pf.value from pay_facts pf
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
                  array_position(array['won_amount', 'won_deals', 'leads_handled', 'meetings_held', 'collected'], r.metric),
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
       where case when g.metric = 'collected' then
               -- GOL-01 collection: every payment that counts for the goal is one the caller reads
               coalesce((
                 select sum(pf.n) from pay_facts pf
                  where pf.period = g.period and pf.period_start = g.period_start
                    and (g.scope = 'org'
                         or (g.scope = 'user' and pf.user_id = g.user_id)
                         or (g.scope = 'team' and pf.team_id in (select tree.team_id from tree where tree.root = g.team_id)))
               ), 0) = app.goal_payments_counted(p_org, g.id)
             else
             app.is_admin(p_org)
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
             end
    ) r;
$$;

revoke all on function public.report_goal_progress(uuid, text, date, uuid) from public, anon;
grant execute on function public.report_goal_progress(uuid, text, date, uuid) to authenticated;
