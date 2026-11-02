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
 * - the public secret-link pages (owner's approved pattern: one service_role-only
 *   definer function per action that checks the token; no table access):
 *   - the personal calendar feed (src/features/calendar-feed/feed-server.ts):
 *     public.calendar_feed_events() only;
 *   - the booking page and the customer's booking link
 *     (src/features/booking/public-server.ts): public.booking_page_public(),
 *     booking_submit(), booking_manage_public(), booking_manage_cancel() and
 *     booking_manage_change() only;
 *   - the customer's quote page and its accept/decline
 *     (src/features/quotes/public-server.ts): public.quote_public(),
 *     quote_public_decide() and quote_public_version() only;
 *   - the customer's order page and its confirmation
 *     (src/features/orders/public-server.ts): public.order_public() and
 *     order_public_decide() only;
 *   - the customer's statement page (BAL-04)
 *     (src/features/statements/public-server.ts): public.statement_public() only;
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
