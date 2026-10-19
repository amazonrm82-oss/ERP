import { isCalendarDate } from "@/lib/calendar-date";
import { isUuid } from "@/lib/paths";
import { parsePage } from "@/lib/search";

import { ordersPath } from "./paths";
import type { OrderListFilters } from "./queries";
import { isOrderSource, isOrderStatus } from "./schema";

// ORD-06 part one: the filters of the orders list, read from the address; anything not valid is left out, never trusted.

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export function orderListFilters(params: Record<string, string | string[] | undefined>): OrderListFilters {
  const status = one(params.status);
  const source = one(params.source);
  const owner = one(params.owner);
  let from = one(params.from) ?? "";
  let to = one(params.to) ?? "";
  from = isCalendarDate(from) ? from : "";
  to = isCalendarDate(to) ? to : "";
  // a range typed backwards is read the right way round
  if (from && to && from > to) [from, to] = [to, from];
  return {
    status: isOrderStatus(status) ? status : null,
    source: isOrderSource(source) ? source : null,
    ownerId: owner && isUuid(owner) ? owner : null,
    from: from || null,
    to: to || null,
    page: parsePage(params.page),
  };
}

export function isFiltered(filters: OrderListFilters): boolean {
  return filters.status !== null || filters.source !== null || filters.ownerId !== null || filters.from !== null || filters.to !== null;
}

export function orderListHref(orgId: string, filters: OrderListFilters, page = filters.page): string {
  const query = new URLSearchParams();
  if (filters.status) query.set("status", filters.status);
  if (filters.source) query.set("source", filters.source);
  if (filters.ownerId) query.set("owner", filters.ownerId);
  if (filters.from) query.set("from", filters.from);
  if (filters.to) query.set("to", filters.to);
  if (page > 1) query.set("page", String(page));
  const text = query.toString();
  return text ? `${ordersPath(orgId)}?${text}` : ordersPath(orgId);
}
