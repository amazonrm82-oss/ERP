import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { QuoteEditor } from "@/features/quotes/components/quote-editor";
import { getQuote, getQuoteParties, getQuotePricing, listQuoteLines } from "@/features/quotes/queries";
import { QUOTE_STATUS_LABELS } from "@/features/quotes/schema";
import { orgHasFeature } from "@/features/settings/queries";
import { canEditRecordHint, getOrgContext } from "@/features/shell/queries";
import { must } from "@/lib/db-read";
import { formatDate } from "@/lib/format";
import { isUuid, paths } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "הצעת מחיר" };

type Props = { params: Promise<{ orgId: string; quoteId: string }> };

const linkClass = "text-accent-strong underline-offset-4 hover:underline";

/**
 * QUO-01, QUO-02: one quote and its editor. Whoever reads the quote's deal (else its contact) reads it;
 * whoever may edit that deal or contact edits it while it is a draft (RLS decides again on every write).
 */
export default async function QuotePage({ params }: Props) {
  const { orgId, quoteId } = await params;
  if (!isUuid(quoteId)) notFound();
  const context = await getOrgContext(orgId);
  const quote = await getQuote(orgId, quoteId);
  if (!quote) notFound();
  const supabase = await createClient();
  const [lines, pricing, parties, hasProducts, hasDiscounts, parent] = await Promise.all([
    listQuoteLines(orgId, quote.id),
    getQuotePricing(orgId, quote),
    getQuoteParties(orgId, quote),
    orgHasFeature(orgId, "products"),
    orgHasFeature(orgId, "discounts"),
    quote.dealId
      ? supabase.from("deals").select("owner_id, deleted_at").eq("organization_id", orgId).eq("id", quote.dealId).maybeSingle()
      : supabase.from("contacts").select("owner_id, deleted_at").eq("organization_id", orgId).eq("id", quote.contactId ?? "").maybeSingle(),
  ]);
  const parentRow = must(parent, "quote parent");
  const canEdit = quote.status === "draft" && parentRow !== null && parentRow.deleted_at === null && canEditRecordHint(context, parentRow.owner_id);
  const back = quote.dealId
    ? { href: paths.deal(orgId, quote.dealId), label: parties.deal ?? "עסקה" }
    : { href: paths.contact(orgId, quote.contactId ?? ""), label: parties.contact ?? "איש קשר" };

  return (
    <div className="max-w-4xl">
      <PageHeader title={quote.title} back={back} />
      <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-ink-soft">
        <Badge>{QUOTE_STATUS_LABELS[quote.status]}</Badge>
        <span>{formatDate(quote.quoteDate)}</span>
        {quote.dealId && parties.deal ? (
          <span>
            עסקה:{" "}
            <Link href={paths.deal(orgId, quote.dealId)} className={linkClass}>
              <bdi>{parties.deal}</bdi>
            </Link>
          </span>
        ) : null}
        {quote.contactId && parties.contact ? (
          <span>
            איש קשר:{" "}
            <Link href={paths.contact(orgId, quote.contactId)} className={linkClass}>
              <bdi>{parties.contact}</bdi>
            </Link>
          </span>
        ) : null}
        {quote.companyId && parties.company ? (
          <span>
            חברה:{" "}
            <Link href={paths.company(orgId, quote.companyId)} className={linkClass}>
              <bdi>{parties.company}</bdi>
            </Link>
          </span>
        ) : null}
      </div>
      {quote.status === "draft" ? (
        <p className="mb-5 rounded-md bg-accent-soft px-3 py-2.5 text-sm text-accent-strong">
          טיוטה: כל שינוי נשמר בהצעה, והלקוח עוד לא רואה אותה. המספר הרץ ניתן כשההצעה נשלחת.
        </p>
      ) : null}
      <QuoteEditor
        orgId={orgId}
        quote={quote}
        lines={lines}
        pricing={pricing}
        chargesVat={pricing.businessRateBp !== null && pricing.businessRateBp > 0}
        canEdit={canEdit}
        features={{ products: hasProducts, discounts: hasDiscounts }}
      />
    </div>
  );
}
