/** LST-09: every payment the user reads, across the business. */
export const paymentsPath = (orgId: string) => `/o/${orgId}/payments`;
/** PAY-04 (answer 7): the cheques still to be cashed, by due date. */
export const chequesPath = (orgId: string) => `/o/${orgId}/payments/cheques`;
