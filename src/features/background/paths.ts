/** IMP-04: the export's download: a one-minute signed link made with the user's own session. */
export const backgroundDownloadPath = (orgId: string, requestId: string) => `/o/${orgId}/settings/import/background/${requestId}`;
