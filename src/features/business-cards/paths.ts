// BIZ-02: the business card's pages. The public ones sit under the proxy's public prefixes (/f/, /api/forms/).
export const businessCardSettingsPath = (orgId: string) => `/o/${orgId}/settings/business-card`;
export const publicCardPath = (token: string) => `/f/card/${token}`;
export const cardSubmitPath = (token: string) => `/api/forms/card/${token}`;
export const cardVCardPath = (token: string) => `/api/forms/card/${token}/vcard`;
