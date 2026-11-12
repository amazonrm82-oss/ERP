-- =============================================================================
-- The landing page's "notify me" addresses are deleted after 12 months (LND-13)
-- =============================================================================
-- Owner, 13 October 2026 (CLAUDE.md hard rule 5): an address left on the landing page is kept only for its one message
-- and at most 12 months. This file holds the only delete of app.landing_waitlist, so it is pasted by hand by the owner
-- in the SQL Editor (the connector stops on a delete statement). pg_cron crm-landing-waitlist-purge runs it nightly at
-- 02:51 UTC, at most 5,000 rows a night. Safe to run twice.

create or replace function app.purge_old_landing_waitlist() returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  with gone as (
    delete from app.landing_waitlist w
     where w.id in (select x.id from app.landing_waitlist x
                     where x.created_at < now() - interval '12 months'
                     order by x.created_at limit 5000)
    returning 1
  )
  select count(*) into v_n from gone;
  return v_n;
end;
$$;
revoke all on function app.purge_old_landing_waitlist() from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-landing-waitlist-purge', '51 2 * * *', 'select app.purge_old_landing_waitlist();');
  end if;
end;
$$;
