// BIZ-05: the prefill form's pages. The public ones sit under the proxy's public prefixes (/f/, /api/forms/).
export const prefillFormsSettingsPath = (orgId: string) => `/o/${orgId}/settings/prefill-forms`;
export const publicPrefillPath = (token: string) => `/f/fill/${token}`;
export const prefillSubmitPath = (token: string) => `/api/forms/fill/${token}`;
