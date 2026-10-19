-- =============================================================================
-- The owner's wording of the notices before a suspended business is cancelled (RVW-24)
-- =============================================================================
-- Owner, 19 October 2026 (DECISIONS.md, answer (א)): the 14-day and 3-day notices no longer say the data
-- will be deleted (nothing is deleted; deletion comes with the billing module, and the wording with it).
-- They read exactly: "הגישה לעסק סגורה. בעוד [N] ימים המנוי יבוטל. לחידוש: בחירת חבילה ותשלום. אפשר
-- להוריד את הנתונים שלכם בכל עת." with N the local days left, as before.
-- app.run_suspension_cancel is the body of 20261006020575 (RVW-24) with only the two texts changed.
-- The switch stays OFF. Safe to run twice.

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
        'הגישה לעסק סגורה. בעוד ' || v_days
        || ' ימים המנוי יבוטל. לחידוש: בחירת חבילה ותשלום. אפשר להוריד את הנתונים שלכם בכל עת.');
      update app.org_suspensions
         set notice_3_at = p_now, cancel_at = v_at, notice_14_at = coalesce(notice_14_at, p_now)
       where id = t.id;
      v_notices := v_notices + 1;
    elsif t.notice_14_at is null and p_now >= t.cancel_at - interval '14 days' then
      v_days := (t.cancel_at at time zone v_tz)::date - (p_now at time zone v_tz)::date;
      perform app.owner_plan_notice(t.organization_id,
        'הגישה לעסק סגורה. בעוד ' || v_days
        || ' ימים המנוי יבוטל. לחידוש: בחירת חבילה ותשלום. אפשר להוריד את הנתונים שלכם בכל עת.');
      update app.org_suspensions set notice_14_at = p_now where id = t.id;
      v_notices := v_notices + 1;
    end if;
  end loop;

  return jsonb_build_object('enabled', true, 'planned', v_planned, 'notices', v_notices, 'cancelled', v_cancelled, 'cleared_by_staff', v_excluded);
end;
$$;
revoke all on function app.run_suspension_cancel(timestamptz, uuid) from public, anon, authenticated;
