import { describe, expect, it } from "vitest";

import { UNOWNED_NOTE, unownedLeadsGoTo } from "@/features/intake/unowned";

// SPD-01: the note in the form settings says where a lead nobody owns goes,
// as app.intake_unowned_recipients() decides (test 79 covers the database side).
describe("where a lead with no owner goes (SPD-01)", () => {
  const members = [
    { userId: "m", role: "member" as const, status: "active" as const, seatType: "full" as const },
    { userId: "g", role: "manager" as const, status: "active" as const, seatType: "full" as const },
    { userId: "v", role: "viewer" as const, status: "active" as const, seatType: "view" as const },
    { userId: "s", role: "member" as const, status: "suspended" as const, seatType: "full" as const },
    { userId: "a", role: "admin" as const, status: "active" as const, seatType: "full" as const },
  ];
  const go = (teamId: string | null, visibility: "org" | "team" | "own", teamMembers: { userId: string; isManager: boolean }[]) =>
    unownedLeadsGoTo({ teamId, visibility, members, teamMembers });

  it("no team: the owners and admins", () => {
    expect(go(null, "org", [{ userId: "m", isManager: false }])).toBe("admins");
  });

  it("a team with an active writer who may read the lead: the team", () => {
    expect(go("t", "org", [{ userId: "m", isManager: false }])).toBe("team");
    expect(go("t", "team", [{ userId: "m", isManager: false }])).toBe("team");
    expect(go("t", "own", [{ userId: "a", isManager: false }])).toBe("team");
    expect(go("t", "own", [{ userId: "g", isManager: true }])).toBe("team");
  });

  it("only viewers, suspended members, or members who cannot read it: the owners and admins", () => {
    expect(go("t", "org", [{ userId: "v", isManager: false }, { userId: "s", isManager: false }])).toBe("admins");
    expect(go("t", "own", [{ userId: "m", isManager: false }, { userId: "g", isManager: false }])).toBe("admins");
    expect(go("t", "org", [])).toBe("admins");
  });

  it("uses the owner's wording", () => {
    expect(UNOWNED_NOTE.team).toBe("לטופס אין אחראי פעיל, לידים חדשים נשלחים לכל הצוות");
    expect(UNOWNED_NOTE.admins).toBe("לטופס אין אחראי פעיל, לידים חדשים נשלחים לבעלים ולמנהלי המערכת");
  });
});
