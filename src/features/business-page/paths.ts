// BIZ-01: the business page's pages. The public ones sit under the proxy's public prefixes (/f/, /api/forms/).
export const businessPageSettingsPath = (orgId: string) => `/o/${orgId}/settings/business-page`;
export const publicBusinessPagePath = (token: string) => `/f/biz/${token}`;
export const businessPageSubmitPath = (token: string) => `/api/forms/biz/${token}`;
