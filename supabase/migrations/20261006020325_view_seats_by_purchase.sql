-- =============================================================================
-- View seats count by purchased seats (PRM-02 change, owner's answer of 18 October 2026)
-- =============================================================================
-- The allowance of view seats is view_seats_per_paid_seat x the full seats bought in the subscription
-- (public.subscriptions.seats, 0001: "purchased full seats; null = not limited by purchase"), no longer the
-- active full-seat members.
-- * Fallback (coordinator, 18 October 2026): while seats is null (a trial, or a business not limited by purchase)
--   the old rule stays: active full seats other than `p_exclude`. Nothing changes for trials.
-- * With a purchase, `p_exclude` does not matter: turning a full member into a viewer does not change what was bought.
-- * Per-business overrides of view_seats_per_paid_seat keep working through app.org_limit (unchanged); no
--   limit (null) stays no limit.
-- * Seats already over the allowance (fewer seats bought later) stay; nothing is suspended automatically. Only a
--   new active view seat is refused (app.assert_view_seat_available, unchanged).
-- Callers are unchanged: app.assert_view_seat_available (guard_membership path) and public.org_plan_usage.
-- Every statement is safe to run twice. No drops, no row changes.

create or replace function app.view_seat_cap(p_org uuid, p_exclude uuid) returns integer
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_per numeric := app.org_limit(p_org, 'view_seats_per_paid_seat');
  v_paid integer;
begin
  if v_per is null then
    return null;
  end if;
  -- the full seats bought in the subscription
  select s.seats into v_paid from public.subscriptions s where s.organization_id = p_org;
  if v_paid is null then
    -- not limited by purchase (trial): the active full seats, as before
    select count(*) into v_paid
      from public.memberships m
     where m.organization_id = p_org and m.status = 'active' and m.seat_type = 'full'
       and m.id is distinct from p_exclude;
  end if;
  return floor(v_per * v_paid)::integer;
end;
$$;
revoke all on function app.view_seat_cap(uuid, uuid) from public, anon, authenticated;
