// PRK-02: the staff screens of privacy requests (owners and admins)
export const privacyRequestsPath = (orgId: string) => `/o/${orgId}/settings/privacy/requests`;
export const privacyRequestPath = (orgId: string, requestId: string) => `/o/${orgId}/settings/privacy/requests/${requestId}`;
