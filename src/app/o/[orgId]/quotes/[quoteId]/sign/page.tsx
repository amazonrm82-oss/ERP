import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/ui/page-header";
import { InPersonQuoteAccept } from "@/features/in-person-signing/components/in-person-quote";
import { IN_PERSON_CANNOT, IN_PERSON_HAND_OVER } from "@/features/in-person-signing/texts";
import { QuoteDocument } from "@/features/quotes/components/quote-document";
import { getQuoteDocumentData } from "@/features/quotes/design-server";
import { quotePath } from "@/features/quotes/paths";
import { getQuote, listQuoteLines } from "@/features/quotes/queries";
import { getOrgContext } from "@/features/shell/queries";
import { isUuid } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "חתימה במקום על הצעת מחיר", referrer: "no-referrer" };

type Props = { params: Promise<{ orgId: string; quoteId: string }> };

const STATE_TEXT: Record<string, string> = {
  decided: "כבר התקבלה תשובה על ההצעה הזאת.",
  superseded: "נשלחה גרסה חדשה של ההצעה. פתחו את הגרסה החדשה כדי להחתים עליה.",
  closed: "ההצעה כבר לא פתוחה לתשובה (בוטלה, פג תוקפה או שהלקוח נמחק).",
  no_link: "להצעה אין קישור פעיל ללקוח. צרו קישור בדף ההצעה, ואז חזרו לחתימה במקום.",
};

/**
 * SGN-07 (owner, 11 November 2026, answer (276) א): a sent quote, opened on the rep's device so the customer reads it, ticks
 * optional lines as on its page, and signs with a finger. public.quote_in_person_open checks the rep's session first (the
 * right that sends a quote) and answers the state and the fingerprint the signature names.
 */
export default async function InPersonQuotePage({ params }: Props) {
  const { orgId, quoteId } = await params;
  if (!isUuid(quoteId)) notFound();
  const context = await getOrgContext(orgId);
  const quote = await getQuote(orgId, quoteId);
  if (!quote) notFound();
  const back = { href: quotePath(orgId, quote.id), label: quote.title };
  const supabase = await createClient();
  const open = await supabase.rpc("quote_in_person_open", { p_org: orgId, p_quote: quote.id });
  if (open.error && open.error.code !== "42501" && open.error.code !== "P0001") throw new Error(`quote_in_person_open: ${open.error.code} ${open.error.message}`);
  const answer = open.error ? null : (open.data as { state?: unknown; fingerprint?: unknown } | null);
  const state = typeof answer?.state === "string" ? answer.state : null;
  const fingerprint = state === "open" && typeof answer?.fingerprint === "string" && /^[0-9a-f]{64}$/.test(answer.fingerprint) ? answer.fingerprint : null;
  const [data, lines] = await Promise.all([getQuoteDocumentData(orgId, quote, context.org.name), fingerprint ? listQuoteLines(orgId, quote.id) : []]);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader title="חתימה במקום" back={back} />
      {state === null ? (
        <p role="status" className="rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
          {IN_PERSON_CANNOT}
        </p>
      ) : fingerprint ? (
        <p className="rounded-md bg-accent-soft px-3 py-2.5 text-sm text-ink">{IN_PERSON_HAND_OVER}</p>
      ) : (
        <p role="status" className="rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
          {STATE_TEXT[state] ?? STATE_TEXT.closed}
        </p>
      )}
      <QuoteDocument data={data} headingLevel={2} />
      {fingerprint ? <InPersonQuoteAccept orgId={orgId} quoteId={quote.id} fingerprint={fingerprint} quote={{ vatRateBp: quote.vatRateBp, pricesIncludeVat: quote.pricesIncludeVat, discountBp: quote.discountBp, discountAgorot: quote.discountAgorot }} lines={lines} back={back} /> : null}
    </div>
  );
}
