-- =============================================================================
-- ADM-01 / OPS-05: Functional Software, Inc. (Sentry) joins the subprocessors list (owner, 18 November 2026)
-- =============================================================================
-- Error monitoring (OPS-05, owner's approval of 18 November 2026; EU region, data stored in Germany): Sentry receives only
-- technical error details (the error, the route, the request id) and the ids of the user and the business, never contact
-- details, headers, cookies, a request body or a public link's token (src/lib/monitoring/sentry-rules.ts). The entry starts
-- on 2 December 2026 in Israel, or 14 days after the day this migration runs when that is later (the DPA's notice), and is
-- announced once to every business's active owners, through the same internal steps platform_add_subprocessor takes after
-- its platform check (as 021244 and 021286 did): app.subprocessor_input, app.subprocessor_notice_ok, the insert
-- (app.subprocessors_guard: a future day only), app.subprocessor_announce and one app.platform_log line (action
-- 'subprocessor.add', no actor). Owner (427) א: the code sends nothing before the day in SENTRY_ACTIVE_FROM, which the owner
-- sets to this entry's effective_from. The legal documents' wording does not change now (the lawyer's round). Safe to run
-- twice: nothing is added while a live entry with this name exists.
do $$
declare
  v_name constant text := 'Functional Software, Inc. (Sentry)';
  v_from date := greatest(date '2026-12-02', (now() at time zone 'Asia/Jerusalem')::date + 14);
  v jsonb;
  v_id uuid;
  v_sent integer;
begin
  if exists (select 1 from public.subprocessors s where s.name = v_name and s.cancelled_at is null) then
    return;
  end if;
  v := app.subprocessor_input(v_name, 'ניטור תקלות טכניות במערכת.',
                              'פרטי תקלות טכניות, מזהה משתמש ומזהה עסק, בלי פרטי קשר.', 'גרמניה', null, v_from);
  perform app.subprocessor_notice_ok(v_from);
  insert into public.subprocessors (name, purpose, data_categories, location, website, effective_from, created_at, updated_at)
  values (v->>'name', v->>'purpose', v->>'data_categories', v->>'location', v->>'website', v_from, now(), now())
  returning id into v_id;
  v_sent := app.subprocessor_announce(v_id);
  perform app.log_platform('subprocessor.add', null,
    v || jsonb_build_object('id', v_id, 'effective_from', v_from, 'notices', v_sent, 'by', 'migration OPS-05 Sentry'));
end;
$$;
