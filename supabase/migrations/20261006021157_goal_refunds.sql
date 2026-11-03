-- =============================================================================
-- GOL-01 collection goals: the refunds counted in a goal's actual (owner's answer (83) א, 3 November 2026)
-- =============================================================================
-- A collection goal (metric 'collected') whose actual is negative is shown as it is (a negative percent, an empty bar)
-- with the line "מתוכם החזרים: X". For that line every 'collected' row of report_goal_progress now also answers
-- `refunds`: the agorot of the active refunds counted in that goal's actual (a positive number, 0 when none), with the
-- same rep, team, period and cheque rules as the actual (021156's refund rows of pay_rows). Every other metric answers
-- `refunds` null. The actual, the rows returned and app.goal_payments_counted are unchanged.
-- Redefined from its latest body (021156); same signature, invoker, settings. Safe to run twice. Nothing is removed.

CREATE OR REPLACE FUNCTION public.report_goal_progress(p_org uuid, p_period text DEFAULT NULL::text, p_period_start date DEFAULT NULL::date, p_user uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
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
  ), pay_rows as (
    -- GOL-01 collection: payments recorded or confirmed with paid_on in the period, a cheque only once cleared or due
    -- (owner's answer (17) ג), by rep
    -- (the deal's owner, else the contact's) and team (the deal's, else the contact's), as the caller reads them.
    -- PAY-08 (owner's answer (81) ב): a payment counts IN FULL in its own period, also one refunded in full by its refunds
    -- (status 'refunded' with an active refund; a 'refunded' status set by hand with no refund record stays out); each
    -- active refund counts NEGATIVE in the period of its refunded_on, under its payment's rep and team and its payment's
    -- cheque rule. Every row (payment or refund) is one in n (keep in step with app.goal_payments_counted)
    select w.period, w.period_start, coalesce(dl.owner_id, ct.owner_id) as user_id, coalesce(dl.team_id, ct.team_id) as team_id,
           p.amount_agorot::numeric as value, 0::numeric as refund
      from windows w
      cross join org
      join public.payments p on p.organization_id = p_org
                            and (p.status in ('recorded', 'confirmed')
                                 or (p.status = 'refunded'
                                     and exists (select 1 from public.payment_refunds r
                                                  where r.organization_id = p.organization_id and r.payment_id = p.id
                                                    and r.status = 'active')))
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
    union all
    select w.period, w.period_start, coalesce(dl.owner_id, ct.owner_id), coalesce(dl.team_id, ct.team_id),
           -r.amount_agorot::numeric, r.amount_agorot::numeric
      from windows w
      cross join org
      join public.payment_refunds r on r.organization_id = p_org and r.status = 'active'
                                   and r.refunded_on >= w.period_start
                                   and r.refunded_on < (w.period_start + case w.period when 'month' then interval '1 month'
                                                                                       when 'quarter' then interval '3 months'
                                                                                       else interval '1 year' end)::date
      join public.payments p on p.organization_id = r.organization_id and p.id = r.payment_id
                            and p.status in ('recorded', 'confirmed', 'refunded')
                            -- (17) (ג): the payment's cheque rule (keep in step with app.goal_payments_counted)
                            and (p.cheque_status is null or p.cheque_status = 'cleared'
                                 or (p.cheque_status <> 'bounced' and p.cheque_due_date <= org.today))
      left join public.deals dl on dl.organization_id = p.organization_id and dl.id = p.deal_id
      left join public.contacts ct on ct.organization_id = p.organization_id and ct.id = p.contact_id
     where exists (select 1 from g where g.metric = 'collected')
  ), pay_facts as (
    select pr.period, pr.period_start, pr.user_id, pr.team_id, sum(pr.value)::numeric as value, count(*)::bigint as n,
           sum(pr.refund)::numeric as refund
      from pay_rows pr
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
           'refunds', r.refunds,
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
             -- (83) א: the active refunds counted in a collection goal's actual (positive agorot), the same rows as the
             -- actual's negative refund rows; null for every other metric
             case when g.metric = 'collected' then coalesce((
               select sum(pf.refund) from pay_facts pf
                where pf.period = g.period and pf.period_start = g.period_start
                  and (g.scope = 'org'
                       or (g.scope = 'user' and pf.user_id = g.user_id)
                       or (g.scope = 'team' and pf.team_id in (select tree.team_id from tree where tree.root = g.team_id)))
             ), 0)::bigint end as refunds,
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
$function$;

