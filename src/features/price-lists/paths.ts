// The price lists' pages (PL-01). Kept here rather than in src/lib/paths.ts (shared); the lead may move them there when merging.
export const priceListsPath = (orgId: string) => `/o/${orgId}/settings/price-lists`;
export const priceListPath = (orgId: string, listId: string) => `/o/${orgId}/settings/price-lists/${listId}`;
