-- =============================================================================
-- CAP-11: finished Meta lead arrivals are removed after 12 months (owner, 8 November 2026, answer (147) ב)
-- =============================================================================
-- PASTED BY HAND in the SQL Editor (the connector stops on a migration that holds a delete statement). Belongs to
-- _meta_lead_ads.sql, which makes app.meta_lead_arrivals. Nothing else in this file needs the connector: the whole file is
-- pasted, and every statement in it is safe to run twice.
--
-- app.purge_old_meta_lead_arrivals(): removes arrivals that ended (done, refused, given up) more than 12 months ago, at most
-- 10,000 a run, and answers how many. An arrival holds ids and codes only; the leads it made stay. A pending arrival is never
-- removed here (it is given up after 3 days by public.meta_lead_claim, then counts its 12 months from then). Once removed, a
-- webhook that repeats the same Meta lead id after more than a year would be taken again (accepted: Meta retries for days).
-- Security definer (it runs from pg_cron), search_path pinned, no client may call it.
-- pg_cron job crm-meta-lead-arrivals-purge runs it every night at 02:35 UTC.

create or replace function app.purge_old_meta_lead_arrivals() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from app.meta_lead_arrivals a
   where a.id in (select o.id from app.meta_lead_arrivals o
                   where o.status in ('done', 'refused', 'given_up')
                     and o.done_at is not null
                     and o.done_at < now() - interval '12 months'
                   order by o.done_at
                   limit 10000);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function app.purge_old_meta_lead_arrivals() from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-meta-lead-arrivals-purge', '35 2 * * *', 'select app.purge_old_meta_lead_arrivals();');
  end if;
end;
$$;
