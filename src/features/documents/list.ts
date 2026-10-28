import { isCalendarDate } from "@/lib/calendar-date";
import { isUuid } from "@/lib/paths";
import { parsePage } from "@/lib/search";
import { parseSort, sortValue, type Sort } from "@/lib/sort";

import { isDocumentPayFilter, type DocumentPayFilter } from "./pay-state";
import { documentsPath } from "./paths";
import { DOCUMENT_TYPE_LABELS, DOCUMENT_TYPES, isDocumentType, isOpeningBalance, type DocumentType } from "./schema";

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
  // DOC-03
  due: "due_date",
  recorder: "sort_recorder",
  created: "created_at",
} as const;
export type DocumentSortKey = keyof typeof DOCUMENT_SORT_COLUMNS;
export const DOCUMENT_DEFAULT_SORT: Sort<DocumentSortKey> = { key: "date", ascending: false };
// a header's first click: names from A, dates and sums from the highest
export const documentSortStartsAscending = (key: DocumentSortKey) =>
  key === "name" || key === "type" || key === "customer" || key === "status" || key === "recorder" || key === "due";

export const DOCUMENT_LIST_STATUSES = ["active", "cancelled"] as const;
export type DocumentListStatus = (typeof DOCUMENT_LIST_STATUSES)[number];
export const DOCUMENT_LIST_STATUS_LABELS: Record<DocumentListStatus, string> = { active: "בתוקף", cancelled: "בוטל" };
const isListStatus = (value: unknown): value is DocumentListStatus => value === "active" || value === "cancelled";

/** DOC-03: the documents of one customer (public.documents_by_pay_state's scope). */
export type DocumentCustomerFilter = { kind: "contact" | "company"; id: string; label: string };

/** Whether the list must read through public.documents_by_pay_state (a payment state or a customer is asked). */
export const needsPayStateRead = (filters: Pick<DocumentListFilters, "pay" | "customer">) => Boolean(filters.pay || filters.customer);

export type DocumentListFilters = {
  type: DocumentType | null;
  status: DocumentListStatus | null;
  // the document's date, inclusive
  from: string | null;
  to: string | null;
  // DOC-03: the payment state (only with the `payments` key; the page drops it otherwise) and one customer (a contact or a
  // company; its label rides along in the address for the picker)
  pay?: DocumentPayFilter | null;
  customer?: DocumentCustomerFilter | null;
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
  const pay = one(params.pay);
  const contact = one(params.contact) ?? "";
  const company = one(params.company) ?? "";
  const label = (value: string | undefined) => (value ?? "").trim().slice(0, 200);
  return {
    type: isDocumentType(type) ? type : null,
    status: isListStatus(status) ? status : null,
    from: from || null,
    to: to || null,
    pay: isDocumentPayFilter(pay) ? pay : null,
    customer: isUuid(contact)
      ? { kind: "contact", id: contact, label: label(one(params.contact__label)) }
      : isUuid(company)
        ? { kind: "company", id: company, label: label(one(params.company__label)) }
        : null,
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
  if (filters.pay) query.set("pay", filters.pay);
  if (filters.customer) {
    query.set(filters.customer.kind, filters.customer.id);
    if (filters.customer.label) query.set(`${filters.customer.kind}__label`, filters.customer.label);
  }
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
export function documentTotalsByType(rows: readonly { docType: DocumentType; amountAgorot: number; cancelled: boolean }[]): Map<DocumentTotalKey, { count: number; agorot: number }> {
  const totals = new Map<DocumentTotalKey, { count: number; agorot: number }>();
  for (const row of rows) {
    if (row.cancelled) continue;
    const key = documentTotalKey(row.docType, row.amountAgorot);
    const current = totals.get(key) ?? { count: 0, agorot: 0 };
    // an opening credit is counted by its size on its own line
    totals.set(key, { count: current.count + 1, agorot: current.agorot + Math.abs(row.amountAgorot) });
  }
  return totals;
}

/**
 * GAP-12: the totals' lines. An opening balance is never netted either: its debts and its credits are two lines; every
 * other type is one line.
 */
export type DocumentTotalKey = Exclude<DocumentType, "opening_balance"> | "opening_debt" | "opening_credit";
export const DOCUMENT_TOTAL_KEYS: readonly DocumentTotalKey[] = DOCUMENT_TYPES.flatMap((type): DocumentTotalKey[] =>
  isOpeningBalance(type) ? ["opening_debt", "opening_credit"] : [type as Exclude<DocumentType, "opening_balance">],
);
export const DOCUMENT_TOTAL_LABELS: Record<DocumentTotalKey, string> = {
  ...(Object.fromEntries(DOCUMENT_TYPES.filter((type) => !isOpeningBalance(type)).map((type) => [type, DOCUMENT_TYPE_LABELS[type]])) as Record<
    Exclude<DocumentType, "opening_balance">,
    string
  >),
  opening_debt: "יתרת פתיחה (חוב)",
  opening_credit: "יתרת פתיחה (זכות)",
};
export function documentTotalKey(type: DocumentType, amountAgorot: number): DocumentTotalKey {
  if (isOpeningBalance(type)) return amountAgorot < 0 ? "opening_credit" : "opening_debt";
  return type as Exclude<DocumentType, "opening_balance">;
}

/**
 * DOC-03: the list's summary line (public.documents_pay_summary): how many documents in force the filters find, and (with the
 * payments key, and only when the caller reads every money row of the business: COL-01's partial rule) the open balance and
 * its part past the due date. `partial` = balances not shown ("רשימה חלקית").
 */
export type DocumentListSummary = { count: number; open: number | null; overdue: number | null; partial: boolean };
