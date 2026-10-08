-- =============================================================================
-- 0043 The organization's time zone and currency in its context (FXC-04)
-- =============================================================================
-- organizations.timezone and .currency were stored but the app used a fixed
-- "Asia/Jerusalem" and "ILS". org_context() now returns both with the
-- organization, so pages can compute "today" and amounts in the organization's
-- own settings. Otherwise as in 0028. Every statement is safe to run twice.

create or replace function public.org_context(p_org uuid) returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'org', (select jsonb_build_object('id', o.id, 'name', o.name, 'status', o.status,
                                      'timezone', o.timezone, 'currency', o.currency)
              from public.organizations o where o.id = p_org and o.deleted_at is null),
    'membership', (select jsonb_build_object('role', m.role, 'is_available', m.is_available)
                     from public.memberships m
                    where m.organization_id = p_org and m.user_id = (select auth.uid()) and m.status = 'active'),
    'subscription', (select jsonb_build_object('status', s.status, 'plan_key', s.plan_key, 'plan_name', p.name_he,
                                               'trial_ends_at', s.trial_ends_at)
                       from public.subscriptions s left join public.plans p on p.key = s.plan_key
                      where s.organization_id = p_org),
    'full_name', (select pr.full_name from public.profiles pr where pr.id = (select auth.uid())),
    'agreement_version', public.agreement_status()
  );
$$;

revoke all on function public.org_context(uuid) from public, anon;
grant execute on function public.org_context(uuid) to authenticated;
