-- 20261006001300_platform: part 8 of 11. Run the parts in order.
-- business and usage numbers (any platform role)
create or replace function public.platform_metrics() returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_mrr bigint;
  v_paying integer;
begin
  perform app.require_platform(array['support', 'finance', 'readonly']);
  -- monthly recurring revenue before VAT: active, paid plans; annual prices are per month already
  select coalesce(sum(case when s.billing_cycle = 'annual' then p.price_annual_agorot else p.price_monthly_agorot end
                      * coalesce(s.seats, 1)), 0),
         count(*)
    into v_mrr, v_paying
    from public.subscriptions s
    join public.plans p on p.key = s.plan_key
    join public.organizations o on o.id = s.organization_id
   where s.status = 'active' and o.status in ('active', 'past_due') and o.deleted_at is null
     and p.price_monthly_agorot > 0;
  return jsonb_build_object(
    'mrr_agorot', v_mrr,
    'paying_orgs', v_paying,
    'arpa_agorot', case when v_paying > 0 then v_mrr / v_paying end,
    'orgs_total', (select count(*) from public.organizations o where o.deleted_at is null),
    'by_status', (select jsonb_object_agg(x.status, x.n) from (
                    select o.status::text as status, count(*) as n from public.organizations o
                     where o.deleted_at is null group by o.status) x),
    'by_plan', (select jsonb_object_agg(x.plan_key, x.n) from (
                  select s.plan_key, count(*) as n from public.subscriptions s
                  join public.organizations o on o.id = s.organization_id and o.deleted_at is null
                  group by s.plan_key) x),
    'new_by_month', (select jsonb_agg(x order by x.month) from (
                       select to_char(date_trunc('month', o.created_at), 'YYYY-MM') as month, count(*) as n
                         from public.organizations o
                        where o.created_at > date_trunc('month', now()) - interval '11 months'
                        group by 1) x),
    -- of the organizations whose trial is over, how many pay
    'trial_conversion', (select jsonb_build_object('ended', count(*), 'paying', count(*) filter (where s.status = 'active' and p.price_monthly_agorot > 0))
                           from public.subscriptions s join public.plans p on p.key = s.plan_key
                          where s.trial_ends_at < now()),
    'cancelled_30d', (select count(*) from public.organizations o where o.status = 'cancelled' and o.updated_at > now() - interval '30 days'),
    'users_total', (select count(*) from auth.users),
    'active_users_1d', (select count(*) from auth.users u where u.last_sign_in_at > now() - interval '1 day'),
    'active_users_30d', (select count(*) from auth.users u where u.last_sign_in_at > now() - interval '30 days'),
    'quiet_orgs', (select count(*) from public.organizations o
                    where o.deleted_at is null and o.status in ('trial', 'active', 'past_due')
                      and not exists (select 1 from public.memberships m join auth.users u on u.id = m.user_id
                                       where m.organization_id = o.id and u.last_sign_in_at > now() - interval '14 days')),
    'health', jsonb_build_object(
      'outbox_backlog', (select count(*) from public.outbox_events e where e.processed_at is null),
      'automation_failures_24h', (select count(*) from public.automation_runs r where r.status = 'failed' and r.created_at > now() - interval '1 day'),
      'push_pending', (select count(*) from public.notifications n where n.pushed_at is null and n.created_at > now() - interval '1 hour')));
end;
$$;
