import { describe, expect, it } from "vitest";

import { rowActions } from "@/features/money-waiting/row-actions";

// MNY-02: the action of a row of "כסף שמחכה", the best one first
describe("money waiting row actions (MNY-02)", () => {
  const base = { kind: "lead" as const, ownerId: "u1", phoneE164: "+972501234567", canWrite: true, canReassign: true };

  it("a record with no owner is handed to a rep first", () => {
    expect(rowActions({ ...base, ownerId: null })).toEqual(["assign", "task", "whatsapp"]);
    expect(rowActions({ ...base, kind: "deal", ownerId: null })[0]).toBe("assign");
  });

  it("an unanswered lead with a phone gets WhatsApp first", () => {
    expect(rowActions(base)).toEqual(["whatsapp", "task", "assign"]);
  });

  it("a deal gets a task for its next step first", () => {
    expect(rowActions({ ...base, kind: "deal" })).toEqual(["task", "whatsapp", "assign"]);
  });

  it("only what the user may do", () => {
    expect(rowActions({ ...base, canWrite: false })).toEqual([]);
    // a rep cannot hand a record to someone else; without a phone there is no WhatsApp
    expect(rowActions({ ...base, ownerId: null, canReassign: false, phoneE164: null })).toEqual(["task"]);
  });
});
