// DQL-01 pages. Kept here rather than in src/lib/paths.ts (shared); the lead may move them there when merging.
export const completenessSettingsPath = (orgId: string) => `/o/${orgId}/settings/completeness`;
export const toCompletePath = (orgId: string) => `/o/${orgId}/reports/to-complete`;
// DQL-03
export const cleanupPath = (orgId: string) => `/o/${orgId}/reports/cleanup`;
