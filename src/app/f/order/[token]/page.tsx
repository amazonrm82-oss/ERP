import "@/features/print/print.css";

import type { Metadata } from "next";
import { headers } from "next/headers";

import { AccessibilityLink } from "@/components/accessibility-link";
import { OrgLogo } from "@/features/branding/components/org-logo";
import { logoPublicUrl } from "@/features/branding/logo";
import { BuiltWithLine } from "@/features/built-with/components/built-with-line";
import { OrderDocument } from "@/features/orders/components/order-document";
import { getPublicOrder } from "@/features/orders/public-server";
import { ORDER_STATUS_LABELS } from "@/features/orders/schema";
import { PrintButton } from "@/features/print/components/print-button";
import { QuoteDecisionPanel } from "@/features/quotes/components/quote-decision-panel";
import { clientIp } from "@/lib/keyed-ip-hash";
import { formatDate } from "@/lib/format";

// as the quote page (QUO-14): not for search engines, and the secret address never leaves in a Referer header
export const metadata: Metadata = { title: "אישור הזמנה", robots: { index: false, follow: false }, referrer: "no-referrer" };

type Props = { params: Promise<{ token: string }> };

const MESSAGES = {
  "not-found": "ההזמנה לא נמצאה, או שהקישור כבר לא בתוקף. לקבלת קישור חדש פנו לעסק ששלח אותו.",
  "rate-limited": "ההזמנה נפתחה יותר מדי פעמים בזמן קצר. נסו שוב בעוד כמה דקות.",
  "not-configured": "ההזמנה אינה זמינה כרגע.",
} as const;

/**
 * ORD-05: a numbered order as its customer sees it, through its secret link. No sign-in and no cookies; only what the order
 * confirmation shows (ORD-05 part one), in the business's design. A new order waits for the customer's answer: approve and
 * sign, or decline (as QUO-09). A cancelled order shows only its state; every other numbered order shows its state above it.
 */
export default async function PublicOrderPage({ params }: Props) {
  const { token } = await params;
  const page = await getPublicOrder(token, clientIp(await headers()));

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

  if ("statusPage" in page) {
    const logoUrl = logoPublicUrl(page.logoPath);
    return (
      <main className="mx-auto min-h-dvh w-full max-w-md space-y-4 px-5 py-10 sm:py-16">
        {logoUrl ? <OrgLogo url={logoUrl} alt={`הלוגו של ${page.business}`} className="h-12 max-w-40" /> : null}
        <h1 className="text-lg font-semibold">אישור הזמנה</h1>
        <p role="status" className="rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
          {page.number ? (
            <>
              הזמנה{" "}
              <span dir="ltr" className="tabular-nums">
                {page.number}
              </span>
              :{" "}
            </>
          ) : null}
          ההזמנה בוטלה על ידי העסק.
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
        <AccessibilityLink />
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-dvh w-full max-w-4xl space-y-4 px-4 py-6 sm:px-6 sm:py-10">
      {page.decision ? (
        <p role="status" className={`rounded-md px-3 py-2.5 text-sm print:hidden ${page.decision.decision === "accepted" ? "bg-success-soft text-success" : "bg-warning-soft text-warning"}`}>
          {page.decision.decision === "accepted" ? "אישרת את ההזמנה" : "דחית את ההזמנה"} ב-{formatDate(page.decision.decidedAt)}.
        </p>
      ) : page.order.status !== "new" ? (
        <p role="status" className="rounded-md bg-accent-soft px-3 py-2.5 text-sm text-accent-strong print:hidden">
          מצב ההזמנה: {ORDER_STATUS_LABELS[page.order.status]}.
        </p>
      ) : null}
      {/* data-print-page: print.css leaves only the document on paper */}
      <div data-print-page="" className="flex justify-end print:hidden">
        <PrintButton label="הדפסה או שמירה כ-PDF" />
      </div>
      <OrderDocument
        data={{
          design: page.design,
          color: page.color,
          logoUrl: logoPublicUrl(page.logoPath),
          business: page.business,
          customer: page.customer,
          order: page.order,
          lines: page.lines,
          schedule: page.schedule,
        }}
      />
      {/* a new order waits for one answer, bound to what the page shows (its fingerprint) */}
      {page.fingerprint ? <QuoteDecisionPanel token={token} fingerprint={page.fingerprint} subject="order" /> : null}
      <div className="print:hidden">
        {page.builtWith ? <BuiltWithLine /> : null}
        <AccessibilityLink />
      </div>
    </main>
  );
}
