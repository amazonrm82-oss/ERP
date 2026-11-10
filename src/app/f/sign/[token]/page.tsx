import type { Metadata } from "next";
import { headers } from "next/headers";

import { NoteText } from "@/features/activities/components/note-text";
import { BrandScope } from "@/features/branding/components/brand-scope";
import { PublicBrandHeader, PublicPageFooter } from "@/features/branding/components/public-page";
import { logoPublicUrl } from "@/features/branding/logo";
import { isPreviewBotRequest } from "@/features/link-preview/bot-request";
import { SignPanel } from "@/features/signatures/components/sign-panel";
import { publicSignaturePdfPath, signatureDateText } from "@/features/signatures/public";
import { getPublicSignature } from "@/features/signatures/public-server";
import { TEXT_ERASED_LINE } from "@/features/signatures/states";
import { clientIp } from "@/lib/keyed-ip-hash";
import { genericPreview } from "@/lib/link-preview";
import { RATE_LIMITED_PAGE_TEXT } from "@/lib/public-rate-limit";
import { guardPublicPage } from "@/lib/public-sender-server";

type Props = { params: Promise<{ token: string }> };

const DESCRIPTION = "מסמך לקריאה ולחתימה מהטלפון";

// SGN-02: the link's preview names nothing (no business, no customer, no title) and reads nothing, so a preview never counts
// as a view; not for search engines, and the secret address never leaves in a Referer header
export const metadata: Metadata = { ...genericPreview("מסמך לחתימה", DESCRIPTION), referrer: "no-referrer" };

const MESSAGES = {
  "not-found": "המסמך לא נמצא, או שהקישור כבר לא בתוקף. לקבלת קישור חדש פנו לעסק ששלח אותו.",
  "rate-limited": RATE_LIMITED_PAGE_TEXT,
  "not-configured": "המסמך אינו זמין כרגע.",
} as const;

const STATE_TEXT = {
  cancelled: "העסק ביטל את המסמך הזה.",
  expired: "תוקף הקישור לחתימה הסתיים.",
} as const;

/**
 * SGN-02 (owner, 9 November 2026, answer (191) א): a document filled from a template and sent from a record, as its customer
 * sees it through its secret link. No sign-in and no cookies; only what the page shows. The customer reads it and signs; a
 * cancelled or expired document shows only its state.
 */
export default async function PublicSignaturePage({ params }: Props) {
  const { token } = await params;
  // a listed preview bot reads nothing and counts nothing
  if (await isPreviewBotRequest()) {
    return (
      <main className="mx-auto min-h-dvh w-full max-w-md px-5 py-10 sm:py-16">
        <p className="text-md text-ink">{DESCRIPTION}</p>
      </main>
    );
  }
  // OPS-02: the shared per-sender limit of the secret-link pages first; a "not found" answer counts as one miss
  const page = await guardPublicPage(async () => getPublicSignature(token, clientIp(await headers())));

  if (typeof page === "string") {
    return (
      <main className="mx-auto min-h-dvh w-full max-w-md px-5 py-10 sm:py-16">
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {MESSAGES[page]}
        </p>
        <PublicPageFooter builtWith={false} />
      </main>
    );
  }

  if ("statusPage" in page) {
    return (
      <BrandScope color={page.color}>
        <main className="mx-auto min-h-dvh w-full max-w-md space-y-4 px-5 py-10 sm:py-16">
          <PublicBrandHeader logoUrl={logoPublicUrl(page.logoPath)} business={page.business} title={page.title} subtitle={<bdi>{page.business}</bdi>} />
          <p role="status" className="rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
            {STATE_TEXT[page.state]}
          </p>
          <p className="text-sm text-ink">
            לפרטים פנו אל <bdi>{page.business}</bdi>
            {page.phone ? (
              <>
                {" "}
                בטלפון{" "}
                <a href={`tel:${page.phone.replace(/[^\d+]/g, "")}`} dir="ltr" className="font-medium text-accent-strong underline-offset-4 hover:underline">
                  {page.phone}
                </a>
              </>
            ) : null}
            .
          </p>
          <PublicPageFooter builtWith={false} />
        </main>
      </BrandScope>
    );
  }

  return (
    // DSN-17: the whole page in the business's colour
    <BrandScope color={page.color}>
      <main className="mx-auto min-h-dvh w-full max-w-3xl space-y-4 px-4 py-6 sm:px-6 sm:py-10">
        <PublicBrandHeader logoUrl={logoPublicUrl(page.logoPath)} business={page.business} title={page.title} subtitle={<bdi>{page.business}</bdi>} />
        {page.status === "signed" ? (
          <p role="status" className="rounded-md bg-success-soft px-3 py-2.5 text-sm text-success">
            {page.signedAt ? `חתמת על המסמך ב-${signatureDateText(page.signedAt, page.timeZone)}.` : "המסמך נחתם."}{" "}
            {/* (223) ב: the signed PDF, through the link it was signed with (it may take a moment to be made) */}
            <a href={publicSignaturePdfPath(token)} className="font-medium underline">
              הורדת המסמך החתום (PDF)
            </a>
          </p>
        ) : page.expiresAt ? (
          <p className="text-sm text-ink-soft">{`אפשר לחתום עד ${signatureDateText(page.expiresAt, page.timeZone)}.`}</p>
        ) : null}
        {page.status === "signed" && page.textErased ? <p className="text-sm text-ink-soft">{TEXT_ERASED_LINE}</p> : null}
        <article className="rounded-lg border border-line bg-surface p-4 sm:p-6">
          <NoteText text={page.body} className="text-md text-ink" />
        </article>
        {page.fingerprint ? <SignPanel token={token} fingerprint={page.fingerprint} /> : null}
        <PublicPageFooter builtWith={page.builtWith} />
      </main>
    </BrandScope>
  );
}
