# Handoff: putting the email sender (EML-01) and quiet hours (USR-11) live

For the lead session that has the Supabase and Vercel connectors. Written 13 November 2026. Follow CLAUDE.md
(hard rule 3, "Migrations", "Parallel work" step 5) for every step; this file only lists what is specific.

## State when this was written

- Branch `claude/blissful-thompson-giftdn` holds, on top of `main` (3ef596e1):
  - docs commits (021271 / 021273 pastes, Resend settings, this file);
  - EML-01, three commits: the sender, review fixes, run-time and link fixes. Migration `20261006021275_email_compose.sql`;
  - USR-11 (quiet hours), when merged: migration `20261006021276_notification_quiet_hours.sql`.
- Independent reviews: EML-01 one full review and two delta reviews, no open finding above low (two lows accepted:
  the lease is measured from the app's clock after the claim; findings 5 and 6 of the first review, consistent with SMS).
  USR-11 one full review, its six lows being fixed (check the branch log for "USR-11: review fixes").
- Local checks on EML-01's first two commits: lint, typecheck, unit 4,159, db 4,433, build, e2e all passed. Run them
  again on the final branch before applying (the lead check script with both migrations).
- Vercel (owner, 13 November 2026): `RESEND_API_KEY` and `RESEND_FROM=noreply@mexuzsystem.com` set in Production;
  Fluid Compute on, Pro plan (the jobs route has `maxDuration = 180`). `MESSAGING_PROVIDER_EMAIL` is NOT set yet.

## Steps in the new session

1. `get_project`: ref `eowuxxkiedpjrqvfqcgn`, name `CRM-Saas`. Read-only: confirm 021274 is the last applied migration
   and that `public.email_job_compose` / `app.quiet_hours_end` do not exist yet.
2. Read-only before 021276: the size of `public.notifications` (its new partial index is built without CONCURRENTLY,
   under a SHARE lock; fine for a small table, otherwise ask the owner first).
3. Apply `20261006021275_email_compose.sql` with `apply_migration` (exact file content; name = file name without `.sql`).
   It is large: if it is too big for one call, use the courier subagent (CLAUDE.md, "Courier for a large migration";
   the owner approved the courier on 4 November 2026 for files too large to send oneself).
4. Verify 021275: md5 of `app.email_compose_core`, `public.email_job_compose`, `public.email_quota_return`,
   `app.email_usage_give_back` and the helpers against the local stack
   (`md5(replace(pg_get_functiondef(oid), chr(13), ''))`); grants (service_role only on the two public functions, none on
   the app ones); column `app.jobs.email_counted_on`.
5. Apply and verify `20261006021276_notification_quiet_hours.sql` the same way: `public.claim_push_notifications`,
   `app.dispatch_push`, `app.apply_notification_settings`, `public.set_notification_settings` (five arguments; the old one
   retired as `app.set_notification_settings_021276_retired` with no grants), `app.quiet_hours_end`; columns and index.
6. `get_advisors` (security), compare with `/home/user/.advisors-baseline.txt`; report anything new.
7. Merge to `main` only after CI is green on the branch (`git push origin <sha>:refs/heads/main`, origin/main an
   ancestor). Wait for CI on `main` and for `promote` to move `production`; check the Vercel deployment is Ready.
8. Update CLAUDE.md: the "In use (EML-01 sender …)" line in hard rule 5 (draft in the worker's report: Resend adapter the
   only reader of `RESEND_API_KEY|RESEND_FROM`, composer `public.email_job_compose` / `email_quota_return`, md5 pins in
   test 367); note that `consent_preference_link_for_job`, `meeting_reminder_link` and the signature link have the email
   composer as a second caller; that `claim_push_notifications` and `app.dispatch_push` were last redefined in 021276 and
   `set_notification_settings` has the five-argument signature. Mark EML-01 and USR-11 (first part) in BACKLOG.md.
9. Tell the owner, in Hebrew and in these words: "השולח באוויר, אפשר להוסיף MESSAGING_PROVIDER_EMAIL". He sets
   `MESSAGING_PROVIDER_EMAIL=resend` in Production and redeploys.
10. One test send after the redeploy: in a business the owner chooses, send one email from a contact card to the owner's
    own address (a service template, no attachment). Check: the job ends `sent` in `public.messages` (read-only query, ids
    and status only), the email arrives, the From is `"<business name>" <noreply@mexuzsystem.com>`, reply-to is the
    sender's address, Hebrew shows right to left. Then one marketing template to the same address with a recorded consent:
    "פרסומת:" in the subject, the sender and unsubscribe lines, and the unsubscribe link opens `/f/unsub/<token>`.
    Look at the Vercel runtime logs of `/api/jobs/run` for errors (codes only, no addresses).

## Open owner questions to ask together, without a recommendation

- Quiet hours (USR-11): time zone (business / personal), days (every day / chosen days / separate rest-day window),
  a push held over 12 hours (send / drop / urgent only), changing the window while pushes are held (keep / release),
  which kinds are held (all but system / let urgent kinds through).
- EML-01: retry after Resend refuses the key (retry up to 5 times / end at once); an automation's email has no reply-to
  (keep / use the record owner's address); library files allowed on any card send (as (198) ב) – confirm.
- Function region `iad1` while the database is in Ireland: every database call crosses the Atlantic; moving functions
  to `dub1` (Dublin) is the owner's choice in Vercel.
