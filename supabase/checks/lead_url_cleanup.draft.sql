-- DRAFT, NOT A MIGRATION (CAP-02, owner 15 October 2026). Built and tested on branch lane/c-cap02clean (commit c040a0f,
-- test 99-lead-url-cleanup) but not merged, because no hosted lead needed it. Use only after
-- supabase/checks/lead_url_cleanup_count.sql returns more than 0 and the owner approves: copy it into a new migration
-- with the next number and bring back its database test.
-- =============================================================================
-- 0199 Clean the referrer and landing addresses already stored on leads (CAP-02)
-- =============================================================================
-- Owner, 14 October 2026: the old parameters in existing leads are cleaned the way
-- new leads are stored since migrations 0092, 0098 and 009810 (intake_attribution):
-- * leads.referrer_url keeps site and path only: app.site_and_path_url();
-- * leads.landing_url keeps only the allowed campaign keys: app.campaign_only_url().
-- A value changes only when the cleaned one differs AND passes the rule intake applies
-- to a stored address (at most 2,000 characters, http(s), no spaces or control
-- characters). Anything else (null, already clean, a cleaned value intake would not
-- keep) is left exactly as it is, so the update is safe and a second run changes 0 rows.
-- The same predicate is in supabase/checks/20261006019900_lead_url_cleanup_count.sql,
-- the read-only count to run before applying (tests/db/99-lead-url-cleanup keeps the
-- two equal).
--
-- Side effects. The row triggers of public.leads that fire on any UPDATE are switched
-- off for this one statement, inside one DO block (atomic: on any error everything,
-- the switch included, rolls back), as migration 0087 did for profiles:
--   leads_audit (it would copy the old address, the very thing being removed, into
--   audit_log), leads_emit (an outbox event, and "lead updated" automations),
--   leads_touch (updated_at), leads_touch_contact_stamp, leads_normalize (it would
--   re-normalize phone and email of old rows) and leads_zz_score (no rule reads these
--   columns). Every trigger limited to other columns does not fire. So the only change
--   is the two columns. While the block runs, writes to leads wait (the trigger switch
--   takes a SHARE ROW EXCLUSIVE lock); lock_timeout 5s gives up instead of queueing.
-- Not touched here (reported as follow-ups): the addresses inside audit_log entries
-- written when those leads were created, activities.metadata.attribution of repeat
-- inquiries, and form_submissions.payload.
-- No delete, no drop. Safe to run twice.

do $$
declare
  v_changed integer;
begin
  perform set_config('lock_timeout', '5s', true);
  alter table public.leads disable trigger leads_audit;
  alter table public.leads disable trigger leads_emit;
  alter table public.leads disable trigger leads_touch;
  alter table public.leads disable trigger leads_touch_contact_stamp;
  alter table public.leads disable trigger leads_normalize;
  alter table public.leads disable trigger leads_zz_score;

  update public.leads l
     set referrer_url = case
           when app.site_and_path_url(l.referrer_url) is distinct from l.referrer_url
            and char_length(app.site_and_path_url(l.referrer_url)) <= 2000
            and app.site_and_path_url(l.referrer_url) ~* '^https?://[^[:space:][:cntrl:]]+$'
           then app.site_and_path_url(l.referrer_url) else l.referrer_url end,
         landing_url = case
           when app.campaign_only_url(l.landing_url) is distinct from l.landing_url
            and char_length(app.campaign_only_url(l.landing_url)) <= 2000
            and app.campaign_only_url(l.landing_url) ~* '^https?://[^[:space:][:cntrl:]]+$'
           then app.campaign_only_url(l.landing_url) else l.landing_url end
   where (app.site_and_path_url(l.referrer_url) is distinct from l.referrer_url
          and char_length(app.site_and_path_url(l.referrer_url)) <= 2000
          and app.site_and_path_url(l.referrer_url) ~* '^https?://[^[:space:][:cntrl:]]+$')
      or (app.campaign_only_url(l.landing_url) is distinct from l.landing_url
          and char_length(app.campaign_only_url(l.landing_url)) <= 2000
          and app.campaign_only_url(l.landing_url) ~* '^https?://[^[:space:][:cntrl:]]+$');
  get diagnostics v_changed = row_count;

  alter table public.leads enable trigger leads_audit;
  alter table public.leads enable trigger leads_emit;
  alter table public.leads enable trigger leads_touch;
  alter table public.leads enable trigger leads_touch_contact_stamp;
  alter table public.leads enable trigger leads_normalize;
  alter table public.leads enable trigger leads_zz_score;

  raise notice 'lead address cleanup (CAP-02): % leads changed', v_changed;
end;
$$;
