import type { Metadata } from "next";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { Input, Select } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { DocumentName, DocumentsTable, documentHome } from "@/features/documents/components/documents-table";
import {
  DOCUMENT_DEFAULT_SORT,
  DOCUMENT_LIST_STATUS_LABELS,
  DOCUMENT_LIST_STATUSES,
  DOCUMENT_TOTAL_KEYS,
  DOCUMENT_TOTAL_LABELS,
  documentListFilters,
  documentListHref,
  documentSortStartsAscending,
  type DocumentSortKey,
} from "@/features/documents/list";
import { documentsPath } from "@/features/documents/paths";
import { getCollectionAccess } from "@/features/collection/queries";
import { collectionPath } from "@/features/payments/paths";
import { DOCUMENT_TOTALS_LIMIT, getDocumentsAccess, listDocumentPayStates, listDocuments, listDocumentTotals } from "@/features/documents/queries";
import { getAllocationAccess } from "@/features/allocations/queries";
import { DocumentCustomerFilter } from "@/features/documents/components/customer-filter";
import { PayStateBadge } from "@/features/documents/components/documents-table";
import { DOCUMENT_PAY_FILTERS, DOCUMENT_PAY_STATE_LABELS } from "@/features/documents/pay-state";
import { DOCUMENT_TYPE_LABELS, DOCUMENT_TYPES } from "@/features/documents/schema";
import { resolveColumns } from "@/features/list-columns/columns";
import { ColumnsPanel } from "@/features/list-columns/components/columns-panel";
import { getListColumns } from "@/features/list-columns/queries";
import { ExportMenu, exportHref } from "@/features/list-export/components/export-menu";
import { AdvancedFilter } from "@/features/list-filters/components/advanced-filter";
import { prepareListFilter, startListFilterLookups } from "@/features/list-filters/prepare";
import { getMyPermissions } from "@/features/permissions/queries";
import { canExport } from "@/features/reports/request";
import { getOrgContext, getUserNames } from "@/features/shell/queries";
import { documentsListTexts } from "@/features/documents/texts";
import { getOrgTerms } from "@/features/terminology/queries";
import { SavedViewsBar } from "@/features/views/components/saved-views-bar";
import { viewChips } from "@/features/views/server";
import { formatDate, formatMoney } from "@/lib/format";
import { firstParam } from "@/lib/search";
import { nextSort, sortValue } from "@/lib/sort";

export const metadata: Metadata = { title: "מסמכים חשבונאיים" };

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * LST-09 (owner, 21 October 2026): every accounting document the user may read (DOC-01; the documents of deals and contacts
 * they read), with the shared list pieces: the list's selects, the advanced filter, the user's columns, saved views, sorting
 * by any column and export (all of it, or the picked rows). Totals per document type over everything the filters find,
 * documents in force only, never netted. Nothing is edited here: a document is recorded and cancelled on its record's card.
 * Shown while the plan has the `documents` key.
 */
export default async function DocumentsPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const [context, access, terms, collection, allocation] = await Promise.all([
    getOrgContext(orgId),
    getDocumentsAccess(orgId),
    getOrgTerms(orgId),
    getCollectionAccess(orgId),
    getAllocationAccess(orgId),
  ]);
  // DOC-03: payment states and balances only with the payments key (PAY-02's rule)
  const payments = allocation.inPlan;
  // RVW-49: the business's own words (FLD-10)
  const texts = documentsListTexts(terms);
  if (!access.inPlan) {
    return (
      <>
        <PageHeader title="מסמכים חשבונאיים" />
        <Card>
          <CardBody>
            <p>מסמכים חשבונאיים לא כלולים בחבילה של העסק.</p>
          </CardBody>
        </Card>
      </>
    );
  }
  const query = await searchParams;
  const parsedFilters = documentListFilters(query);
  const filters = payments ? parsedFilters : { ...parsedFilters, pay: null };
  const sort = filters.sort ?? DOCUMENT_DEFAULT_SORT;
  // FXC-09: the columns and the filter's choices load side by side; prepareListFilter reuses the same reads
  const [granted, listColumns] = await Promise.all([
    // PRM-01: extra permissions (export)
    getMyPermissions(orgId),
    getListColumns(orgId, "document"),
    startListFilterLookups(orgId, "document"),
  ]);
  const filter = await prepareListFilter(orgId, "document", firstParam(query.f), context.user.id, []);
  const filterParam = filter.tree ? JSON.stringify(filter.tree) : null;
  const listed = { ...filters, filter: filter.logic };
  const [{ documents, hasMore }, totals, viewData] = await Promise.all([
    listDocuments(orgId, listed),
    listDocumentTotals(orgId, listed),
    viewChips(orgId, "document", context),
  ]);
  const [names, payStates] = await Promise.all([
    getUserNames(documents.map((doc) => doc.createdBy)),
    payments ? listDocumentPayStates(orgId, documents) : Promise.resolve(null),
  ]);
  const views = viewData.chips;
  const activeView = views.find((view) => view.id === firstParam(query.sv)) ?? null;
  const shownColumns = activeView?.config.columns ? resolveColumns("document", activeView.config.columns, listColumns.catalog) : listColumns.columns;
  const exportAllowed = canExport(context.role, granted);
  const filtered =
    filters.type !== null || filters.status !== null || filters.from !== null || filters.to !== null || Boolean(filters.pay) || Boolean(filters.customer) || filter.tree !== null;

  const extra = { f: filterParam, sv: activeView?.id ?? null };
  const hrefFor = (target: number) => documentListHref(orgId, filters, target, extra);
  // a new sort starts again from the first page
  const sortHref = (key: string) =>
    documentListHref(orgId, { ...filters, sort: nextSort(sort, key as DocumentSortKey, documentSortStartsAscending(key as DocumentSortKey)) }, 1, extra);
  // what the advanced filter and a saved view keep from the page's own selects
  const kept: Record<string, string> = Object.fromEntries(
    Object.entries({
      type: filters.type ?? "",
      status: filters.status ?? "",
      from: filters.from ?? "",
      to: filters.to ?? "",
      pay: filters.pay ?? "",
      ...(filters.customer ? { [filters.customer.kind]: filters.customer.id, [`${filters.customer.kind}__label`]: filters.customer.label } : {}),
    }).filter(([, value]) => value !== ""),
  );
  // GAP-12: an opening balance's debts and credits are two lines, never netted
  const totalLines = DOCUMENT_TOTAL_KEYS.flatMap((key) => {
    const total = totals.totals.get(key);
    return total ? [{ key, ...total }] : [];
  });

  return (
    <>
      <PageHeader
        title="מסמכים חשבונאיים"
        description={texts.description}
        actions={
          <span className="flex flex-wrap items-center gap-2">
            {/* COL-01 */}
            {collection.canOpen ? (
              <Link href={collectionPath(orgId)} className={buttonClasses("secondary", "sm")}>
                גבייה
              </Link>
            ) : null}
            {exportAllowed ? <ExportMenu href={exportHref(documentsPath(orgId), documentListHref(orgId, filters, 1, { f: filterParam }))} /> : null}
          </span>
        }
      />
      <SavedViewsBar
        orgId={orgId}
        objectType="document"
        listPath={documentsPath(orgId)}
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
        <AdvancedFilter fields={filter.fields} current={filter.tree} skipped={filter.skipped} listPath={documentsPath(orgId)} keep={kept} />
        {activeView?.config.columns ? (
          <p className="py-2 text-sm text-ink-soft">העמודות לפי התצוגה &quot;{activeView.name}&quot;</p>
        ) : (
          <ColumnsPanel orgId={orgId} object="document" catalog={listColumns.catalog} columns={listColumns.columns} saved={listColumns.saved} />
        )}
      </div>
      <form method="get" action={documentsPath(orgId)} className="mb-5 flex flex-wrap items-end gap-3" aria-label="סינון מסמכים">
        {/* the advanced filter and the sort stay when a select changes */}
        {filterParam ? <input type="hidden" name="f" value={filterParam} /> : null}
        {sortValue(sort) !== sortValue(DOCUMENT_DEFAULT_SORT) ? <input type="hidden" name="sort" value={sortValue(sort)} /> : null}
        <label>
          <span className="mb-1.5 block text-sm font-medium">סוג</span>
          <Select name="type" defaultValue={filters.type ?? ""} className="w-44">
            <option value="">הכול</option>
            {DOCUMENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {DOCUMENT_TYPE_LABELS[type]}
              </option>
            ))}
          </Select>
        </label>
        <label>
          <span className="mb-1.5 block text-sm font-medium">מצב</span>
          <Select name="status" defaultValue={filters.status ?? ""} className="w-32">
            <option value="">הכול</option>
            {DOCUMENT_LIST_STATUSES.map((status) => (
              <option key={status} value={status}>
                {DOCUMENT_LIST_STATUS_LABELS[status]}
              </option>
            ))}
          </Select>
        </label>
        {payments ? (
          <label>
            <span className="mb-1.5 block text-sm font-medium">מצב תשלום</span>
            <Select name="pay" defaultValue={filters.pay ?? ""} className="w-36">
              <option value="">הכול</option>
              {DOCUMENT_PAY_FILTERS.map((state) => (
                <option key={state} value={state}>
                  {DOCUMENT_PAY_STATE_LABELS[state]}
                </option>
              ))}
            </Select>
          </label>
        ) : null}
        <DocumentCustomerFilter
          orgId={orgId}
          contact={filters.customer?.kind === "contact" ? { id: filters.customer.id, label: filters.customer.label || "איש קשר" } : null}
          company={filters.customer?.kind === "company" ? { id: filters.customer.id, label: filters.customer.label || "חברה" } : null}
        />
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
          <Link href={documentsPath(orgId)} className={buttonClasses("ghost", "md")}>
            ניקוי הסינון
          </Link>
        ) : null}
      </form>
      {totalLines.length > 0 ? (
        <section aria-labelledby="documents-totals" className="mb-5 rounded-lg border border-line bg-surface px-4 py-3">
          {/* DOC-03: the summary line */}
          <h2 id="documents-totals" className="mb-2 text-sm font-semibold">
            סיכום {filtered ? "(לפי הסינון)" : ""}
          </h2>
          <p className="mb-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <span>
              מסמכים בתוקף: <span className="font-medium tabular-nums">{totals.summary.count.toLocaleString("he-IL")}</span>
            </span>
            {totals.summary.open !== null ? (
              <span>
                יתרה פתוחה: <span className="font-medium tabular-nums">{formatMoney(totals.summary.open)}</span>
              </span>
            ) : null}
            {totals.summary.overdue !== null ? (
              <span>
                מתוכה באיחור: <span className="font-medium tabular-nums">{formatMoney(totals.summary.overdue)}</span>
              </span>
            ) : null}
            {/* COL-01's partial rule: the balances are summed only for whoever reads every money row of the business */}
            {payments && totals.summary.partial ? <span className="text-ink-soft">רשימה חלקית: היתרות לא מסוכמות, כי יש מסמכים או תשלומים שאינם גלויים לכם.</span> : null}
          </p>
          <ul className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            {totalLines.map((line) => (
              <li key={line.key}>
                {DOCUMENT_TOTAL_LABELS[line.key]}: <span className="font-medium tabular-nums">{formatMoney(line.agorot)}</span>{" "}
                <span className="text-ink-soft">({line.count === 1 ? "מסמך אחד" : `${line.count.toLocaleString("he-IL")} מסמכים`})</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-sm text-ink-soft">
            רק מסמכים בתוקף. כל סוג בנפרד: חשבונית זיכוי לא מקוזזת מהחשבוניות, ויתרות פתיחה של חוב ושל זכות מוצגות בנפרד.
            {totals.complete ? "" : ` הסיכום לפי ${DOCUMENT_TOTALS_LIMIT.toLocaleString("he-IL")} המסמכים הראשונים; צמצמו בסינון לסיכום מלא.`}
          </p>
        </section>
      ) : null}
      {documents.length === 0 ? (
        <Card>
          <EmptyState
            title={filtered ? "אין מסמכים לפי הסינון" : "עוד לא נרשמו מסמכים"}
            description={filtered ? "נסו סינון אחר, או נקו אותו." : texts.empty}
          />
        </Card>
      ) : (
        <>
          <ul aria-label="מסמכים חשבונאיים" className="divide-y divide-line rounded-lg border border-line bg-surface md:hidden">
            {documents.map((doc) => {
              const home = documentHome(orgId, doc);
              return (
                <li key={doc.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3">
                  <div className="min-w-0">
                    {home ? (
                      <Link href={home} className="font-medium text-accent-strong underline-offset-4 hover:underline">
                        <DocumentName doc={doc} />
                      </Link>
                    ) : (
                      <span className="font-medium">
                        <DocumentName doc={doc} />
                      </span>
                    )}
                    <p className="text-sm text-ink-soft">
                      {doc.customer ? (
                        <>
                          <bdi>{doc.customer}</bdi>
                          {" · "}
                        </>
                      ) : null}
                      {formatDate(`${doc.docDate}T12:00:00Z`)}
                    </p>
                  </div>
                  <span className="flex items-center gap-2 text-sm">
                    {payStates?.get(doc.id) ? (
                      <PayStateBadge state={payStates.get(doc.id)!.payState} />
                    ) : doc.cancelled ? (
                      <Badge tone="warning">בוטל</Badge>
                    ) : null}
                    <span className={`font-medium whitespace-nowrap tabular-nums ${doc.cancelled ? "text-ink-soft line-through" : ""}`}>{formatMoney(doc.amountAgorot)}</span>
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="hidden md:block">
            <DocumentsTable
              orgId={orgId}
              documents={documents}
              columns={shownColumns}
              catalog={listColumns.catalog}
              recorderNames={names}
              payStates={payStates}
              sort={sort}
              sortHref={sortHref}
              exportPath={exportAllowed ? `${documentsPath(orgId)}/export` : null}
            />
          </div>
        </>
      )}
      <Pagination page={filters.page} hasMore={hasMore} hrefFor={hrefFor} className="mt-4" />
    </>
  );
}
