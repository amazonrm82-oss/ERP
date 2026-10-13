// The product catalog's pages (PRD-01, PRD-04). Kept here rather than in
// src/lib/paths.ts (shared); the lead may move them there when merging.
export const productsPath = (orgId: string) => `/o/${orgId}/products`;
export const productNewPath = (orgId: string) => `/o/${orgId}/products/new`;
export const productPath = (orgId: string, productId: string) => `/o/${orgId}/products/${productId}`;
export const productListsSettingsPath = (orgId: string) => `/o/${orgId}/settings/product-lists`;
