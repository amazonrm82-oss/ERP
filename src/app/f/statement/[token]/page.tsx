import "@/features/print/print.css";

import type { Metadata } from "next";
import { headers } from "next/headers";

import { AccessibilityLink } from "@/components/accessibility-link";
import { logoPublicUrl } from "@/features/branding/logo";
import { BuiltWithLine } from "@/features/built-with/components/built-with-line";
import { isPreviewBotRequest } from "@/features/link-preview/bot-request";
import { PrintButton } from "@/features/print/components/print-button";
import { StatementView } from "@/features/statements/components/statement-view";
import { getPublicStatement } from "@/features/statements/public-server";
import { clientIp } from "@/lib/keyed-ip-hash";
import { genericPreview, PREVIEW_TEXTS } from "@/lib/link-preview";

type Props = { params: Promise<{ token: string }> };

/**
 * WAB-05 for BAL-04: the link's preview is always the generic one ("דף חשבון"), for people and bots alike, so the metadata
 * never reads the page (no view is counted for it) and never names the business or the customer. Not for search engines,
 * and the secret address never leaves in a Referer header.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = PREVIEW_TEXTS.statement;
  return { ...genericPreview(t.what, t.description), referrer: "no-referrer" };
}

const MESSAGES = {
  "not-found": "הקישור אינו זמין. ייתכן שהוא בוטל או שהוחלף בקישור חדש. לקבלת קישור פנו לעסק ששלח אותו.",
  "rate-limited": "הדף נפתח יותר מדי פעמים בזמן קצר. נסו שוב בעוד כמה דקות.",
  "not-configured": "דף החשבון אינו זמין כרגע.",
} as const;

/**
 * BAL-04: the customer's statement through its secret link: no sign-in and no cookies; the open debt documents and their
 * balances, the totals and any credit, in the business's colours. Printable (GAP-11's print rules).
 */
export default async function PublicStatementPage({ params }: Props) {
  const { token } = await params;
  // a listed preview bot gets one line, and the statement is never read for it (no view counted)
  if (await isPreviewBotRequest()) {
    return (
      <main className="mx-auto min-h-dvh w-full max-w-md px-5 py-10 sm:py-16">
        <p className="text-md text-ink">{PREVIEW_TEXTS.statement.what}</p>
      </main>
    );
  }
  const page = await getPublicStatement(token, clientIp(await headers()));

  if (typeof page === "string") {
    return (
      <main className="mx-auto min-h-dvh w-full max-w-md px-5 py-10 sm:py-16">
        <h1 className="sr-only">דף חשבון</h1>
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {MESSAGES[page]}
        </p>
        <AccessibilityLink />
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-dvh w-full max-w-4xl space-y-4 px-4 py-6 sm:px-6 sm:py-10">
      {/* data-print-page: print.css leaves only the statement on paper */}
      <div data-print-page="" className="flex justify-end print:hidden">
        <PrintButton label="הדפסה או שמירה כ-PDF" />
      </div>
      <StatementView data={page} logoUrl={logoPublicUrl(page.logoPath)} />
      <div className="print:hidden">
        {page.builtWith ? <BuiltWithLine /> : null}
        <AccessibilityLink />
      </div>
    </main>
  );
}
