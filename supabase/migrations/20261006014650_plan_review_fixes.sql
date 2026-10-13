-- =============================================================================
-- Plans: review fixes (13 October 2026)
-- =============================================================================
-- 1. platform_metrics(): the body of 0116 (activation_metric), with the monthly
--    revenue counting a price per business (plans.price_unit = 'org') once and a
--    price per user once per seat. Nothing else changes.
-- 2. app.plan_key_defaults(): the two AI quotas (ai_credits_per_month,
--    ai_credits_per_user_per_month) get the restrictive fallback too, so a plan
--    without one counts 0 in the database as in orgAllowance()
--    (src/lib/plan-keys.ts, PLAN_KEY_FALLBACK mirrors this; unit test).
-- Every statement is safe to run twice.

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
                      -- a price per business counts once; a price per user once per seat
                      * case when p.price_unit = 'org' then 1 else coalesce(s.seats, 1) end), 0),
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
    -- GAP-06: organizations (not deleted) whose first real lead got an answer within 24 hours,
    -- and the median time from sign-up to that moment
    'activation', (select jsonb_build_object(
                            'activated', count(*),
                            'median_hours', round((percentile_cont(0.5) within group (
                                              order by extract(epoch from greatest(act.activated_at - o.created_at, interval '0')) / 3600))::numeric, 1))
                     from app.org_activation act
                     join public.organizations o on o.id = act.organization_id
                    where o.deleted_at is null),
    'health', jsonb_build_object(
      'outbox_backlog', (select count(*) from public.outbox_events e where e.processed_at is null),
      'automation_failures_24h', (select count(*) from public.automation_runs r where r.status = 'failed' and r.created_at > now() - interval '1 day'),
      'push_pending', (select count(*) from public.notifications n where n.pushed_at is null and n.created_at > now() - interval '1 hour')));
end;
$$;

create or replace function app.plan_key_defaults() returns jsonb
language sql immutable
set search_path = ''
as $$
  select $json$
{
  "features": {
    "products": false,
    "price_lists": false,
    "discounts": false,
    "quotes": false,
    "orders": false,
    "documents": false,
    "payments": false,
    "balances": false,
    "collection": false,
    "money_waiting": false,
    "consents": false,
    "segments": false,
    "goals": false,
    "granular_permissions": false,
    "booking_page": false,
    "business_card": false,
    "qr_codes": false,
    "site_widget": false,
    "retention": false,
    "remove_built_with": false,
    "payment_links": false,
    "instant_reply": false,
    "auto_reassign": false,
    "dashboards": false,
    "goals_per_rep": false,
    "booking_team_pages": false
  },
  "limits": {
    "max_products": 0,
    "max_price_lists": 0,
    "max_quote_templates": 0,
    "max_booking_pages": 0,
    "max_booking_pages_per_user": 0,
    "max_segments": 0,
    "max_qr_codes": 0,
    "max_pdf_per_month": 0,
    "max_customer_emails_per_month": 0,
    "max_customer_emails_per_day": 0,
    "max_custom_reports": 0,
    "max_custom_objects": 0,
    "max_teams": 0,
    "max_whatsapp_numbers": 0,
    "view_seats_per_paid_seat": 0,
    "max_site_widgets": 0,
    "max_business_cards_per_user": 0,
    "max_booking_team_pages": 0,
    "ai_credits_per_month": 0,
    "ai_credits_per_user_per_month": 0
  }
}
$json$::jsonb
$$;
revoke all on function app.plan_key_defaults() from public, anon, authenticated;
