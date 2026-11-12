// SUB-01: the recurring billings screens (under payments, like collection and cheques).
export const recurringBillingsPath = (orgId: string) => `/o/${orgId}/payments/recurring`;
export const recurringBillingPath = (orgId: string, billingId: string) => `/o/${orgId}/payments/recurring/${billingId}`;
