import type { Metadata } from "next";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
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
import { PAYMENT_STATUS_TONES, paymentCounts, paymentHome, PaymentsTable } from "@/features/payments/components/payments-table";
import { PAYMENT_DEFAULT_SORT, paymentListFilters, paymentListHref, paymentSortStartsAscending, type PaymentSortKey } from "@/features/payments/list";
import { chequesPath, collectionPath, paymentsPath } from "@/features/payments/paths";
import { getCollectionAccess } from "@/features/collection/queries";
import { getPaymentsAccess, listPayments, listPaymentTotal, PAYMENT_TOTALS_LIMIT } from "@/features/payments/queries";
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS, PAYMENT_STATUS_LABELS, PAYMENT_STATUSES } from "@/features/payments/schema";
import { getMyPermissions } from "@/features/permissions/queries";
import { quickSalePath } from "@/features/quick-sale/paths";
import { quickSaleOffered } from "@/features/quick-sale/queries";
import { canExport } from "@/features/reports/request";
import { getOrgContext, getUserNames } from "@/features/shell/queries";
import { paymentsListTexts } from "@/features/payments/texts";
import { getOrgTerms } from "@/features/terminology/queries";
import { SavedViewsBar } from "@/features/views/components/saved-views-bar";
import { viewChips } from "@/features/views/server";
import { formatDate, formatMoney } from "@/lib/format";
import { firstParam } from "@/lib/search";
import { nextSort, sortValue } from "@/lib/sort";

export const metadata: Metadata = { title: "תשלומים" };

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * LST-09 (owner, 21 October 2026): every payment the user may read (PAY-01; the payments of deals and contacts they read),
 * with the shared list pieces: the list's selects, the advanced filter, the user's columns, saved views, sorting by any
 * column and export (all of it, or the picked rows). The total received over everything the filters find counts recorded
 * and confirmed payments only. Nothing is edited here: a payment is recorded, moved and corrected on its record's card.
 * Shown while the plan has the `payments` key.
 */
export default async function PaymentsPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const [context, access, terms] = await Promise.all([getOrgContext(orgId), getPaymentsAccess(orgId), getOrgTerms(orgId)]);
  // RVW-49: the business's own words (FLD-10)
  const texts = paymentsListTexts(terms);
  if (!access.inPlan) {
    return (
      <>
        <PageHeader title="תשלומים" />
        <Card>
          <CardBody>
            <p>רישום תשלומים לא כלול בחבילה של העסק.</p>
          </CardBody>
        </Card>
      </>
    );
  }
  const query = await searchParams;
  const filters = paymentListFilters(query);
  const sort = filters.sort ?? PAYMENT_DEFAULT_SORT;
  // FXC-09: the columns and the filter's choices load side by side; prepareListFilter reuses the same reads
  const [granted, listColumns, quickSale, collectionAccess] = await Promise.all([
    // PRM-01: extra permissions (export)
    getMyPermissions(orgId),
    getListColumns(orgId, "payment"),
    // GAP-08: the quick sale, for whoever records payments while the plan holds products too
    quickSaleOffered(orgId),
    // COL-01: the collection screen, for whoever may open it
    getCollectionAccess(orgId),
    startListFilterLookups(orgId, "payment"),
  ]);
  const collection = collectionAccess.canOpen;
  const filter = await prepareListFilter(orgId, "payment", firstParam(query.f), context.user.id, []);
  const filterParam = filter.tree ? JSON.stringify(filter.tree) : null;
  const listed = { ...filters, filter: filter.logic };
  const [{ payments, hasMore }, total, viewData] = await Promise.all([listPayments(orgId, listed), listPaymentTotal(orgId, listed), viewChips(orgId, "payment", context)]);
  const names = await getUserNames(payments.map((payment) => payment.createdBy));
  const views = viewData.chips;
  const activeView = views.find((view) => view.id === firstParam(query.sv)) ?? null;
  const shownColumns = activeView?.config.columns ? resolveColumns("payment", activeView.config.columns, listColumns.catalog) : listColumns.columns;
  const exportAllowed = canExport(context.role, granted);
  const filtered = filters.status !== null || filters.method !== null || filters.from !== null || filters.to !== null || filter.tree !== null;

  const extra = { f: filterParam, sv: activeView?.id ?? null };
  const hrefFor = (target: number) => paymentListHref(orgId, filters, target, extra);
  // a new sort starts again from the first page
  const sortHref = (key: string) =>
    paymentListHref(orgId, { ...filters, sort: nextSort(sort, key as PaymentSortKey, paymentSortStartsAscending(key as PaymentSortKey)) }, 1, extra);
  // what the advanced filter and a saved view keep from the page's own selects
  const kept: Record<string, string> = Object.fromEntries(
    Object.entries({ status: filters.status ?? "", method: filters.method ?? "", from: filters.from ?? "", to: filters.to ?? "" }).filter(([, value]) => value !== ""),
  );

  return (
    <>
      <PageHeader
        title="תשלומים"
        description={texts.description}
        actions={
          <span className="flex flex-wrap items-center gap-2">
            {/* GAP-08 */}
            {quickSale ? (
              <Link href={quickSalePath(orgId)} className={buttonClasses("primary", "sm")}>
                מכירה מהירה
              </Link>
            ) : null}
            {/* COL-01 */}
            {collection ? (
              <Link href={collectionPath(orgId)} className={buttonClasses("secondary", "sm")}>
                גבייה
              </Link>
            ) : null}
            {/* PAY-04 answer 7 */}
            <Link href={chequesPath(orgId)} className={buttonClasses("secondary", "sm")}>
              צ&apos;קים דחויים
            </Link>
            {exportAllowed ? <ExportMenu href={exportHref(paymentsPath(orgId), paymentListHref(orgId, filters, 1, { f: filterParam }))} /> : null}
          </span>
        }
      />
      <SavedViewsBar
        orgId={orgId}
        objectType="payment"
        listPath={paymentsPath(orgId)}
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
        <AdvancedFilter fields={filter.fields} current={filter.tree} skipped={filter.skipped} listPath={paymentsPath(orgId)} keep={kept} />
        {activeView?.config.columns ? (
          <p className="py-2 text-sm text-ink-soft">העמודות לפי התצוגה &quot;{activeView.name}&quot;</p>
        ) : (
          <ColumnsPanel orgId={orgId} object="payment" catalog={listColumns.catalog} columns={listColumns.columns} saved={listColumns.saved} />
        )}
      </div>
      <form method="get" action={paymentsPath(orgId)} className="mb-5 flex flex-wrap items-end gap-3" aria-label="סינון תשלומים">
        {/* the advanced filter and the sort stay when a select changes */}
        {filterParam ? <input type="hidden" name="f" value={filterParam} /> : null}
        {sortValue(sort) !== sortValue(PAYMENT_DEFAULT_SORT) ? <input type="hidden" name="sort" value={sortValue(sort)} /> : null}
        <label>
          <span className="mb-1.5 block text-sm font-medium">מצב</span>
          <Select name="status" defaultValue={filters.status ?? ""} className="w-32">
            <option value="">הכול</option>
            {PAYMENT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {PAYMENT_STATUS_LABELS[status]}
              </option>
            ))}
          </Select>
        </label>
        <label>
          <span className="mb-1.5 block text-sm font-medium">אמצעי תשלום</span>
          <Select name="method" defaultValue={filters.method ?? ""} className="w-40">
            <option value="">הכול</option>
            {PAYMENT_METHODS.map((method) => (
              <option key={method} value={method}>
                {PAYMENT_METHOD_LABELS[method]}
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
          <Link href={paymentsPath(orgId)} className={buttonClasses("ghost", "md")}>
            ניקוי הסינון
          </Link>
        ) : null}
      </form>
      {total.count > 0 ? (
        <p className="mb-5 rounded-lg border border-line bg-surface px-4 py-3 text-sm text-ink-soft">
          התקבלו <span className="font-medium text-ink tabular-nums">{formatMoney(total.agorot)}</span>{" "}
          {filtered ? "לפי הסינון " : ""}({total.count === 1 ? "תשלום אחד" : `${total.count.toLocaleString("he-IL")} תשלומים`} במצב נרשם או אושר; לא נספרים תשלומים
          שבוטלו, נכשלו או הוחזרו)
          {total.complete ? "" : `. הסכום לפי ${PAYMENT_TOTALS_LIMIT.toLocaleString("he-IL")} התשלומים הראשונים; צמצמו בסינון לסכום מלא.`}
        </p>
      ) : null}
      {payments.length === 0 ? (
        <Card>
          <EmptyState
            title={filtered ? "אין תשלומים לפי הסינון" : "עוד לא נרשמו תשלומים"}
            description={filtered ? "נסו סינון אחר, או נקו אותו." : texts.empty}
          />
        </Card>
      ) : (
        <>
          <ul aria-label="תשלומים" className="divide-y divide-line rounded-lg border border-line bg-surface md:hidden">
            {payments.map((payment) => {
              const home = paymentHome(orgId, payment);
              const amount = <span className={`tabular-nums ${paymentCounts(payment.status) ? "" : "text-ink-soft line-through"}`}>{formatMoney(payment.amountAgorot)}</span>;
              return (
                <li key={payment.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3">
                  <div className="min-w-0">
                    {home ? (
                      <Link href={home} className="font-medium text-accent-strong underline-offset-4 hover:underline">
                        {amount}
                      </Link>
                    ) : (
                      <span className="font-medium">{amount}</span>
                    )}
                    {" · "}
                    {PAYMENT_METHOD_LABELS[payment.method]}
                    <p className="text-sm text-ink-soft">
                      {payment.customer ? (
                        <>
                          <bdi>{payment.customer}</bdi>
                          {" · "}
                        </>
                      ) : null}
                      {formatDate(`${payment.paidOn}T12:00:00Z`)}
                    </p>
                  </div>
                  <Badge tone={PAYMENT_STATUS_TONES[payment.status]}>{PAYMENT_STATUS_LABELS[payment.status]}</Badge>
                </li>
              );
            })}
          </ul>
          <div className="hidden md:block">
            <PaymentsTable
              orgId={orgId}
              payments={payments}
              columns={shownColumns}
              catalog={listColumns.catalog}
              recorderNames={names}
              sort={sort}
              sortHref={sortHref}
              exportPath={exportAllowed ? `${paymentsPath(orgId)}/export` : null}
            />
          </div>
        </>
      )}
      <Pagination page={filters.page} hasMore={hasMore} hrefFor={hrefFor} className="mt-4" />
    </>
  );
}
