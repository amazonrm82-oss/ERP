import type { Metadata } from "next";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { Pagination } from "@/components/ui/pagination";
import { detachedQuotesPath, quotePath } from "@/features/quotes/paths";
import { listDetachedQuotes } from "@/features/quotes/queries";
import { QUOTE_STATUS_LABELS } from "@/features/quotes/schema";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { formatDate, formatMoney } from "@/lib/format";
import { parsePage } from "@/lib/search";

export const metadata: Metadata = { title: "הצעות של לקוחות שנמחקו" };

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ page?: string }>;
};

/**
 * QUO-07: a sent quote stays when its deal and contact are purged, detached from them and marked "הלקוח נמחק".
 * Such quotes are readable by owners and admins only, and this is where they find them.
 */
export default async function DeletedCustomerQuotesPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const page = parsePage((await searchParams).page);
  const { role } = await getOrgContext(orgId);
  if (!isAdminRole(role)) {
    return (
      <Card>
        <EmptyState kind="locked" title="פנו לבעלים של העסק" description="הצעות של לקוחות שנמחקו רואים הבעלים ומנהלי המערכת של העסק." />
      </Card>
    );
  }
  const { quotes, hasMore } = await listDetachedQuotes(orgId, page);
  const hrefFor = (target: number) => (target > 1 ? `${detachedQuotesPath(orgId)}?page=${target}` : detachedQuotesPath(orgId));

  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-soft">
        הצעה שנשלחה נשארת גם כשהעסקה ואיש הקשר שלה נמחקו לצמיתות, עם שם הלקוח כפי שהופיע בה. כאן הן מרוכזות. הצעה שנמחקו בה הפרטים האישיים לבקשת
        הלקוח מופיעה בלי שם.
      </p>
      {quotes.length === 0 ? (
        <Card>
          <EmptyState title="אין הצעות של לקוחות שנמחקו" description="כשתימחק לצמיתות רשומה שיש לה הצעה שנשלחה, ההצעה תופיע כאן." />
        </Card>
      ) : (
        <ul aria-label="הצעות של לקוחות שנמחקו" className="divide-y divide-line rounded-lg border border-line bg-surface">
          {quotes.map((quote) => (
            <li key={quote.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3">
              <div className="min-w-0">
                <Link href={quotePath(orgId, quote.id)} className="font-medium text-accent-strong underline-offset-4 hover:underline">
                  {quote.numberDisplay ? (
                    <span dir="ltr" className="tabular-nums">
                      {quote.numberDisplay}
                    </span>
                  ) : null}
                  {quote.numberDisplay ? " · " : null}
                  <bdi>{quote.title}</bdi>
                </Link>
                <p className="text-sm text-ink-soft">
                  {quote.customerName ? <bdi>{quote.customerName}</bdi> : "ללא שם"} · {QUOTE_STATUS_LABELS[quote.status]}
                  {quote.sentAt ? ` · נשלחה ${formatDate(quote.sentAt)}` : ""} · הלקוח נמחק {formatDate(quote.customerDeletedAt)}
                </p>
              </div>
              <span className="text-sm font-medium whitespace-nowrap tabular-nums">{formatMoney(quote.totalAgorot)}</span>
            </li>
          ))}
        </ul>
      )}
      <Pagination page={page} hasMore={hasMore} hrefFor={hrefFor} />
    </div>
  );
}
