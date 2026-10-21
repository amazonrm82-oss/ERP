import { isCalendarDate } from "@/lib/calendar-date";
import { parsePage } from "@/lib/search";
import { parseSort, sortValue, type Sort } from "@/lib/sort";

import { paymentsPath } from "./paths";
import { isPaymentMethod, isPaymentStatus, type PaymentMethod, type PaymentStatus } from "./schema";

// LST-09: the business-wide list of payments (PAY-01): its own selects, its sort and its address. Anything in the address
// that is not valid is left out, never trusted.

// every column sorts (sort_customer, sort_recorder: computed fields, migration money_list_tables); "name" is the first
// column (the amount), sorted by the amount
export const PAYMENT_SORT_COLUMNS = {
  name: "amount_agorot",
  customer: "sort_customer",
  date: "paid_on",
  method: "method",
  installments: "installments",
  reference: "reference",
  status: "status",
  recorder: "sort_recorder",
  created: "created_at",
} as const;
export type PaymentSortKey = keyof typeof PAYMENT_SORT_COLUMNS;
export const PAYMENT_DEFAULT_SORT: Sort<PaymentSortKey> = { key: "date", ascending: false };
// a header's first click: names from A, dates and sums from the highest
export const paymentSortStartsAscending = (key: PaymentSortKey) =>
  key === "customer" || key === "method" || key === "reference" || key === "status" || key === "recorder";

export type PaymentListFilters = {
  status: PaymentStatus | null;
  method: PaymentMethod | null;
  // the payment's date, inclusive
  from: string | null;
  to: string | null;
  page: number;
  sort?: Sort<PaymentSortKey>;
  // LST-05: the advanced filter as one PostgREST logic tree (prepareListFilter), or null
  filter?: string | null;
  // LST-08: only these payments (the rows picked in the list); the other filters are then ignored
  ids?: string[];
  // LST-08: an export reads the list in larger chunks instead of a page
  chunk?: { from: number; size: number };
};

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export function paymentListFilters(params: Record<string, string | string[] | undefined>): PaymentListFilters {
  const status = one(params.status);
  const method = one(params.method);
  let from = one(params.from) ?? "";
  let to = one(params.to) ?? "";
  from = isCalendarDate(from) ? from : "";
  to = isCalendarDate(to) ? to : "";
  // a range typed backwards is read the right way round
  if (from && to && from > to) [from, to] = [to, from];
  return {
    status: isPaymentStatus(status) ? status : null,
    method: isPaymentMethod(method) ? method : null,
    from: from || null,
    to: to || null,
    page: parsePage(params.page),
    sort: parseSort(one(params.sort) ?? "", Object.keys(PAYMENT_SORT_COLUMNS) as PaymentSortKey[], PAYMENT_DEFAULT_SORT),
  };
}

/** The list's address with its selects, sort and page; `extra` keeps the advanced filter ("f") and the saved view ("sv"). */
export function paymentListHref(orgId: string, filters: PaymentListFilters, page = filters.page, extra: { f?: string | null; sv?: string | null } = {}): string {
  const query = new URLSearchParams();
  if (filters.status) query.set("status", filters.status);
  if (filters.method) query.set("method", filters.method);
  if (filters.from) query.set("from", filters.from);
  if (filters.to) query.set("to", filters.to);
  if (filters.sort && sortValue(filters.sort) !== sortValue(PAYMENT_DEFAULT_SORT)) query.set("sort", sortValue(filters.sort));
  if (extra.f) query.set("f", extra.f);
  if (extra.sv) query.set("sv", extra.sv);
  if (page > 1) query.set("page", String(page));
  const text = query.toString();
  return text ? `${paymentsPath(orgId)}?${text}` : paymentsPath(orgId);
}
