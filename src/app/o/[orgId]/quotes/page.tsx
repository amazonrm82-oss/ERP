import type { Metadata } from "next";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { Input, Select } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { resolveColumns } from "@/features/list-columns/columns";
import { ColumnsPanel } from "@/features/list-columns/components/columns-panel";
import { getListColumns } from "@/features/list-columns/queries";
import { ExportMenu, exportHref } from "@/features/list-export/components/export-menu";
import { AdvancedFilter } from "@/features/list-filters/components/advanced-filter";
import { prepareListFilter, startListFilterLookups } from "@/features/list-filters/prepare";
import { getMyPermissions } from "@/features/permissions/queries";
import { QuoteName, QuotesTable } from "@/features/quotes/components/quotes-table";
import { quotePath, quotesPath } from "@/features/quotes/paths";
import { listQuotes } from "@/features/quotes/queries";
import { QUOTE_DEFAULT_SORT, quoteListFilters, quoteListHref, quoteSortStartsAscending, type QuoteSortKey } from "@/features/quotes/list";
import { QUOTE_STATUS_LABELS, QUOTE_STATUSES } from "@/features/quotes/schema";
import { canExport } from "@/features/reports/request";
import { listMembers } from "@/features/settings/queries";
import { getOrgContext, getUserNames } from "@/features/shell/queries";
import { SavedViewsBar } from "@/features/views/components/saved-views-bar";
import { viewChips } from "@/features/views/server";
import { formatDate, formatMoney } from "@/lib/format";
import { firstParam } from "@/lib/search";
import { nextSort, sortValue } from "@/lib/sort";

export const metadata: Metadata = { title: "הצעות מחיר" };

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * QUO-16: every quote the user may read (the quotes of deals and contacts they read), newest first, filtered by
 * status, owner and quote date. Quotes are made from a deal or a contact; this list only finds them.
 * LST-09: the shared list pieces too: advanced filter, the user's columns, saved views, sorting by any column, and
 * export (all of it, or the picked rows).
 */
export default async function QuotesPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const query = await searchParams;
  const filters = quoteListFilters(query);
  const sort = filters.sort ?? QUOTE_DEFAULT_SORT;
  const context = await getOrgContext(orgId);
  // FXC-09: the columns and the filter's choices load side by side; prepareListFilter reuses the same reads
  const [granted, members, listColumns] = await Promise.all([
    // PRM-01: extra permissions (export)
    getMyPermissions(orgId),
    listMembers(orgId),
    getListColumns(orgId, "quote"),
    startListFilterLookups(orgId, "quote"),
  ]);
  const filter = await prepareListFilter(orgId, "quote", firstParam(query.f), context.user.id, []);
  const filterParam = filter.tree ? JSON.stringify(filter.tree) : null;
  const [{ quotes, hasMore }, viewData] = await Promise.all([listQuotes(orgId, { ...filters, filter: filter.logic }), viewChips(orgId, "quote", context)]);
  const names = await getUserNames(quotes.map((quote) => quote.ownerId));
  const views = viewData.chips;
  const activeView = views.find((view) => view.id === firstParam(query.sv)) ?? null;
  const shownColumns = activeView?.config.columns ? resolveColumns("quote", activeView.config.columns, listColumns.catalog) : listColumns.columns;
  const exportAllowed = canExport(context.role, granted);
  const filtered = filters.status !== null || filters.ownerId !== null || filters.from !== null || filters.to !== null || filter.tree !== null;

  const extra = { f: filterParam, sv: activeView?.id ?? null };
  const hrefFor = (target: number) => quoteListHref(orgId, filters, target, extra);
  // a new sort starts again from the first page
  const sortHref = (key: string) =>
    quoteListHref(orgId, { ...filters, sort: nextSort(sort, key as QuoteSortKey, quoteSortStartsAscending(key as QuoteSortKey)) }, 1, extra);
  // what the advanced filter and a saved view keep from the page's own selects
  const kept: Record<string, string> = Object.fromEntries(
    Object.entries({ status: filters.status ?? "", owner: filters.ownerId ?? "", from: filters.from ?? "", to: filters.to ?? "" }).filter(([, value]) => value !== ""),
  );

  return (
    <>
      <PageHeader
        title="הצעות מחיר"
        description="כל הצעות המחיר של העסקאות ואנשי הקשר שאתם רואים. הצעה חדשה יוצרים מתוך עסקה או איש קשר."
        actions={exportAllowed ? <ExportMenu href={exportHref(quotesPath(orgId), quoteListHref(orgId, filters, 1, { f: filterParam }))} /> : null}
      />
      <SavedViewsBar
        orgId={orgId}
        objectType="quote"
        listPath={quotesPath(orgId)}
        views={views}
        activeViewId={activeView?.id ?? null}
        current={{ ...kept, f: filterParam ?? undefined }}
        currentSort={sortValue(sort)}
        currentColumns={shownColumns}
        teams={viewData.teams}
        canSave={context.role !== "viewer"}
        canShare={context.role === "owner" || context.role === "admin"}
      />
      <div className="mb-3 flex flex-wrap items-start justify-end gap-2">
        <AdvancedFilter fields={filter.fields} current={filter.tree} skipped={filter.skipped} listPath={quotesPath(orgId)} keep={kept} />
        {activeView?.config.columns ? (
          <p className="py-2 text-sm text-ink-soft">העמודות לפי התצוגה &quot;{activeView.name}&quot;</p>
        ) : (
          <ColumnsPanel orgId={orgId} object="quote" catalog={listColumns.catalog} columns={listColumns.columns} saved={listColumns.saved} />
        )}
      </div>
      <form method="get" action={quotesPath(orgId)} className="mb-5 flex flex-wrap items-end gap-3" aria-label="סינון הצעות">
        {/* the advanced filter and the sort stay when a select changes */}
        {filterParam ? <input type="hidden" name="f" value={filterParam} /> : null}
        {sortValue(sort) !== sortValue(QUOTE_DEFAULT_SORT) ? <input type="hidden" name="sort" value={sortValue(sort)} /> : null}
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
        <>
          <ul aria-label="הצעות מחיר" className="divide-y divide-line rounded-lg border border-line bg-surface md:hidden">
            {quotes.map((quote) => (
              <li key={quote.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3">
                <div className="min-w-0">
                  <Link href={quotePath(orgId, quote.id)} className="font-medium text-accent-strong underline-offset-4 hover:underline">
                    <QuoteName quote={quote} />
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
          <div className="hidden md:block">
            <QuotesTable
              orgId={orgId}
              quotes={quotes}
              columns={shownColumns}
              catalog={listColumns.catalog}
              ownerNames={names}
              sort={sort}
              sortHref={sortHref}
              exportPath={exportAllowed ? `${quotesPath(orgId)}/export` : null}
            />
          </div>
        </>
      )}
      <Pagination page={filters.page} hasMore={hasMore} hrefFor={hrefFor} className="mt-4" />
    </>
  );
}
