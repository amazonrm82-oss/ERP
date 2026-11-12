import type { Metadata } from "next";
import { headers } from "next/headers";

import { BrandScope } from "@/features/branding/components/brand-scope";
import { PublicBrandHeader, PublicPageFooter } from "@/features/branding/components/public-page";
import { logoPublicUrl } from "@/features/branding/logo";
import { PublicPrivacyForm } from "@/features/privacy-requests/components/public-privacy-form";
import { PublicPrivacyNotice } from "@/features/privacy-center/components/public-privacy-notice";
import { PUBLIC_TEXTS } from "@/features/privacy-requests/model";
import { getPrivacyPage } from "@/features/privacy-requests/public-server";
import { clientIp } from "@/lib/keyed-ip-hash";
import { RATE_LIMITED_PAGE_TEXT } from "@/lib/public-rate-limit";

type Props = { params: Promise<{ token: string }> };

/** PRK-02: a plain title for every visitor; never indexed, and the secret address never leaves in a Referer header. */
export const metadata: Metadata = {
  title: PUBLIC_TEXTS.title,
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

const MESSAGES = {
  "not-found": "הדף לא נמצא או שאינו פעיל. לקבלת קישור פנו לעסק.",
  "rate-limited": RATE_LIMITED_PAGE_TEXT,
  "not-configured": "הדף אינו זמין כרגע.",
} as const;

/**
 * PRK-02: the business's public privacy-request page (a link the business puts in its privacy notice). No sign-in and no
 * cookies; it shows only the business's name and brand, asks for the request type, a name, one way to reach the person and
 * text, and answers the same whatever the business holds.
 */
export default async function PublicPrivacyPage({ params }: Props) {
  const { token } = await params;
  const page = await getPrivacyPage(token, clientIp(await headers()));

  if (typeof page === "string") {
    return (
      <main className="mx-auto min-h-dvh w-full max-w-md px-5 py-10 sm:py-16">
        <h1 className="sr-only">{PUBLIC_TEXTS.title}</h1>
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {MESSAGES[page]}
        </p>
        <PublicPageFooter builtWith={false} />
      </main>
    );
  }

  return (
    // FLD-04 / DSN-17: the business's colour (corrected for contrast) on its own page
    <BrandScope color={page.color}>
      <main className="mx-auto min-h-dvh w-full max-w-md px-5 py-10 sm:py-16">
        <PublicBrandHeader logoUrl={logoPublicUrl(page.logoPath)} business={page.business} title={PUBLIC_TEXTS.title} subtitle={page.business} />
        <p className="mt-3 text-md">{PUBLIC_TEXTS.intro}</p>
        <div className="mt-6">
          <PublicPrivacyForm token={token} />
        </div>
        {/* LEGAL-2 (4): the privacy notice (section 11); this form is the way to reach the business */}
        <PublicPrivacyNotice contact={{ business: page.business, email: null, phone: null }} />
        <p className="mt-6 text-sm text-ink-soft">{PUBLIC_TEXTS.draft}</p>
        <PublicPageFooter builtWith={page.builtWith} />
      </main>
    </BrandScope>
  );
}
