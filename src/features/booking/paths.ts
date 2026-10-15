/** CAL-10: the settings page of the booking pages. */
export const bookingPagesPath = (orgId: string) => `/o/${orgId}/settings/booking`;

/** CAL-10: the public booking page of a token (under the public /f/ prefix of the proxy). */
export const publicBookingPath = (token: string) => `/f/book/${token}`;

/** CAL-10: where the public booking page posts a booking (under the public /api/forms/ prefix). */
export const bookingSubmitPath = (token: string) => `/api/forms/booking/${token}`;
