import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { getSupabaseEnv } from "@/lib/env";

/**
 * Supabase client with the service-role key: bypasses Row Level Security.
 * Allowed only in the places listed in CLAUDE.md, hard rule 5, and in the
 * eslint allow-list (eslint.config.mjs; tests/unit/service-key-comment.test.ts
 * checks that every file of that list is named here). A new one is the owner's
 * decision. None of them acts for a signed-in user with the key, with one
 * approved exception (QUO-06, owner 26 October 2026): the server's write of a
 * quote's PDF, below.
 * - the lead intake (src/features/intake/server.ts and
 *   src/features/intake/public-form.ts), where a
 *   stranger's form submission arrives with no session. It only calls
 *   public.intake_submit() and reads a form's public settings by token
 *   (public.intake_form(); since OPS-02 a page view also hands over the
 *   visitor's keyed IP hash in the x-crm-sender header, so the function counts
 *   the view against the form's per-sender limit);
 * - the push dispatcher (src/features/notifications/push-server.ts), woken by
 *   the database with a shared secret. It calls public.claim_push_notifications()
 *   and reads and prunes push_subscriptions;
 * - the file cleanup (src/features/files/cleanup-server.ts), woken by the
 *   database at night with the same secret. It calls public.claim_orphan_objects()
 *   and public.finish_orphan_files(), and removes those objects only from the
 *   buckets in CLEANUP_BUCKETS: 'record-files' (files of deleted rows), 'avatars'
 *   (photos of deleted accounts and replaced photos) and 'org-logos' (replaced or
 *   cleared logos, and a deleted business's logo folder; never a logo in use);
 * - the background job worker (src/features/jobs/run-server.ts, route /api/jobs/run;
 *   OPS-04, the owner's wave 3 use (1) of 26 October 2026), woken by the database
 *   with the same secret. It calls only public.claim_jobs(), public.finish_job() and
 *   public.job_message_may_send() (the business, event time, HEB-09 pause and consent
 *   check of a message, answering no personal data; owner's conditions (52)-(55)); it
 *   registers message.send, through a provider (only the fake provider exists,
 *   which sends nothing), and, once the owner sets the JWT secret (IMP-04, owner (155) א,
 *   (160) א), import.run and export.run, for which it calls only
 *   public.background_job_begin(), public.background_job_token(),
 *   public.background_job_progress() and public.background_job_end(); the work itself
 *   runs under a short token for the ordering person, never with the service key;
 * - InforU's delivery reports and replies (src/features/inforu-callbacks/webhook-server.ts,
 *   routes /api/sms/inforu/status/<secret> and /api/sms/inforu/inbound/<secret>; SMS-05,
 *   owner (318) א, wave 3 use (2)): the client is made only after the secret in the path
 *   passed (timing-safe), and calls only public.sms_delivery_status() and
 *   public.sms_inbound_reply(); the OPS-04 worker also calls public.sms_job_compose() and
 *   public.sms_quota_return() (owner (326) ב) for the InforU sender;
 * - the Meta Lead Ads webhook and its sweep (src/features/meta-leads/webhook-server.ts,
 *   routes /api/meta/leads and /api/meta/leads/sweep; CAP-11, owner 4 November 2026,
 *   answer (126) א): the client is made only after the X-Hub-Signature-256 check (or the
 *   sweep's shared secret) passed, and calls only public.meta_lead_receive(),
 *   public.meta_lead_claim() (which answers the page token's ciphertext, decrypted on the
 *   server with PROVIDER_SECRETS_KEY for one Graph API call) and public.meta_lead_finish()
 *   (the lead through intake_submit);
 * - "test connection" of a Meta page with its stored token (src/features/integrations/test-server.ts;
 *   INT-01, owner 10 November 2026, answer (227) ב), inside an owner's or admin's request AFTER their own session
 *   was checked: it calls only public.integration_test_claim() (the person checked again, 5 tests per connection
 *   in 10 minutes, the ciphertext and page id of that one connection) and public.integration_test_finish()
 *   (only verified_at / last_error_code and one log line, under CAP-11's page-ownership rule);
 * - the public secret-link pages (owner's approved pattern: one service_role-only
 *   definer function per action that checks the token; no table access):
 *   - the personal calendar feed (src/features/calendar-feed/feed-server.ts):
 *     public.calendar_feed_events() only;
 *   - the booking page and the customer's booking link
 *     (src/features/booking/public-server.ts): public.booking_page_public(),
 *     booking_submit(), booking_manage_public(), booking_manage_cancel(),
 *     booking_manage_change() and (CAL-12, owner (177) ב) booking_manage_confirm() only;
 *   - the customer's quote page and its accept/decline
 *     (src/features/quotes/public-server.ts): public.quote_public(),
 *     quote_public_decide() and quote_public_version() only;
 *   - the customer's order page and its confirmation
 *     (src/features/orders/public-server.ts): public.order_public() and
 *     order_public_decide() only;
 *   - the customer's statement page (BAL-04)
 *     (src/features/statements/public-server.ts): public.statement_public() only;
 *   - the public business page (BIZ-01, owner 11 November 2026, answer (271) ב)
 *     (src/features/business-page/public-server.ts): public.business_page_public() and
 *     business_page_submit() only;
 *   - a library item sent by a tracked link (LIB-02, owner 11 November 2026)
 *     (src/features/library-links/public-server.ts): public.library_link_public() and
 *     library_link_public_file() only, and a 60-second signed link to the path the latter answers;
 *   - the public privacy-request page (PRK-02, owner 26 October 2026, wave 3 use (3))
 *     (src/features/privacy-requests/public-server.ts): public.privacy_request_page()
 *     and privacy_request_submit() only;
 *   - the customer's preferences page and unsubscribe link (CNS-09 / CNS-10, owner's answer (225) א)
 *     (src/features/preferences/public-server.ts): public.consent_preferences_public() and
 *     consent_preferences_submit() only;
 *   - a document for signature (SGN-02, owner 9 November 2026, answer (191) א)
 *     (src/features/signatures/public-server.ts): public.signature_public(),
 *     signature_public_sign() and, after signing, signature_public_pdf() only (owner (223) ב,
 *     bytes compared with the SHA-256 when served); its signed PDF (src/features/signatures/pdf-server.ts):
 *     public.signature_pdf_public(), signature_pdf_public_store() and signature_pdf_store()
 *     only, uploading only to the path they answer;
 *   - the QR scan (src/features/qr-codes/scan-server.ts): public.qr_scan() only;
 *   - the site widget (src/features/site-widgets/public-server.ts):
 *     public.site_widget_public() and site_widget_submit() only;
 *   - the digital business card (src/features/business-cards/public-server.ts):
 *     public.business_card_public() and business_card_submit() only;
 *   - the customer's PDF download of a quote (src/features/quotes/pdf-public-server.ts,
 *     route GET /api/forms/quote/<token>/pdf): public.quote_public_pdf() only, and
 *     downloads only the path it answers, compared with its SHA-256;
 *   - the customer's PDF download of an order (src/features/orders/pdf-public-server.ts,
 *     route GET /api/forms/order/<token>/pdf): public.order_public_pdf() only, and
 *     downloads only the path it answers, compared with its SHA-256 (ORD-05 PDF);
 *   - the public subprocessors page (src/features/legal/subprocessors-public-server.ts,
 *     page /legal/subprocessors): public.subprocessors_public_page() only, cached for an hour;
 *   - link previews for preview bots on the closed list of src/lib/preview-bots.ts
 *     (src/features/link-preview/preview-server.ts): public.link_preview_public()
 *     only (the business's display name and logo; no view counted, nothing changed);
 *   - the shared per-sender limit of the secret-link pages (OPS-02, owner's answers
 *     (40) ב and (42) ד, src/lib/public-sender-server.ts): public.public_sender_check()
 *     before the quote, order, statement and booking-manage pages and routes look their
 *     token up, and public.public_sender_miss() after they answered "not found" (the
 *     visitor's keyed IP hash, scope "public"); nothing else;
 * - the server's write of a quote's PDF (src/features/quotes/pdf-store-server.ts),
 *   one of the two uses inside a signed-in user's request (QUO-06 answer 3): called from
 *   pdf-server.ts (a Server Action and the staff file route) only after
 *   public.quote_pdf_allowed() or public.quote_pdf_remake_allowed() passed with
 *   the user's own session; it calls only
 *   public.quote_pdf_store(), which checks the named user again, and uploads
 *   (upsert off) only to the path that function answers;
 * - the server's write of an order's PDF (src/features/orders/pdf-store-server.ts), the
 *   same pattern (ORD-05 PDF, owner 1 November 2026): called from pdf-server.ts (Server
 *   Actions) only after public.order_pdf_allowed() passed with the user's own session; it
 *   calls only public.order_pdf_store() and uploads (upsert off) only to the path it answers;
 * - the signed PDF of an accepted quote (src/features/quotes/signed-pdf-server.ts; QUO-09,
 *   owner 1 November 2026, answers (3) א and (33) ב), the same pattern: the customer's decide
 *   route, after public.quote_public_answer() accepted, calls only
 *   public.quote_signed_pdf_public() and public.quote_signed_pdf_public_store() (the link's
 *   token is the right); staff's write, called from pdf-server.ts only after
 *   public.quote_signed_pdf_allowed() answered with the user's own session, calls only
 *   public.quote_signed_pdf_store(), which checks the named user again; both upload (upsert
 *   off) only to the path the function answers.
 * Never import this from any other code that serves a signed-in user.
 * Returns null when the key is not configured.
 */
export function createServiceClient(): SupabaseClient<Database> | null {
  const env = getSupabaseEnv();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!env || !key) {
    return null;
  }
  return createClient<Database>(env.url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
