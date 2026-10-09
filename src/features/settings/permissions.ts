import type { MembershipRole, MembershipStatus, RecordVisibility } from "@/lib/database.types";

// UI mirrors of the membership rules in app.guard_membership() and
// create_invitation(). They only decide which controls to show; the database
// enforces the same rules whatever the browser sends.

export type InvitableRole = Exclude<MembershipRole, "owner">;

export const INVITABLE_ROLES: readonly InvitableRole[] = ["admin", "manager", "member", "viewer"];

export const ROLE_DESCRIPTIONS: Record<MembershipRole, string> = {
  owner: "כל ההרשאות, כולל חיוב והעברת בעלות.",
  admin: "מנהל משתמשים, צוותים והגדרות, ורואה ועורך הכול.",
  manager: "עורך את הרשומות של הצוותים שהוא מנהל.",
  member: "עובד עם הרשומות שלו.",
  viewer: "צפייה בלבד, בלי שינויים.",
};

export const VISIBILITY_OPTIONS: ReadonlyArray<{ value: RecordVisibility; label: string; description: string }> = [
  { value: "org", label: "כל העסק", description: "כל המשתמשים רואים את כל הרשומות." },
  { value: "team", label: "לפי צוות", description: "כל משתמש רואה את הרשומות שלו ושל הצוותים שלו." },
  { value: "own", label: "רק שלי", description: "כל משתמש רואה רק את הרשומות שלו. מנהלי צוות רואים גם את רשומות הצוות." },
];

export function isAdminRole(role: MembershipRole): boolean {
  return role === "owner" || role === "admin";
}

/** Roles the current user may give to someone, by invitation or by a role change. */
export function assignableRoles(myRole: MembershipRole, hasViewSeats: boolean): InvitableRole[] {
  if (!isAdminRole(myRole)) {
    return [];
  }
  return INVITABLE_ROLES.filter(
    (role) => (role !== "admin" || myRole === "owner") && (role !== "viewer" || hasViewSeats),
  );
}

type MemberLike = { userId: string; role: MembershipRole; status: MembershipStatus };

/** Whether the current user may change this member's role or suspend them. */
export function canManageMember(myRole: MembershipRole, myUserId: string, member: MemberLike): boolean {
  if (!isAdminRole(myRole) || member.userId === myUserId || member.role === "owner") {
    return false;
  }
  // only the owner changes another admin
  return member.role !== "admin" || myRole === "owner";
}
