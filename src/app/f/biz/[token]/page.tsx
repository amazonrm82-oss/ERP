import type { Metadata } from "next";
import { headers } from "next/headers";
import { cache } from "react";

import { buttonClasses } from "@/components/ui/button";
import { CalendarIcon, ChatIcon, PhoneIcon } from "@/components/ui/icons";
import { BrandScope } from "@/features/branding/components/brand-scope";
import { PublicBrandHeader, PublicPageFooter } from "@/features/branding/components/public-page";
import { logoPublicUrl } from "@/features/branding/logo";
import { publicBookingPath } from "@/features/booking/paths";
import { businessPageSubmitPath } from "@/features/business-page/paths";
import { websiteLabel } from "@/features/business-page/public";
import { getPublicBusinessPage } from "@/features/business-page/public-server";
import { PublicCardForm } from "@/features/business-cards/components/public-card-form";
import { PublicPrivacyNotice } from "@/features/privacy-center/components/public-privacy-notice";
import { BotPreviewPage } from "@/features/link-preview/components/bot-preview-page";
import { botPreviewMetadata } from "@/features/link-preview/bot-preview";
import { isPreviewBotRequest, loadBotPreview } from "@/features/link-preview/bot-request";
import { clientIp } from "@/lib/keyed-ip-hash";
import { businessPreview, genericPreview, PREVIEW_TEXTS } from "@/lib/link-preview";
import { RATE_LIMITED_PAGE_TEXT } from "@/lib/public-rate-limit";

type Props = { params: Promise<{ token: string }> };

// WAB-05: the link's preview and the page share ONE read per request (business_page_public counts a view)
const loadPage = cache(async (token: string) => getPublicBusinessPage(token, clientIp(await headers())));

/** WAB-05: the link's preview: the business's display name and logo. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  // a listed preview bot gets the display name and logo only; the page's own read (which counts a view) never runs for it
  if (await isPreviewBotRequest()) return botPreviewMetadata("page", await loadBotPreview("page", (await params).token));
  const page = await loadPage((await params).token);
  const t = PREVIEW_TEXTS.page;
  if (typeof page === "string") return genericPreview(t.what, t.description);
  return businessPreview({ what: t.what, joiner: t.joiner, business: page.business, logoUrl: logoPublicUrl(page.brand.logoPath), description: page.about ?? t.description });
}

const MESSAGES = {
  "not-found": "הדף לא נמצא או שאינו פעיל.",
  "rate-limited": RATE_LIMITED_PAGE_TEXT,
  "not-configured": "הדף אינו זמין כרגע.",
} as const;

/** BIZ-01: the business's public page. No sign-in, no cookies; only what the business chose to show. */
export default async function PublicBusinessPage({ params }: Props) {
  const { token } = await params;
  // a listed preview bot gets one line, and nothing of the page is read or counted
  if (await isPreviewBotRequest()) return <BotPreviewPage kind="page" state={await loadBotPreview("page", token)} />;
  const page = await loadPage(token);

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

  const logoUrl = logoPublicUrl(page.brand.logoPath);
  const hasContact = page.phone || page.whatsapp || page.website;
  return (
    // FLD-04 / DSN-17: the business's colour (corrected for contrast) on its own page
    <BrandScope color={page.brand.color}>
      <main className="mx-auto min-h-dvh w-full max-w-md px-5 py-10 sm:py-16">
        <PublicBrandHeader logoUrl={logoUrl} business={page.business} title={page.business} />
        {page.about ? <p className="mt-3 whitespace-pre-wrap break-words">{page.about}</p> : null}

        {hasContact ? (
          <ul className="mt-6 grid gap-2" aria-label="דרכים ליצירת קשר">
            {page.phone ? (
              <li>
                <a href={`tel:${page.phone.replace(/[^\d+]/g, "")}`} className={buttonClasses("secondary", "md", "w-full justify-start")}>
                  <PhoneIcon className="size-4.5" aria-hidden="true" />
                  <span>
                    חיוג <span dir="ltr">{page.phone}</span>
                  </span>
                </a>
              </li>
            ) : null}
            {page.whatsapp ? (
              <li>
                <a href={`https://wa.me/${page.whatsapp}`} target="_blank" rel="noopener noreferrer" className={buttonClasses("secondary", "md", "w-full justify-start")}>
                  <ChatIcon className="size-4.5" aria-hidden="true" />
                  <span>הודעה ב-WhatsApp</span>
                  <span className="sr-only"> (נפתח בחלון חדש)</span>
                </a>
              </li>
            ) : null}
            {page.website ? (
              <li>
                <a href={page.website} target="_blank" rel="noopener noreferrer" className={buttonClasses("secondary", "md", "w-full justify-start")}>
                  <span>
                    לאתר <span dir="ltr" className="break-all">{websiteLabel(page.website)}</span>
                  </span>
                  <span className="sr-only"> (נפתח בחלון חדש)</span>
                </a>
              </li>
            ) : null}
          </ul>
        ) : null}

        {page.booking.length > 0 ? (
          <section aria-labelledby="biz-booking" className="mt-8 space-y-3">
            <h2 id="biz-booking" className="text-lead font-semibold">
              קביעת תור
            </h2>
            <ul className="grid gap-2">
              {page.booking.map((b) => (
                <li key={b.token}>
                  <a href={publicBookingPath(b.token)} className={buttonClasses("primary", "md", "w-full justify-start")}>
                    <CalendarIcon className="size-4.5" aria-hidden="true" />
                    <span className="min-w-0 break-words">{b.title}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {page.hours ? (
          <section aria-labelledby="biz-hours" className="mt-8 space-y-3">
            <h2 id="biz-hours" className="text-lead font-semibold">
              שעות פעילות
            </h2>
            <dl className="divide-y divide-line rounded-lg border border-line bg-surface">
              {page.hours.map((d) => (
                <div key={d.day} className="flex items-baseline justify-between gap-3 px-4 py-2.5">
                  <dt className="font-medium">{d.day}</dt>
                  <dd className="text-end text-ink-soft">
                    {d.ranges.length > 0 ? (
                      <span dir="ltr">{d.ranges.join(", ")}</span>
                    ) : (
                      "סגור"
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}

        {page.form ? (
          <section aria-labelledby="biz-form" className="mt-8 space-y-4">
            <h2 id="biz-form" className="text-lead font-semibold">
              צרו קשר
            </h2>
            <PublicCardForm token={token} rep={page.business} submitPath={businessPageSubmitPath(token)} doneLine="נחזור אליכם בהקדם." />
            {/* LEGAL-2 (4): the privacy notice (section 11); the phone only when the page shows it */}
            <PublicPrivacyNotice contact={{ business: page.business, email: null, phone: page.phone }} className="text-sm leading-relaxed text-ink-soft" />
          </section>
        ) : null}
        <PublicPageFooter builtWith={page.builtWith} />
      </main>
    </BrandScope>
  );
}
