/** LST-09: every payment the user reads, across the business. */
export const paymentsPath = (orgId: string) => `/o/${orgId}/payments`;
/** PAY-04 (answer 7): the cheques still to be cashed, by due date. */
export const chequesPath = (orgId: string) => `/o/${orgId}/payments/cheques`;
/** COL-01: the open debt documents by age, customer and rep. */
export const collectionPath = (orgId: string) => `/o/${orgId}/payments/collection`;
