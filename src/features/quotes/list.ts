import { isCalendarDate } from "@/lib/calendar-date";
import { isUuid } from "@/lib/paths";
import { parsePage } from "@/lib/search";

import { quotesPath } from "./paths";
import type { QuoteListFilters } from "./queries";
import { isQuoteStatus } from "./schema";

// QUO-16: the filters of the quotes list, read from the address; anything not valid is left out, never trusted.

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
  };
}

export function quoteListHref(orgId: string, filters: QuoteListFilters, page = filters.page): string {
  const query = new URLSearchParams();
  if (filters.status) query.set("status", filters.status);
  if (filters.ownerId) query.set("owner", filters.ownerId);
  if (filters.from) query.set("from", filters.from);
  if (filters.to) query.set("to", filters.to);
  if (page > 1) query.set("page", String(page));
  const text = query.toString();
  return text ? `${quotesPath(orgId)}?${text}` : quotesPath(orgId);
}
