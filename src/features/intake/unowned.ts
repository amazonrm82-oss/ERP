import type { MembershipRole, MembershipStatus, RecordVisibility, SeatType } from "@/lib/database.types";

// SPD-01 (owner's answer, 13 October 2026): who is told about a new lead nobody
// owns. Mirrors app.intake_unowned_recipients() for the note in the form settings:
// the active writers (full seat) of the form's team who may read a lead with no owner
// (app.user_can_read_record() with owner null), else the owners and admins.
// A manager of a parent team who sits in the team without being its manager is
// not counted here (the database counts them); the note then says "owners and admins".

export type UnownedTarget = "team" | "admins";

export function unownedLeadsGoTo(input: {
  teamId: string | null;
  visibility: RecordVisibility;
  members: readonly { userId: string; role: MembershipRole; status: MembershipStatus; seatType: SeatType }[];
  teamMembers: readonly { userId: string; isManager: boolean }[];
}): UnownedTarget {
  if (!input.teamId) return "admins";
  const byId = new Map(input.members.map((member) => [member.userId, member]));
  const qualifies = input.teamMembers.some((row) => {
    const member = byId.get(row.userId);
    if (!member || member.status !== "active" || member.role === "viewer" || member.seatType !== "full") return false;
    if (member.role === "owner" || member.role === "admin") return true;
    if (input.visibility === "org" || input.visibility === "team") return true;
    return member.role === "manager" && row.isManager;
  });
  return qualifies ? "team" : "admins";
}

export const UNOWNED_NOTE: Record<UnownedTarget, string> = {
  team: "לטופס אין אחראי פעיל, לידים חדשים נשלחים לכל הצוות",
  admins: "לטופס אין אחראי פעיל, לידים חדשים נשלחים לבעלים ולמנהלי המערכת",
};
