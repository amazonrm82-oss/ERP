// The settings page of the response target (CAP-10). Kept here rather than in
// src/lib/paths.ts (shared); the lead may move it there when merging.
export const responseSettingsPath = (orgId: string) => `/o/${orgId}/settings/response`;
