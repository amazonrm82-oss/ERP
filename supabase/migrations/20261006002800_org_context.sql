-- =============================================================================
-- 0028 One round trip for the organization context of a page
-- =============================================================================
-- Every page inside an organization needs the organization, the caller's
-- membership, the subscription with its plan name, the caller's display name and
-- the agreement version they signed. That was four queries, then the plan, then
-- the agreement: three round trips one after the other. public.org_context()
-- returns all of it in one call.
-- * security invoker on purpose: every part is read with the caller's rights, so
--   RLS answers exactly as the separate queries did (a part the caller may not
--   see is null: not a member, a deleted organization, a session that still owes
--   the two-step code).
-- Every statement is safe to run twice.

create or replace function public.org_context(p_org uuid) returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'org', (select jsonb_build_object('id', o.id, 'name', o.name, 'status', o.status)
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
