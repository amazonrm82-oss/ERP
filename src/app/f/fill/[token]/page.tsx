import type { Metadata } from "next";
import { headers } from "next/headers";

import { BrandScope } from "@/features/branding/components/brand-scope";
import { PublicBrandHeader, PublicPageFooter } from "@/features/branding/components/public-page";
import { logoPublicUrl } from "@/features/branding/logo";
import { isPreviewBotRequest } from "@/features/link-preview/bot-request";
import { PublicPrefillForm } from "@/features/prefill-links/components/public-prefill-form";
import { prefillSubmitPath } from "@/features/prefill-links/paths";
import { getPublicPrefill, PREFILL_MESSAGES } from "@/features/prefill-links/public-server";
import { PREFILL_PREVIEW, PREFILL_PAGE_TITLE } from "@/features/prefill-links/texts";
import { PublicPrivacyNotice } from "@/features/privacy-center/components/public-privacy-notice";
import { clientIp } from "@/lib/keyed-ip-hash";
import { genericPreview } from "@/lib/link-preview";
import { guardPublicPage } from "@/lib/public-sender-server";

type Props = { params: Promise<{ token: string }> };

/**
 * WAB-05 for BIZ-05: the link's preview is always the generic one, for people and bots alike, so the metadata never reads the
 * page (a read counts a call) and never names the business or the person. Not for search engines, and the secret address
 * never leaves in a Referer header.
 */
export async function generateMetadata(): Promise<Metadata> {
  return { ...genericPreview(PREFILL_PREVIEW.what, PREFILL_PREVIEW.description), referrer: "no-referrer" };
}

/**
 * BIZ-05: a form that fills the details the business already holds about the person (an intake questionnaire, details before
 * a meeting), sent by a personal link: no sign-in and no cookies. The answers go into the record's fields and its timeline.
 */
export default async function PublicPrefillPage({ params }: Props) {
  const { token } = await params;
  // a listed preview bot gets one line, and the page is never read for it (nothing counted, nothing shown)
  if (await isPreviewBotRequest()) {
    return (
      <main className="mx-auto min-h-dvh w-full max-w-md px-5 py-10 sm:py-16">
        <p className="text-md text-ink">{PREFILL_PREVIEW.what}</p>
      </main>
    );
  }
  // OPS-02: the shared per-sender limit of the secret-link pages first; a "not found" counts one miss
  const page = await guardPublicPage(async () => getPublicPrefill(token, clientIp(await headers())));

  if (typeof page === "string") {
    return (
      <main className="mx-auto min-h-dvh w-full max-w-md px-5 py-10 sm:py-16">
        <h1 className="sr-only">{PREFILL_PAGE_TITLE}</h1>
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {PREFILL_MESSAGES[page]}
        </p>
        <PublicPageFooter builtWith={false} />
      </main>
    );
  }

  if (page.status === "done") {
    return (
      <BrandScope color={page.color}>
        <main className="mx-auto min-h-dvh w-full max-w-md px-5 py-10 sm:py-16">
          <PublicBrandHeader logoUrl={logoPublicUrl(page.logoPath)} business={page.business} title={PREFILL_PAGE_TITLE} subtitle={page.business} />
          <p role="status" className="mt-6 rounded-md bg-success-soft px-4 py-3 text-md text-success">
            הפרטים כבר נשלחו בקישור הזה. תודה! אם תרצו לשנות משהו, פנו לעסק.
          </p>
          <PublicPageFooter builtWith={page.builtWith} className="mt-10" />
        </main>
      </BrandScope>
    );
  }

  return (
    // FLD-04 / DSN-17: the business's colour (corrected for contrast) on its own page
    <BrandScope color={page.color}>
      <main className="mx-auto min-h-dvh w-full max-w-md px-5 py-10 sm:py-16">
        <PublicBrandHeader logoUrl={logoPublicUrl(page.logoPath)} business={page.business} title={page.title} subtitle={page.business} />
        <div className="mt-6 space-y-5">
          {page.intro ? <p className="text-md whitespace-pre-line break-words">{page.intro}</p> : null}
          <PublicPrefillForm submitPath={prefillSubmitPath(token)} fields={page.fields} />
          <PublicPrivacyNotice contact={page.notice} className="text-sm leading-relaxed text-ink-soft" />
        </div>
        <PublicPageFooter builtWith={page.builtWith} className="mt-10" />
      </main>
    </BrandScope>
  );
}
