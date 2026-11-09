// CAP-11: the settings page, and the webhook Meta posts to (a public prefix of the proxy: /api/meta/leads).
export const metaLeadsSettingsPath = (orgId: string) => `/o/${orgId}/settings/meta-leads`;
export const metaWebhookPath = "/api/meta/leads";
