/** ORD-01: every order the user reads, and one order. */
export const ordersPath = (orgId: string) => `/o/${orgId}/orders`;
export const orderPath = (orgId: string, orderId: string) => `/o/${orgId}/orders/${orderId}`;
