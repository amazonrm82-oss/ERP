-- =============================================================================
-- "Cancel after 90 days" leaves a suspension staff set by hand alone (RVW-24)
-- =============================================================================
-- RVW-24 (review of 15 October 2026): app.run_suspension_cancel (last 0173) counted every open suspension,
-- also one platform staff set with platform_set_org_status (for example while they look into something).
-- Like the trial end (app.trial_end_candidates, 0156), a business staff handled by hand is left out:
-- app.suspension_by_staff(org, suspended_at) is true when app.platform_assignments holds a hand assignment
-- (status, or plan / seats / trial) at or after the moment this suspension began. platform_set_org_status
-- marks the assignment in the same transaction that opens the suspension, so a hand suspension is always
-- covered; an automatic one (trial end) is covered only once staff touch the business during it.
-- Such a suspension stays until staff change the status: the run plans no cancel day for it, sends no
-- notice and never cancels it, and clears a cancel day planned before staff touched it (counted in
-- 'cleared_by_staff'). The switch stays OFF; nothing here turns it on.
-- app.run_suspension_cancel is the body of 0173 plus those lines. Safe to run twice.

create or replace function app.suspension_by_staff(p_org uuid, p_suspended_at timestamptz) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from app.platform_assignments pa
                  where pa.organization_id = p_org and pa.assigned_at >= p_suspended_at);
$$;
revoke all on function app.suspension_by_staff(uuid, timestamptz) from public, anon, authenticated, service_role;

create or replace function app.run_suspension_cancel(p_now timestamptz default now(), p_org uuid default null)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_enabled boolean;
  t record;
  v_tz text;
  v_at timestamptz;
  v_days integer;
  v_planned integer := 0;
  v_notices integer := 0;
  v_cancelled integer := 0;
  v_excluded integer := 0;
begin
  select st.enabled into v_enabled from app.suspension_cancel_settings st where st.id for share;
  if not coalesce(v_enabled, false) then
    return jsonb_build_object('enabled', false);
  end if;

  -- RVW-24: a suspension staff handle by hand gets no cancel day (one planned before is cleared)
  update app.org_suspensions s
     set cancel_at = null
   where s.ended_at is null and s.cancel_at is not null and s.cancelled_at is null
     and (p_org is null or s.organization_id = p_org)
     and app.suspension_by_staff(s.organization_id, s.suspended_at);
  get diagnostics v_excluded = row_count;

  for t in
    select s.*, o.timezone, o.name
      from app.org_suspensions s
      join public.organizations o on o.id = s.organization_id
     where s.ended_at is null
       and o.status = 'suspended'
       and o.deleted_at is null
       and (p_org is null or s.organization_id = p_org)
       -- RVW-24: a suspension platform staff set or touched by hand stays until staff change it
       and not app.suspension_by_staff(s.organization_id, s.suspended_at)
     order by s.id
     for update of s
  loop
    v_tz := coalesce(t.timezone, 'Asia/Jerusalem');
    if t.cancel_at is null then
      -- the start of the local day after 90 days of suspension, and at least 14 days from now
      v_at := app.trial_end_day_start(v_tz,
                (greatest(t.suspended_at + interval '90 days', p_now + interval '14 days') at time zone v_tz)::date + 1);
      update app.org_suspensions set cancel_at = v_at where id = t.id;
      t.cancel_at := v_at;
      v_planned := v_planned + 1;
    end if;

    if t.notice_3_at is not null and t.notice_3_at < t.cancel_at and p_now >= t.cancel_at then
      update app.org_suspensions set cancelled_at = p_now where id = t.id;
      -- the trigger ends the suspension as 'cancelled'; nothing is deleted
      update public.organizations set status = 'cancelled' where id = t.organization_id and status = 'suspended';
      perform app.log_platform('suspension.cancelled', t.organization_id, jsonb_build_object('suspended_at', t.suspended_at));
      v_cancelled := v_cancelled + 1;
    elsif t.notice_3_at is null and p_now >= t.cancel_at - interval '3 days' then
      -- late: the cancel day moves so it is still 3 local days away
      v_at := greatest(t.cancel_at, app.trial_end_day_start(v_tz, (p_now at time zone v_tz)::date + 3));
      v_days := (v_at at time zone v_tz)::date - (p_now at time zone v_tz)::date;
      perform app.owner_plan_notice(t.organization_id,
        'בעוד ' || v_days || ' ימים החשבון של ' || t.name
        || ' ייסגר, המידע יימחק והטפסים באתר יפסיקו לקלוט פניות. כדי להמשיך, חדשו את המנוי.');
      update app.org_suspensions
         set notice_3_at = p_now, cancel_at = v_at, notice_14_at = coalesce(notice_14_at, p_now)
       where id = t.id;
      v_notices := v_notices + 1;
    elsif t.notice_14_at is null and p_now >= t.cancel_at - interval '14 days' then
      v_days := (t.cancel_at at time zone v_tz)::date - (p_now at time zone v_tz)::date;
      perform app.owner_plan_notice(t.organization_id,
        'בעוד ' || v_days || ' ימים החשבון של ' || t.name
        || ' ייסגר, המידע יימחק והטפסים באתר יפסיקו לקלוט פניות. כדי להמשיך, חדשו את המנוי.');
      update app.org_suspensions set notice_14_at = p_now where id = t.id;
      v_notices := v_notices + 1;
    end if;
  end loop;

  return jsonb_build_object('enabled', true, 'planned', v_planned, 'notices', v_notices, 'cancelled', v_cancelled, 'cleared_by_staff', v_excluded);
end;
$$;
revoke all on function app.run_suspension_cancel(timestamptz, uuid) from public, anon, authenticated;
