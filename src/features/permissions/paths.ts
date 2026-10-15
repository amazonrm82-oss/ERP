// PRM-01: a member's extra permissions, for owners and admins. Kept here rather than in
// src/lib/paths.ts (shared); the lead may move it there when merging.
export const memberPermissionsPath = (orgId: string, userId: string) => `/o/${orgId}/settings/users/${userId}/permissions`;
