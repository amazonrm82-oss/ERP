import type { Metadata } from "next";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { Input, Select } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { quotePath, quotesPath } from "@/features/quotes/paths";
import { listQuotes } from "@/features/quotes/queries";
import { quoteListFilters, quoteListHref } from "@/features/quotes/list";
import { QUOTE_STATUS_LABELS, QUOTE_STATUSES } from "@/features/quotes/schema";
import { listMembers } from "@/features/settings/queries";
import { getOrgContext, getUserNames } from "@/features/shell/queries";
import { formatDate, formatMoney } from "@/lib/format";

export const metadata: Metadata = { title: "הצעות מחיר" };

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * QUO-16: every quote the user may read (the quotes of deals and contacts they read), newest first, filtered by
 * status, owner and quote date. Quotes are made from a deal or a contact; this list only finds them.
 */
export default async function QuotesPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const filters = quoteListFilters(await searchParams);
  await getOrgContext(orgId);
  const [{ quotes, hasMore }, members] = await Promise.all([listQuotes(orgId, filters), listMembers(orgId)]);
  const names = await getUserNames(quotes.map((quote) => quote.ownerId));
  const filtered = filters.status !== null || filters.ownerId !== null || filters.from !== null || filters.to !== null;

  return (
    <>
      <PageHeader title="הצעות מחיר" description="כל הצעות המחיר של העסקאות ואנשי הקשר שאתם רואים. הצעה חדשה יוצרים מתוך עסקה או איש קשר." />
      <form method="get" action={quotesPath(orgId)} className="mb-5 flex flex-wrap items-end gap-3" aria-label="סינון הצעות">
        <label>
          <span className="mb-1.5 block text-sm font-medium">מצב</span>
          <Select name="status" defaultValue={filters.status ?? ""} className="w-36">
            <option value="">הכול</option>
            {QUOTE_STATUSES.map((status) => (
              <option key={status} value={status}>
                {QUOTE_STATUS_LABELS[status]}
              </option>
            ))}
          </Select>
        </label>
        <label>
          <span className="mb-1.5 block text-sm font-medium">אחראי</span>
          <Select name="owner" defaultValue={filters.ownerId ?? ""} className="w-44">
            <option value="">כולם</option>
            {members
              .filter((member) => member.status === "active" || member.userId === filters.ownerId)
              .map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.name}
                </option>
              ))}
          </Select>
        </label>
        <label>
          <span className="mb-1.5 block text-sm font-medium">מתאריך</span>
          <Input type="date" name="from" defaultValue={filters.from ?? ""} className="w-40" />
        </label>
        <label>
          <span className="mb-1.5 block text-sm font-medium">עד תאריך</span>
          <Input type="date" name="to" defaultValue={filters.to ?? ""} className="w-40" />
        </label>
        <button type="submit" className={buttonClasses("secondary", "md")}>
          הצגה
        </button>
        {filtered ? (
          <Link href={quotesPath(orgId)} className={buttonClasses("ghost", "md")}>
            ניקוי הסינון
          </Link>
        ) : null}
      </form>
      {quotes.length === 0 ? (
        <Card>
          <EmptyState
            title={filtered ? "אין הצעות לפי הסינון" : "עוד אין הצעות מחיר"}
            description={filtered ? "נסו סינון אחר, או נקו אותו." : "הצעת מחיר יוצרים מתוך עסקה או איש קשר, בכרטיס \"הצעות מחיר\"."}
          />
        </Card>
      ) : (
        <ul aria-label="הצעות מחיר" className="divide-y divide-line rounded-lg border border-line bg-surface">
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
                  {quote.customer ? (
                    <>
                      <bdi>{quote.customer}</bdi>
                      {" · "}
                    </>
                  ) : null}
                  {quote.ownerId ? `${names.get(quote.ownerId) ?? "ללא אחראי"} · ` : ""}
                  {formatDate(quote.quoteDate)}
                  {quote.sentAt ? ` · נשלחה ${formatDate(quote.sentAt)}` : ""}
                </p>
              </div>
              <span className="flex items-center gap-2 text-sm">
                <Badge>{QUOTE_STATUS_LABELS[quote.status]}</Badge>
                <span className="font-medium whitespace-nowrap tabular-nums">{formatMoney(quote.totalAgorot)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <Pagination page={filters.page} hasMore={hasMore} hrefFor={(target) => quoteListHref(orgId, filters, target)} className="mt-4" />
    </>
  );
}
