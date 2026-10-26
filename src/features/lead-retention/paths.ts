/** PRV-01: the lead retention policy (settings, owners and admins) and the open round's list. */
export const retentionSettingsPath = (orgId: string) => `/o/${orgId}/settings/retention`;
export const retentionListPath = (orgId: string, page = 1) =>
  `/o/${orgId}/settings/retention/list${page > 1 ? `?page=${page}` : ""}`;
