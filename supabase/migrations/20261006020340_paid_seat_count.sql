-- =============================================================================
-- One count of paid seats for every per-seat quota (owner, 18 October 2026)
-- =============================================================================
-- Every "_per_user" quota, and the view seat allowance, counts the full seats bought in the subscription
-- (public.subscriptions.seats). While seats is null (a trial, not limited by purchase) the old rule stays: the
-- active full seats. The same rule as PRM-02 (020325), now in one place:
-- * app.paid_seat_count(org, exclude): subscriptions.seats, else the active full seats other than `exclude` (null
--   = none excluded). Internal, no client grants; called by the security definer quota functions below.
--   Mirrored by paidSeatCount() in src/lib/plan-keys.ts.
-- * app.view_seat_cap (body of 020325) calls it.
-- * app.booking_pages_quota (body of 020080, CAL-10): max_booking_pages + max_booking_pages_per_user x paid seats.
-- Not changed: max_business_cards_per_user is a cap per person (one card per rep), not multiplied by seats; the AI
-- credit keys have no quota code yet. Overrides keep working through app.org_limit. Pages or seats already over an
-- allowance stay; only a new one is refused.
-- Every statement is safe to run twice. No drops, no row changes.

create or replace function app.paid_seat_count(p_org uuid, p_exclude uuid default null) returns integer
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_seats integer;
begin
  -- the full seats bought in the subscription
  select s.seats into v_seats from public.subscriptions s where s.organization_id = p_org;
  if v_seats is null then
    -- not limited by purchase (trial): the active full seats
    select count(*) into v_seats
      from public.memberships m
     where m.organization_id = p_org and m.status = 'active' and m.seat_type = 'full'
       and m.id is distinct from p_exclude;
  end if;
  return v_seats;
end;
$$;
revoke all on function app.paid_seat_count(uuid, uuid) from public, anon, authenticated;

-- body of 020325, with the count from app.paid_seat_count
create or replace function app.view_seat_cap(p_org uuid, p_exclude uuid) returns integer
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_per numeric := app.org_limit(p_org, 'view_seats_per_paid_seat');
begin
  if v_per is null then
    return null;
  end if;
  -- with seats bought, `p_exclude` does not matter: making a full member a viewer does not change what was bought
  return floor(v_per * app.paid_seat_count(p_org, p_exclude))::integer;
end;
$$;
revoke all on function app.view_seat_cap(uuid, uuid) from public, anon, authenticated;

-- body of 020080 (CAL-10), with the paid seats from app.paid_seat_count
create or replace function app.booking_pages_quota() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_base numeric;
  v_per_user numeric;
  v_seats integer;
  v_cap numeric;
begin
  -- an outsider is refused by RLS (plain 42501) right after; answering here would tell about the business
  if auth.uid() is not null and not app.can_write(new.organization_id) then
    return new;
  end if;
  if not app.org_has_feature(new.organization_id, 'booking_page') then
    raise exception 'booking pages are not in the plan' using errcode = 'P0001', hint = 'feature:booking_page';
  end if;
  v_base := app.org_limit(new.organization_id, 'max_booking_pages');
  v_per_user := app.org_limit(new.organization_id, 'max_booking_pages_per_user');
  -- a null (unlimited) value of either key is unlimited, like the other quotas
  if v_base is null or v_per_user is null then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('booking_pages:' || new.organization_id::text, 0));
  v_seats := app.paid_seat_count(new.organization_id);
  v_cap := coalesce(v_base, 0) + coalesce(v_per_user, 0) * v_seats;
  if (select count(*) from public.booking_pages b where b.organization_id = new.organization_id)
     >= v_cap then
    raise exception 'booking page limit reached' using errcode = 'P0001', hint = 'limit:max_booking_pages';
  end if;
  return new;
end;
$$;
revoke all on function app.booking_pages_quota() from public, anon, authenticated;
