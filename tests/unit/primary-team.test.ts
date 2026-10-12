import { describe, expect, it } from "vitest";

import { primaryTeamState, recordTeamOf, type TeamMembershipRow } from "@/features/settings/primary-team";

const rows: TeamMembershipRow[] = [
  { team_id: "sales", user_id: "dana", is_primary: false },
  { team_id: "sales", user_id: "avi", is_primary: false },
  { team_id: "support", user_id: "avi", is_primary: true },
  { team_id: "sales", user_id: "noa", is_primary: false },
  { team_id: "field", user_id: "noa", is_primary: false },
];

describe("primary team (CAP-06)", () => {
  it("a user in one team joins it without a flag", () => {
    expect(recordTeamOf(rows, "dana")).toBe("sales");
    expect(primaryTeamState(rows, "dana", "sales")).toEqual({ teamCount: 1, joinsThisTeam: true, isPrimary: false, noRecordTeam: false });
  });

  it("a user in several teams joins the primary one", () => {
    expect(recordTeamOf(rows, "avi")).toBe("support");
    expect(primaryTeamState(rows, "avi", "support")).toMatchObject({ teamCount: 2, joinsThisTeam: true, isPrimary: true });
    expect(primaryTeamState(rows, "avi", "sales")).toMatchObject({ joinsThisTeam: false, isPrimary: false, noRecordTeam: false });
  });

  it("several teams and no primary: no team", () => {
    expect(recordTeamOf(rows, "noa")).toBeNull();
    expect(primaryTeamState(rows, "noa", "field")).toMatchObject({ teamCount: 2, joinsThisTeam: false, noRecordTeam: true });
  });

  it("a user in no team joins none", () => {
    expect(recordTeamOf(rows, "nobody")).toBeNull();
    expect(primaryTeamState(rows, "nobody", "sales").noRecordTeam).toBe(false);
  });
});
