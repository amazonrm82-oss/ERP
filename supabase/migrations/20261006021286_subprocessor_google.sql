-- =============================================================================
-- ADM-01: Google LLC joins the subprocessors list (owner's answer (390) א, 16 November 2026)
-- =============================================================================
-- Sign-in with a Google account (USR-10, owner (389), set up by the owner on 16 November 2026): Google receives only the
-- name, email and profile picture of a person who chose to sign in with Google. The entry starts 14 days after the day this
-- migration runs (in Israel), with the DPA's notice, and is announced once to every business's active owners, through the
-- same internal steps platform_add_subprocessor takes after its platform check (as LEGAL-2's 021244 did): app.subprocessor_input,
-- app.subprocessor_notice_ok, the insert (app.subprocessors_guard: a future day only), app.subprocessor_announce and one
-- app.platform_log line (action 'subprocessor.add', no actor). The legal documents' wording does not change now; the lawyer
-- adds a mention of sign-in with Google to the privacy policy in his round. Safe to run twice: nothing is added while a live
-- entry named Google LLC exists.
do $$
declare
  v_from date := (now() at time zone 'Asia/Jerusalem')::date + 14;
  v jsonb;
  v_id uuid;
  v_sent integer;
begin
  if exists (select 1 from public.subprocessors s where s.name = 'Google LLC' and s.cancelled_at is null) then
    return;
  end if;
  v := app.subprocessor_input('Google LLC', 'כניסה למערכת באמצעות חשבון Google.',
                              'שם, אימייל ותמונת פרופיל של משתמש שבחר בכך.', 'ארצות הברית', null, v_from);
  perform app.subprocessor_notice_ok(v_from);
  insert into public.subprocessors (name, purpose, data_categories, location, website, effective_from, created_at, updated_at)
  values (v->>'name', v->>'purpose', v->>'data_categories', v->>'location', v->>'website', v_from, now(), now())
  returning id into v_id;
  v_sent := app.subprocessor_announce(v_id);
  perform app.log_platform('subprocessor.add', null,
    v || jsonb_build_object('id', v_id, 'effective_from', v_from, 'notices', v_sent, 'by', 'migration ADM-01 (390)'));
end;
$$;
