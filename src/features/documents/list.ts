import { isCalendarDate } from "@/lib/calendar-date";
import { parsePage } from "@/lib/search";
import { parseSort, sortValue, type Sort } from "@/lib/sort";

import { documentsPath } from "./paths";
import { isDocumentType, type DocumentType } from "./schema";

// LST-09: the business-wide list of accounting documents (DOC-01): its own selects, its sort and its address. Anything in
// the address that is not valid is left out, never trusted.

// every column sorts (sort_customer, sort_recorder: computed fields, migration money_list_tables); "name" is the first
// column (type and number), sorted by the number
export const DOCUMENT_SORT_COLUMNS = {
  name: "number",
  type: "doc_type",
  customer: "sort_customer",
  date: "doc_date",
  amount: "amount_agorot",
  status: "status",
  recorder: "sort_recorder",
  created: "created_at",
} as const;
export type DocumentSortKey = keyof typeof DOCUMENT_SORT_COLUMNS;
export const DOCUMENT_DEFAULT_SORT: Sort<DocumentSortKey> = { key: "date", ascending: false };
// a header's first click: names from A, dates and sums from the highest
export const documentSortStartsAscending = (key: DocumentSortKey) =>
  key === "name" || key === "type" || key === "customer" || key === "status" || key === "recorder";

export const DOCUMENT_LIST_STATUSES = ["active", "cancelled"] as const;
export type DocumentListStatus = (typeof DOCUMENT_LIST_STATUSES)[number];
export const DOCUMENT_LIST_STATUS_LABELS: Record<DocumentListStatus, string> = { active: "בתוקף", cancelled: "בוטל" };
const isListStatus = (value: unknown): value is DocumentListStatus => value === "active" || value === "cancelled";

export type DocumentListFilters = {
  type: DocumentType | null;
  status: DocumentListStatus | null;
  // the document's date, inclusive
  from: string | null;
  to: string | null;
  page: number;
  sort?: Sort<DocumentSortKey>;
  // LST-05: the advanced filter as one PostgREST logic tree (prepareListFilter), or null
  filter?: string | null;
  // LST-08: only these documents (the rows picked in the list); the other filters are then ignored
  ids?: string[];
  // LST-08: an export reads the list in larger chunks instead of a page
  chunk?: { from: number; size: number };
};

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export function documentListFilters(params: Record<string, string | string[] | undefined>): DocumentListFilters {
  const type = one(params.type);
  const status = one(params.status);
  let from = one(params.from) ?? "";
  let to = one(params.to) ?? "";
  from = isCalendarDate(from) ? from : "";
  to = isCalendarDate(to) ? to : "";
  // a range typed backwards is read the right way round
  if (from && to && from > to) [from, to] = [to, from];
  return {
    type: isDocumentType(type) ? type : null,
    status: isListStatus(status) ? status : null,
    from: from || null,
    to: to || null,
    page: parsePage(params.page),
    sort: parseSort(one(params.sort) ?? "", Object.keys(DOCUMENT_SORT_COLUMNS) as DocumentSortKey[], DOCUMENT_DEFAULT_SORT),
  };
}

/** The list's address with its selects, sort and page; `extra` keeps the advanced filter ("f") and the saved view ("sv"). */
export function documentListHref(orgId: string, filters: DocumentListFilters, page = filters.page, extra: { f?: string | null; sv?: string | null } = {}): string {
  const query = new URLSearchParams();
  if (filters.type) query.set("type", filters.type);
  if (filters.status) query.set("status", filters.status);
  if (filters.from) query.set("from", filters.from);
  if (filters.to) query.set("to", filters.to);
  if (filters.sort && sortValue(filters.sort) !== sortValue(DOCUMENT_DEFAULT_SORT)) query.set("sort", sortValue(filters.sort));
  if (extra.f) query.set("f", extra.f);
  if (extra.sv) query.set("sv", extra.sv);
  if (page > 1) query.set("page", String(page));
  const text = query.toString();
  return text ? `${documentsPath(orgId)}?${text}` : documentsPath(orgId);
}

/**
 * Owner, 21 October 2026: the list's totals are per document type and never netted (a credit invoice is its own line, not
 * taken off the invoices). Only documents in force count; a cancelled one counts nowhere.
 */
export function documentTotalsByType(rows: readonly { docType: DocumentType; amountAgorot: number; cancelled: boolean }[]): Map<DocumentType, { count: number; agorot: number }> {
  const totals = new Map<DocumentType, { count: number; agorot: number }>();
  for (const row of rows) {
    if (row.cancelled) continue;
    const current = totals.get(row.docType) ?? { count: 0, agorot: 0 };
    totals.set(row.docType, { count: current.count + 1, agorot: current.agorot + row.amountAgorot });
  }
  return totals;
}
