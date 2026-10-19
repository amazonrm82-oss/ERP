import "@/features/print/print.css";

import type { Metadata } from "next";

import { AccessibilityLink } from "@/components/accessibility-link";
import { OrgLogo } from "@/features/branding/components/org-logo";
import { logoPublicUrl } from "@/features/branding/logo";
import { BuiltWithLine } from "@/features/built-with/components/built-with-line";
import { PrintButton } from "@/features/print/components/print-button";
import { QuoteDecisionPanel } from "@/features/quotes/components/quote-decision-panel";
import { QuoteDocument } from "@/features/quotes/components/quote-document";
import { STATUS_PAGE_TEXT } from "@/features/quotes/public";
import { getPublicQuote, getPublicQuoteFingerprint } from "@/features/quotes/public-server";
import { formatDate, formatMoney } from "@/lib/format";

// QUO-14: the page is not for search engines; and its secret address never leaves in a Referer header
export const metadata: Metadata = { title: "הצעת מחיר", robots: { index: false, follow: false }, referrer: "no-referrer" };

type Props = { params: Promise<{ token: string }> };

const MESSAGES = {
  "not-found": "ההצעה לא נמצאה, או שהקישור כבר לא בתוקף. לקבלת קישור חדש פנו לעסק ששלח אותו.",
  "rate-limited": "ההצעה נפתחה יותר מדי פעמים בזמן קצר. נסו שוב בעוד כמה דקות.",
  "not-configured": "ההצעה אינה זמינה כרגע.",
} as const;

/**
 * QUO-08 (viewing): a sent quote as its customer sees it, through its secret link. No sign-in and no cookies; only
 * what the quote's own document shows (QUO-05), in the business's design and colour. QUO-09: below it the customer
 * accepts and signs, or declines; once answered the page says so. Choosing optional lines and asking a question come next.
 */
export default async function PublicQuotePage({ params }: Props) {
  const { token } = await params;
  const page = await getPublicQuote(token);

  if (typeof page === "string") {
    return (
      <main className="mx-auto min-h-dvh w-full max-w-md px-5 py-10 sm:py-16">
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {MESSAGES[page]}
        </p>
        <AccessibilityLink />
      </main>
    );
  }

  // owner, 19 October 2026: the newest sent version is not open (accepted, declined, cancelled, expired): its state only, no
  // prices, lines or signing
  if ("statusPage" in page) {
    const logoUrl = logoPublicUrl(page.logoPath);
    return (
      <main className="mx-auto min-h-dvh w-full max-w-md space-y-4 px-5 py-10 sm:py-16">
        {logoUrl ? <OrgLogo url={logoUrl} alt={`הלוגו של ${page.business}`} className="h-12 max-w-40" /> : null}
        <h1 className="text-lg font-semibold">
          <bdi>{page.title}</bdi>
        </h1>
        {page.replaced ? (
          <p className="text-sm text-ink-soft">
            זו הגרסה החדשה של ההצעה
            {page.replaced.number ? (
              <>
                {" "}
                <span dir="ltr" className="tabular-nums">
                  {page.replaced.number}
                </span>
              </>
            ) : null}
            .
          </p>
        ) : null}
        <p role="status" className="rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
          {page.number ? (
            <>
              הצעה{" "}
              <span dir="ltr" className="tabular-nums">
                {page.number}
              </span>
              :{" "}
            </>
          ) : null}
          {STATUS_PAGE_TEXT[page.state]}
          {page.state === "expired" && page.validUntil ? <> היא הייתה בתוקף עד {formatDate(page.validUntil)}.</> : null}
        </p>
        {page.draftVersion ? (
          <p role="status" className="rounded-md bg-accent-soft px-3 py-2.5 text-sm text-accent-strong">
            גרסה מעודכנת בהכנה.
          </p>
        ) : null}
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
        <AccessibilityLink />
      </main>
    );
  }

  // QUO-09: the fingerprint of the version drawn, for an open quote only
  const fingerprint =
    page.quote.status === "sent" || page.quote.status === "viewed" ? await getPublicQuoteFingerprint(token, page.quote.numberDisplay) : null;

  return (
    <main className="mx-auto min-h-dvh w-full max-w-4xl space-y-4 px-4 py-6 sm:px-6 sm:py-10">
      {/* data-print-page: print.css leaves only the document on paper */}
      {/* QUO-12: the link was made for an earlier version; this page now shows the newer one */}
      {page.replaced ? (
        <p role="status" className="rounded-md bg-accent-soft px-3 py-2.5 text-sm text-accent-strong print:hidden">
          קיימת גרסה חדשה של ההצעה, והיא מוצגת כאן.
          {page.replaced.number ? (
            <>
              {" "}
              ההצעה{" "}
              <span dir="ltr" className="tabular-nums">
                {page.replaced.number}
              </span>{" "}
              הוחלפה בה.
            </>
          ) : null}
        </p>
      ) : null}
      {/* QUO-12 (owner, 19 October 2026): a newer version is being prepared; this one is still the one on offer */}
      {page.draftVersion ? (
        <p role="status" className="rounded-md bg-accent-soft px-3 py-2.5 text-sm text-accent-strong print:hidden">
          גרסה מעודכנת בהכנה.
        </p>
      ) : null}
      {/* owner, 19 October 2026: an accepted quote is shown in full, with the day it was accepted and no way to decide */}
      {page.quote.status === "accepted" ? (
        <p role="status" className="rounded-md bg-success-soft px-3 py-2.5 text-sm text-success">
          {page.acceptedOn ? <>אושרה ב-{formatDate(page.acceptedOn)}.</> : "ההצעה אושרה."}
        </p>
      ) : null}
      {/* GAP-10: this quote adds work to a quote the customer already accepted */}
      {page.addendumOf ? (
        <p className="rounded-md border border-line bg-surface px-3 py-2.5 text-sm text-ink">
          תוספת להצעה
          {page.addendumOf.number ? (
            <>
              {" "}
              <span dir="ltr" className="tabular-nums">
                {page.addendumOf.number}
              </span>
            </>
          ) : null}
          , שכבר אושרה.
        </p>
      ) : null}
      <div data-print-page="" className="flex justify-end print:hidden">
        <PrintButton label="הדפסה או שמירה כ-PDF" />
      </div>
      <QuoteDocument
        data={{
          design: page.design,
          color: page.color,
          logoUrl: logoPublicUrl(page.logoPath),
          business: page.business,
          customer: page.customer,
          quote: page.quote,
          lines: page.lines,
          schedule: page.schedule,
        }}
      />
      {/* GAP-10: the addenda the customer accepted on top of this quote */}
      {page.addenda.length > 0 ? (
        <section aria-labelledby="quote-addenda" className="rounded-lg border border-line bg-surface p-4 print:hidden sm:p-6">
          <h2 id="quote-addenda" className="mb-2 text-base font-semibold text-ink">
            תוספות שאושרו להצעה הזאת
          </h2>
          <ul className="divide-y divide-line text-sm">
            {page.addenda.map((a) => (
              <li key={a.key} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
                <span>
                  {a.number ? (
                    <span dir="ltr" className="tabular-nums">
                      {a.number}
                    </span>
                  ) : null}{" "}
                  <bdi>{a.title}</bdi>
                </span>
                <span className="tabular-nums text-ink">{formatMoney(a.totalAgorot)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {/* QUO-09: an open quote takes one answer, bound to the version shown (its fingerprint) */}
      {fingerprint ? (
        <QuoteDecisionPanel token={token} fingerprint={fingerprint} />
      ) : page.quote.status === "rejected" ? (
        <p role="status" className="rounded-md border border-line bg-surface px-3 py-2.5 text-sm text-ink-soft print:hidden">
          ההצעה נדחתה. אם משהו השתנה, אפשר לפנות לעסק ששלח אותה.
        </p>
      ) : null}
      <div className="print:hidden">
        {page.builtWith ? <BuiltWithLine /> : null}
        <AccessibilityLink />
      </div>
    </main>
  );
}
