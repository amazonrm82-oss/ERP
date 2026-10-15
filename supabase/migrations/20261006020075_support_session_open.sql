-- =============================================================================
-- Opening a support session is what gives support the access (FXS-08)
-- =============================================================================
-- Before: app.support_session(org) was true for any platform owner/support user (with aal2) as soon as the
-- customer had a live grant (support_access_grants); public.platform_open_support() only wrote the log entries, as
-- a separate call, so support could read customer data with nothing in either log.
-- Now: platform_open_support() records the session in app.support_sessions (one row per support user and grant)
-- in the same transaction as its two log entries (app.platform_log 'support.open' and the customer's audit_log
-- 'support_open'), and app.support_session() is true only while such a row exists for the caller and its grant is
-- still live (not revoked, not expired). Without an opened session there is no read. Every existing guarantee
-- stays: aal2 (app.platform_role), the customer's approval (the grant), the viewer role (app.role_in, unchanged,
-- still asks app.support_session), and the log entries.
-- * A session lasts as long as the grant it was opened under: the customer's revoke or the grant's expiry ends it.
-- * Opening again while the caller's session under the same grant is open writes no second log entry (a page reload
--   is not a new entry); a new grant needs a new open, logged again.
-- * app.role_in and app.can_read_record are not redefined: they call app.support_session, redefined here, as do the
--   goals, goal progress and forecast, completeness and closed-business checks.
-- Every statement is safe to run twice. No deletes, no drops.

create table if not exists app.support_sessions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  grant_id        uuid not null,
  staff_user_id   uuid not null references auth.users (id) on delete cascade,
  opened_at       timestamptz not null default now(),
  unique (grant_id, staff_user_id),
  foreign key (organization_id, grant_id) references public.support_access_grants (organization_id, id) on delete cascade
);
create index if not exists support_sessions_staff_idx on app.support_sessions (staff_user_id, organization_id);

-- schema app: RLS on, no policies, no client grants (read only by the definer functions below)
alter table app.support_sessions enable row level security;
revoke all on app.support_sessions from public, anon, authenticated;

-- true while the caller is platform owner/support with a second factor AND has opened a session in the
-- organization under a grant that is still live
create or replace function app.support_session(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce(app.platform_role() in ('owner', 'support'), false)
     and exists (select 1
                   from app.support_sessions s
                   join public.support_access_grants g on g.organization_id = s.organization_id and g.id = s.grant_id
                  where s.organization_id = p_org and s.staff_user_id = auth.uid()
                    and g.revoked_at is null and g.expires_at > now());
$$;
revoke all on function app.support_session(uuid) from public, anon;
grant execute on function app.support_session(uuid) to authenticated, service_role;

-- The app asks this when the user is not a member: is it an open support session, and until when?
create or replace function public.support_session_info(p_org uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not app.support_session(p_org) then
    return null;
  end if;
  return jsonb_build_object('expires_at', (
    select max(g.expires_at)
      from app.support_sessions s
      join public.support_access_grants g on g.organization_id = s.organization_id and g.id = s.grant_id
     where s.organization_id = p_org and s.staff_user_id = auth.uid()
       and g.revoked_at is null and g.expires_at > now()));
end;
$$;
revoke all on function public.support_session_info(uuid) from public, anon;
grant execute on function public.support_session_info(uuid) to authenticated;

-- support opens a customer's organization: the session row, the platform log and the customer's audit log, together
create or replace function public.platform_open_support(p_org uuid) returns timestamptz
language plpgsql security definer
set search_path = ''
as $$
declare
  v_grant uuid;
  v_until timestamptz;
  v_session uuid;
begin
  perform app.require_platform(array['support']);
  -- the customer's live grant that lasts longest; locked so a revoke waits for this open to finish
  select g.id, g.expires_at into v_grant, v_until
    from public.support_access_grants g
   where g.organization_id = p_org and g.revoked_at is null and g.expires_at > now()
   order by g.expires_at desc, g.id
   limit 1
     for share;
  if v_grant is null then
    raise exception 'the customer has not granted support access' using errcode = '42501', hint = 'platform:no_grant';
  end if;
  insert into app.support_sessions (organization_id, grant_id, staff_user_id)
  values (p_org, v_grant, auth.uid())
  on conflict (grant_id, staff_user_id) do nothing
  returning id into v_session;
  -- a session already open under this grant: no second log entry
  if v_session is not null then
    perform app.log_platform('support.open', p_org, jsonb_build_object('until', v_until));
    insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
    values (p_org, auth.uid(), 'support_open', 'organizations', p_org, jsonb_build_object('until', v_until));
  end if;
  return v_until;
end;
$$;
revoke all on function public.platform_open_support(uuid) from public, anon;
grant execute on function public.platform_open_support(uuid) to authenticated;

notify pgrst, 'reload schema';
