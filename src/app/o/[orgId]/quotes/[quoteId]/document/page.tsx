import "@/features/print/print.css";

import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/ui/page-header";
import { PrintButton } from "@/features/print/components/print-button";
import { QuoteDocument } from "@/features/quotes/components/quote-document";
import { getQuoteDocumentData } from "@/features/quotes/design-server";
import { quotePath } from "@/features/quotes/paths";
import { getQuote } from "@/features/quotes/queries";
import { getOrgContext } from "@/features/shell/queries";
import { isUuid } from "@/lib/paths";

export const metadata: Metadata = { title: "הצעת מחיר להדפסה" };

type Props = { params: Promise<{ orgId: string; quoteId: string }> };

/**
 * QUO-05: a quote as its customer sees it, in the business's design, for printing or saving as PDF from
 * the browser (the agreed fallback until QUO-06). Whoever reads the quote reads this page.
 */
export default async function QuoteDocumentPage({ params }: Props) {
  const { orgId, quoteId } = await params;
  if (!isUuid(quoteId)) notFound();
  const context = await getOrgContext(orgId);
  const quote = await getQuote(orgId, quoteId);
  if (!quote) notFound();
  const data = await getQuoteDocumentData(orgId, quote, context.org.name);
  return (
    <div className="max-w-4xl space-y-4">
      {/* data-print-page: print.css hides the app around the document on paper */}
      <div data-print-page="" className="print:hidden">
        <PageHeader title="תצוגה והדפסה" back={{ href: quotePath(orgId, quote.id), label: quote.title }} actions={<PrintButton label="הדפסה או שמירה כ-PDF" />} />
        {quote.status === "draft" ? <p className="text-sm text-ink-soft">זו טיוטה: היא מודפסת בלי מספר, ומספר רץ ניתן כשההצעה נשלחת.</p> : null}
      </div>
      <QuoteDocument data={data} headingLevel={2} />
    </div>
  );
}
