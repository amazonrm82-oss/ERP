import { describe, expect, it } from "vitest";

import { officerCandidates, officerName } from "@/features/privacy-officer/officer";

// PRK-06: only active members may be named; a mark on someone no longer active reads as none
describe("privacy officer (PRK-06)", () => {
  const members = [
    { userId: "a", name: "דנה", status: "active" },
    { userId: "b", name: "יוסי", status: "suspended" },
  ];

  it("offers active members only", () => {
    expect(officerCandidates(members)).toEqual([{ userId: "a", name: "דנה" }]);
  });

  it("names the officer while active", () => {
    expect(officerName("a", members)).toBe("דנה");
    expect(officerName("b", members)).toBeNull();
    expect(officerName(null, members)).toBeNull();
    expect(officerName("c", members)).toBeNull();
  });
});
