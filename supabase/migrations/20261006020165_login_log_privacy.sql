-- =============================================================================
-- The login log shows a business only its own part of a person's activity (FXS-10)
-- =============================================================================
-- The review of 8 October 2026 (FXS-10): sign-in events are per person, not per business, so the log of one business
-- showed a member's sign-ins made while working in another business of theirs, with the IP address. Now
-- public.org_login_events() (body of account_security, 0014):
-- * lists a member's events only from the day they joined this business (their membership's created_at), and
-- * gives the IP address only of a person whose only business this is; for someone who belongs to another business
--   too, ip is null and ip_hidden is true (the event and its time stay: they are the business's own member).
-- Admins only, within the plan's audit log window, as before. Safe to run twice.

create or replace function public.org_login_events(p_org uuid, p_limit integer default 200) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_days numeric;
begin
  if not app.is_admin(p_org) then
    raise exception 'admins only' using errcode = '42501';
  end if;
  v_days := coalesce(app.org_limit(p_org, 'audit_log_days'), 3650);
  return coalesce((
    select jsonb_agg(x order by x.created_at desc) from (
      select e.created_at, e.payload ->> 'action' as action,
             case when m.only_here then e.ip_address end as ip,
             not m.only_here as ip_hidden,
             m.user_id
        from auth.audit_log_entries e
        join (select mm.user_id, mm.created_at as joined_at,
                     not exists (select 1 from public.memberships o
                                  where o.user_id = mm.user_id and o.organization_id <> p_org) as only_here
                from public.memberships mm
               where mm.organization_id = p_org) m
          on m.user_id::text = e.payload ->> 'actor_id'
       where e.payload ->> 'action' in ('login', 'logout', 'user_recovery_requested', 'user_updated_password', 'user_modified', 'token_revoked')
         and e.created_at > now() - make_interval(days => v_days::int)
         and e.created_at >= m.joined_at
       order by e.created_at desc
       limit least(greatest(coalesce(p_limit, 200), 1), 1000)) x), '[]'::jsonb);
end;
$$;
revoke all on function public.org_login_events(uuid, integer) from public, anon;
grant execute on function public.org_login_events(uuid, integer) to authenticated;

notify pgrst, 'reload schema';
