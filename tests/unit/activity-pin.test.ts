import { describe, expect, it } from "vitest";

import { canPinHint, isPinnableType, LOGGED_TYPES, PINNABLE_TYPES } from "@/features/activities/schema";

// REC-01: who sees the pin button. It mirrors the activities_update policy
// (author, or owner/admin, in a writable organization); the database still decides.
describe("pinning a timeline entry (REC-01)", () => {
  const me = "11111111-1111-4111-8111-111111111111";
  const other = "22222222-2222-4222-8222-222222222222";

  it("only what a person logged can be pinned, never a system event", () => {
    for (const type of LOGGED_TYPES.map((t) => t.value)) expect(isPinnableType(type)).toBe(true);
    for (const type of ["status_change", "stage_change", "conversion", "assignment", "system", "inquiry", "", "__proto__"]) {
      expect(isPinnableType(type)).toBe(false);
    }
    expect([...PINNABLE_TYPES].sort()).toEqual(LOGGED_TYPES.map((t) => t.value).sort());
  });

  it("the author may pin their own entry, whatever their role (except read-only)", () => {
    for (const role of ["member", "manager", "admin", "owner"]) {
      expect(canPinHint({ type: "note", createdBy: me }, { userId: me, role, canWrite: true })).toBe(true);
    }
    expect(canPinHint({ type: "note", createdBy: me }, { userId: me, role: "viewer", canWrite: false })).toBe(false);
  });

  it("someone else's entry: owners and admins only", () => {
    const entry = { type: "call", createdBy: other };
    expect(canPinHint(entry, { userId: me, role: "owner", canWrite: true })).toBe(true);
    expect(canPinHint(entry, { userId: me, role: "admin", canWrite: true })).toBe(true);
    expect(canPinHint(entry, { userId: me, role: "manager", canWrite: true })).toBe(false);
    expect(canPinHint(entry, { userId: me, role: "member", canWrite: true })).toBe(false);
    // an entry with no author (written by the system) is the same: admins only
    expect(canPinHint({ type: "note", createdBy: null }, { userId: me, role: "member", canWrite: true })).toBe(false);
    expect(canPinHint({ type: "note", createdBy: null }, { userId: me, role: "admin", canWrite: true })).toBe(true);
  });

  it("nothing is pinnable when the organization is read-only, or for system events", () => {
    expect(canPinHint({ type: "note", createdBy: me }, { userId: me, role: "owner", canWrite: false })).toBe(false);
    expect(canPinHint({ type: "status_change", createdBy: me }, { userId: me, role: "owner", canWrite: true })).toBe(false);
  });
});
