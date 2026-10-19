import { isCalendarDate } from "@/lib/calendar-date";
import { isUuid } from "@/lib/paths";
import { parsePage } from "@/lib/search";
import { parseSort, sortValue, type Sort } from "@/lib/sort";

import { quotesPath } from "./paths";
import type { QuoteListFilters } from "./queries";
import { isQuoteStatus } from "./schema";

// QUO-16: the filters of the quotes list, read from the address; anything not valid is left out, never trusted.

// LST-09: every column of the quotes table sorts (sort_owner, sort_customer: computed fields, migration quote_list_tables);
// "name" is the first column (number and title), sorted by the running number, so drafts (no number) come last
export const QUOTE_SORT_COLUMNS = {
  name: "number",
  status: "status",
  customer: "sort_customer",
  owner: "sort_owner",
  quote_date: "quote_date",
  valid_until: "valid_until",
  sent: "sent_at",
  total: "total_agorot",
  created: "created_at",
} as const;
export type QuoteSortKey = keyof typeof QUOTE_SORT_COLUMNS;
export const QUOTE_DEFAULT_SORT: Sort<QuoteSortKey> = { key: "quote_date", ascending: false };
// a header's first click: names and statuses from A, dates and sums from the highest
export const quoteSortStartsAscending = (key: QuoteSortKey) => key === "name" || key === "status" || key === "customer" || key === "owner";

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export function quoteListFilters(params: Record<string, string | string[] | undefined>): QuoteListFilters {
  const status = one(params.status);
  const owner = one(params.owner);
  let from = one(params.from) ?? "";
  let to = one(params.to) ?? "";
  from = isCalendarDate(from) ? from : "";
  to = isCalendarDate(to) ? to : "";
  // a range typed backwards is read the right way round
  if (from && to && from > to) [from, to] = [to, from];
  return {
    status: isQuoteStatus(status) ? status : null,
    ownerId: owner && isUuid(owner) ? owner : null,
    from: from || null,
    to: to || null,
    page: parsePage(params.page),
    sort: parseSort(one(params.sort) ?? "", Object.keys(QUOTE_SORT_COLUMNS) as QuoteSortKey[], QUOTE_DEFAULT_SORT),
  };
}

/**
 * The list's address with its filters, sort and page; `extra` keeps the advanced filter (its JSON tree, "f") and the
 * saved view on screen ("sv").
 */
export function quoteListHref(orgId: string, filters: QuoteListFilters, page = filters.page, extra: { f?: string | null; sv?: string | null } = {}): string {
  const query = new URLSearchParams();
  if (filters.status) query.set("status", filters.status);
  if (filters.ownerId) query.set("owner", filters.ownerId);
  if (filters.from) query.set("from", filters.from);
  if (filters.to) query.set("to", filters.to);
  if (filters.sort && sortValue(filters.sort) !== sortValue(QUOTE_DEFAULT_SORT)) query.set("sort", sortValue(filters.sort));
  if (extra.f) query.set("f", extra.f);
  if (extra.sv) query.set("sv", extra.sv);
  if (page > 1) query.set("page", String(page));
  const text = query.toString();
  return text ? `${quotesPath(orgId)}?${text}` : quotesPath(orgId);
}
