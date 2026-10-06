// Lists that support saved views, and the URL filters a view stores.
export const VIEW_OBJECTS = ["lead", "contact", "company"] as const;
export type ViewObject = (typeof VIEW_OBJECTS)[number];

export const VIEW_FILTER_KEYS = ["q", "status", "tag"] as const;
export type ViewFilters = Partial<Record<(typeof VIEW_FILTER_KEYS)[number], string>>;

/** Only the known filter keys, as non-empty strings. */
export function cleanFilters(input: Record<string, unknown>): ViewFilters {
  const filters: ViewFilters = {};
  for (const key of VIEW_FILTER_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim() !== "") {
      filters[key] = value.trim().slice(0, 200);
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
