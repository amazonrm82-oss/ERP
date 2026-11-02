// CON-11: the settings page of the customer status thresholds. Kept here rather than in src/lib/paths.ts (shared).
export const customerStatusSettingsPath = (orgId: string) => `/o/${orgId}/settings/customer-status`;
// RET-01: the dormant customers list
export const dormantCustomersPath = (orgId: string) => `/o/${orgId}/contacts/dormant`;
