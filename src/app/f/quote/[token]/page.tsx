import "@/features/print/print.css";

import type { Metadata } from "next";

import { AccessibilityLink } from "@/components/accessibility-link";
import { logoPublicUrl } from "@/features/branding/logo";
import { BuiltWithLine } from "@/features/built-with/components/built-with-line";
import { PrintButton } from "@/features/print/components/print-button";
import { QuoteDocument } from "@/features/quotes/components/quote-document";
import { getPublicQuote } from "@/features/quotes/public-server";

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
 * what the quote's own document shows (QUO-05), in the business's design and colour. Approving, declining, choosing
 * optional lines and asking a question come next.
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

  return (
    <main className="mx-auto min-h-dvh w-full max-w-4xl space-y-4 px-4 py-6 sm:px-6 sm:py-10">
      {/* data-print-page: print.css leaves only the document on paper */}
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
        }}
      />
      <div className="print:hidden">
        {page.builtWith ? <BuiltWithLine /> : null}
        <AccessibilityLink />
      </div>
    </main>
  );
}
