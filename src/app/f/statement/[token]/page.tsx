import "@/features/print/print.css";

import type { Metadata } from "next";
import { headers } from "next/headers";

import { buttonClasses } from "@/components/ui/button";
import { BrandScope } from "@/features/branding/components/brand-scope";
import { PublicPageFooter } from "@/features/branding/components/public-page";
import { logoPublicUrl } from "@/features/branding/logo";
import { isPreviewBotRequest } from "@/features/link-preview/bot-request";
import { PrintButton } from "@/features/print/components/print-button";
import { StatementView } from "@/features/statements/components/statement-view";
import { publicStatementPdfPath } from "@/features/statements/public";
import { getPublicStatement } from "@/features/statements/public-server";
import { clientIp } from "@/lib/keyed-ip-hash";
import { genericPreview, PREVIEW_TEXTS } from "@/lib/link-preview";
import { RATE_LIMITED_PAGE_TEXT } from "@/lib/public-rate-limit";
import { guardPublicPage } from "@/lib/public-sender-server";

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
  "rate-limited": RATE_LIMITED_PAGE_TEXT,
  "not-configured": "דף החשבון אינו זמין כרגע.",
} as const;

/**
 * BAL-04: the customer's statement through its secret link: no sign-in and no cookies; the open debt documents and their
 * balances, the totals and any credit, the payments of the last 12 months and the bank details (while the design shows them),
 * in the business's colours. Printable (GAP-11's print rules).
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
  // OPS-02 (owner (40) ב, (42) ד): the shared per-sender limit of the secret-link pages first; a "not found" counts one miss
  const page = await guardPublicPage(async () => getPublicStatement(token, clientIp(await headers())));

  if (typeof page === "string") {
    return (
      <main className="mx-auto min-h-dvh w-full max-w-md px-5 py-10 sm:py-16">
        <h1 className="sr-only">דף חשבון</h1>
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {MESSAGES[page]}
        </p>
        <PublicPageFooter builtWith={false} />
      </main>
    );
  }

  return (
    // DSN-17: the whole page in the business's colour (the buttons too, not only the statement)
    <BrandScope color={page.color}>
      <main className="mx-auto min-h-dvh w-full max-w-4xl space-y-4 px-4 py-6 sm:px-6 sm:py-10">
        {/* data-print-page: print.css leaves only the statement on paper */}
        <div data-print-page="" className="flex flex-wrap justify-end gap-2 print:hidden">
          {/* BAL-04: made on our server for this download, never stored; counts as one more opening of the page */}
          <a href={publicStatementPdfPath(token)} rel="nofollow" className={buttonClasses("secondary", "sm")}>
            הורדת PDF
          </a>
          <PrintButton label="הדפסה" />
        </div>
        <StatementView data={page} logoUrl={logoPublicUrl(page.logoPath)} />
        <PublicPageFooter builtWith={page.builtWith} className="print:hidden" />
      </main>
    </BrandScope>
  );
}
