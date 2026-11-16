import type { Quote } from "@/features/quotes/queries";

import { getQuoteMessageSetup } from "../queries";

import { QuoteMessageDialog } from "./quote-message-dialog";

type Props = {
  orgId: string;
  quote: Quote;
  linkActive: boolean;
  userName: string;
  businessName: string;
  timeZone: string;
  canManageTemplates: boolean;
};

/**
 * QUO-18: the quote screen's "שליחה ללקוח" (for a person who may send the quote; the database judges it again). Nothing when the
 * quote has no customer to send to. The page wraps it in <Suspense>, so the quote renders first.
 */
export async function QuoteMessageButton({ orgId, quote, linkActive, userName, businessName, timeZone, canManageTemplates }: Props) {
  const setup = await getQuoteMessageSetup(orgId, quote, quote.validUntil !== null);
  if (!setup) return null;
  return (
    <QuoteMessageDialog
      orgId={orgId}
      quoteId={quote.id}
      options={setup.options}
      queued={setup.queued}
      values={{
        ...setup.values,
        userName,
        businessName,
        validUntil: quote.validUntil ? new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${quote.validUntil}T00:00:00Z`)) : null,
      }}
      linkActive={linkActive}
      canManageTemplates={canManageTemplates}
      timeZone={timeZone}
    />
  );
}
