import { describe, expect, it } from "vitest";

import { viewSeatsLeft, viewSeatsLine } from "@/features/settings/view-seats";

// PRM-02: the view seats left to invite, and the line under the invitation form
describe("view seats (PRM-02)", () => {
  it("counts open viewer invitations against the allowance, never below zero", () => {
    expect(viewSeatsLeft({ limit: 3, used: 1, pending: 1 })).toBe(1);
    expect(viewSeatsLeft({ limit: 2, used: 1, pending: 1 })).toBe(0);
    expect(viewSeatsLeft({ limit: 1, used: 2, pending: 0 })).toBe(0);
    expect(viewSeatsLeft({ limit: null, used: 9, pending: 9 })).toBeNull();
  });

  it("says how many are in use, out of how many, and the open invitations", () => {
    expect(viewSeatsLine({ limit: 3, used: 1, pending: 0 })).toBe("מושבי צפייה: 1 מתוך 3. המספר נקבע לפי מספר המושבים בתשלום.");
    expect(viewSeatsLine({ limit: 3, used: 1, pending: 1 })).toContain("ועוד הזמנה אחת ממתינה");
    expect(viewSeatsLine({ limit: 3, used: 0, pending: 2 })).toContain("ועוד 2 הזמנות ממתינות");
    expect(viewSeatsLine({ limit: null, used: 4, pending: 0 })).toBe("מושבי צפייה בשימוש: 4.");
  });
});
