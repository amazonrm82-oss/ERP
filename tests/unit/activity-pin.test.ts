import { describe, expect, it } from "vitest";

import { canEditNoteHint, canPinHint, isPinnableType, LOGGED_TYPES, managesTeamChain, PINNABLE_TYPES } from "@/features/activities/schema";

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

  it("someone else's entry: owners and admins, and a manager of the record's team", () => {
    const entry = { type: "call", createdBy: other };
    expect(canPinHint(entry, { userId: me, role: "owner", canWrite: true })).toBe(true);
    expect(canPinHint(entry, { userId: me, role: "admin", canWrite: true })).toBe(true);
    expect(canPinHint(entry, { userId: me, role: "manager", canWrite: true })).toBe(false);
    expect(canPinHint(entry, { userId: me, role: "manager", canWrite: true, managesRecordTeam: false })).toBe(false);
    expect(canPinHint(entry, { userId: me, role: "manager", canWrite: true, managesRecordTeam: true })).toBe(true);
    // the flag counts only with the manager role, and never in a read-only organization
    expect(canPinHint(entry, { userId: me, role: "member", canWrite: true, managesRecordTeam: true })).toBe(false);
    expect(canPinHint(entry, { userId: me, role: "viewer", canWrite: true, managesRecordTeam: true })).toBe(false);
    expect(canPinHint(entry, { userId: me, role: "manager", canWrite: false, managesRecordTeam: true })).toBe(false);
    expect(canPinHint({ type: "status_change", createdBy: other }, { userId: me, role: "manager", canWrite: true, managesRecordTeam: true })).toBe(false);
    expect(canPinHint(entry, { userId: me, role: "member", canWrite: true })).toBe(false);
    // an entry with no author (written by the system) is the same: admins only
    expect(canPinHint({ type: "note", createdBy: null }, { userId: me, role: "member", canWrite: true })).toBe(false);
    expect(canPinHint({ type: "note", createdBy: null }, { userId: me, role: "admin", canWrite: true })).toBe(true);
  });

  it("nothing is pinnable when the organization is read-only, or for system events", () => {
    expect(canPinHint({ type: "note", createdBy: me }, { userId: me, role: "owner", canWrite: false })).toBe(false);
    expect(canPinHint({ type: "status_change", createdBy: me }, { userId: me, role: "owner", canWrite: true })).toBe(false);
  });

  // REC-05: the author may change what an entry says for 24 hours; pinning has no time limit
  it("editing: the author for 24 hours, owners and admins at any time; pinning stays open to the author", () => {
    const NOW = Date.parse("2026-10-12T12:00:00Z");
    const at = (ms: number) => new Date(NOW - ms).toISOString();
    const hour = 3_600_000;
    const author = { userId: me, role: "member", canWrite: true };
    expect(canEditNoteHint({ type: "note", createdBy: me, createdAt: at(23 * hour) }, author, NOW)).toBe(true);
    expect(canEditNoteHint({ type: "note", createdBy: me, createdAt: at(24 * hour) }, author, NOW)).toBe(false);
    expect(canEditNoteHint({ type: "note", createdBy: me, createdAt: at(30 * 24 * hour) }, author, NOW)).toBe(false);
    expect(canEditNoteHint({ type: "note", createdBy: me, createdAt: "not a date" }, author, NOW)).toBe(false);
    expect(canPinHint({ type: "note", createdBy: me }, author)).toBe(true);
    for (const role of ["owner", "admin"]) {
      expect(canEditNoteHint({ type: "call", createdBy: other, createdAt: at(30 * 24 * hour) }, { userId: me, role, canWrite: true }, NOW)).toBe(true);
    }
    expect(canEditNoteHint({ type: "note", createdBy: other, createdAt: at(hour) }, { userId: me, role: "manager", canWrite: true }, NOW)).toBe(false);
    // a team manager pins a colleague's entry but never edits it
    expect(canEditNoteHint({ type: "note", createdBy: other, createdAt: at(hour) }, { userId: me, role: "manager", canWrite: true, managesRecordTeam: true }, NOW)).toBe(false);
    expect(canEditNoteHint({ type: "note", createdBy: me, createdAt: at(hour) }, { userId: me, role: "manager", canWrite: true, managesRecordTeam: true }, NOW)).toBe(true);
    expect(canEditNoteHint({ type: "status_change", createdBy: me, createdAt: at(hour) }, author, NOW)).toBe(false);
    expect(canEditNoteHint({ type: "note", createdBy: me, createdAt: at(hour) }, { ...author, canWrite: false }, NOW)).toBe(false);
  });

  it("managing a team: the team itself or a parent team, at most 10 levels up (app.manages_team)", () => {
    const teams = [
      { id: "region", parentTeamId: null },
      { id: "north", parentTeamId: "region" },
      { id: "south", parentTeamId: null },
    ];
    expect(managesTeamChain("north", teams, new Set(["north"]))).toBe(true);
    expect(managesTeamChain("north", teams, new Set(["region"]))).toBe(true);
    expect(managesTeamChain("region", teams, new Set(["north"]))).toBe(false);
    expect(managesTeamChain("south", teams, new Set(["north", "region"]))).toBe(false);
    expect(managesTeamChain(null, teams, new Set(["north"]))).toBe(false);
    expect(managesTeamChain("unknown", teams, new Set(["unknown"]))).toBe(false);
    // a cycle or a long chain stops after 10 teams
    const chain = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, parentTeamId: `t${i + 1}` }));
    expect(managesTeamChain("t0", chain, new Set(["t9"]))).toBe(true);
    expect(managesTeamChain("t0", chain, new Set(["t10"]))).toBe(false);
    expect(managesTeamChain("a", [{ id: "a", parentTeamId: "b" }, { id: "b", parentTeamId: "a" }], new Set(["c"]))).toBe(false);
  });
});
