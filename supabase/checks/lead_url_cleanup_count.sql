-- READ ONLY. Count of leads whose stored referrer / landing address still holds old parameters (CAP-02).
-- Owner, 15 October 2026 (DECISIONS.md): the cleanup is NOT applied. Run this count first; only if it returns
-- total > 0, report the number to the owner and wait for his go-ahead, then turn
-- supabase/checks/lead_url_cleanup.draft.sql into a new migration (it is not one now, so nothing applies it).
-- On 15 October 2026 the hosted count was 0 of 9 leads.
-- CAP-02, read only: how many leads migration 20261006019900_lead_url_cleanup would change,
-- in all organizations, split into referrer only, landing address only, and both.
-- Run it on the hosted database BEFORE applying the migration and report the numbers to the owner.
-- The two predicates are exactly the migration's (tests/db/99-lead-url-cleanup checks it).
with marked as (
  select
    (app.site_and_path_url(l.referrer_url) is distinct from l.referrer_url
     and char_length(app.site_and_path_url(l.referrer_url)) <= 2000
     and app.site_and_path_url(l.referrer_url) ~* '^https?://[^[:space:][:cntrl:]]+$') as referrer,
    (app.campaign_only_url(l.landing_url) is distinct from l.landing_url
     and char_length(app.campaign_only_url(l.landing_url)) <= 2000
     and app.campaign_only_url(l.landing_url) ~* '^https?://[^[:space:][:cntrl:]]+$') as landing
  from public.leads l
)
select
  count(*) filter (where referrer and not landing) as referrer_only,
  count(*) filter (where landing and not referrer) as landing_only,
  count(*) filter (where referrer and landing) as both,
  count(*) filter (where referrer or landing) as total
from marked;
