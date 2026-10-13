// CAL-07 paths. Kept here rather than in src/lib/paths.ts (shared); the lead may move them when merging.

/** Where a meeting's invite file (.ics) is downloaded from (user session). */
export const meetingInvitePath = (orgId: string, meetingId: string) => `/o/${orgId}/calendar/invite/${meetingId}`;

/** The personal feed's path; the token is the key. */
export const calendarFeedPath = (token: string) => `/api/calendar-feed/${token}.ics`;
