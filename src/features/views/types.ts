import type { ColumnChoice } from "@/features/list-columns/columns";

// Lists that support saved views, and what a view stores: the URL filters, the
// sort and the columns (LST-04).
export const VIEW_OBJECTS = ["lead", "contact", "company", "deal", "task", "product", "quote"] as const;
export type ViewObject = (typeof VIEW_OBJECTS)[number];

// "f": the advanced filter (LST-05), as JSON; "pipeline" and "view": the deals table (LST-09); "who": the tasks list;
// "category" and "kind": the product catalog's own selects (LST-09); "owner", "from" and "to": the quotes list's (LST-09)
export const VIEW_FILTER_KEYS = ["q", "status", "tag", "f", "pipeline", "view", "who", "category", "kind", "owner", "from", "to"] as const;
export type ViewFilters = Partial<Record<(typeof VIEW_FILTER_KEYS)[number], string>>;

/** Only the known filter keys, as non-empty strings. */
export function cleanFilters(input: Record<string, unknown>): ViewFilters {
  const filters: ViewFilters = {};
  for (const key of VIEW_FILTER_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim() !== "") {
      filters[key] = value.trim().slice(0, key === "f" ? 4000 : 200);
    }
  }
  return filters;
}

export function filtersQuery(filters: ViewFilters): string {
  const params = new URLSearchParams();
  for (const key of VIEW_FILTER_KEYS) {
    if (filters[key]) params.set(key, filters[key]);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

// the sort as in the URL ("name", "-created", "cf:f_x"); checked again by the list that applies it
export const VIEW_SORT_RE = /^-?(?:[a-z_]{1,30}|cf:[a-z][a-z0-9_]{0,39})$/;

export type ViewConfig = { filters: ViewFilters; sort: string | null; columns: ColumnChoice[] | null };

/** A view's address: its filters and sort, and `sv` so the list knows to use the view's columns. */
export function viewHref(listPath: string, viewId: string, config: ViewConfig): string {
  const params = new URLSearchParams();
  for (const key of VIEW_FILTER_KEYS) {
    if (config.filters[key]) params.set(key, config.filters[key]);
  }
  if (config.sort) params.set("sort", config.sort);
  params.set("sv", viewId);
  return `${listPath}?${params.toString()}`;
}
