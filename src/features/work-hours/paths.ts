// CAP-09: a member's working hours and leave, for owners and admins. Kept here
// rather than in src/lib/paths.ts (shared); the lead may move it there when merging.
export const memberHoursPath = (orgId: string, userId: string) => `/o/${orgId}/settings/users/${userId}/hours`;
