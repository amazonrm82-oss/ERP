import { describe, expect, it } from "vitest";

import { AUTOMATION_NAME_MISSING, automationNameOf } from "@/features/audit/automation-name";
import { ruleAuthorshipLine } from "@/features/automations/authorship";

// PRM-01 (owner, 15 October 2026)
describe("the rule named in an audit entry", () => {
  const entry = { tag_ids: { old: [], new: ["t"] }, automation: { id: "r1", name: "תיוג חמים" } };

  it("shows the name stored in the entry, also after the rule was renamed or deleted (no lookup)", () => {
    // the entry is all the function sees: whatever happened to the rule since, the stored name stays
    expect(automationNameOf(entry)).toBe("תיוג חמים");
    expect(automationNameOf(JSON.parse(JSON.stringify(entry)))).toBe("תיוג חמים");
  });

  it("uses the fallback only when the stored name is missing", () => {
    expect(automationNameOf({ automation: { id: "r1", name: null } })).toBe(AUTOMATION_NAME_MISSING);
    expect(automationNameOf({ automation: { id: "r1" } })).toBe(AUTOMATION_NAME_MISSING);
    expect(automationNameOf({ automation: { id: "r1", name: " " } })).toBe(AUTOMATION_NAME_MISSING);
  });

  it("is null for a change a person made", () => {
    expect(automationNameOf({ tag_ids: { old: [], new: ["t"] } })).toBeNull();
    expect(automationNameOf(null)).toBeNull();
  });
});

describe("rule authorship line", () => {
  const names = new Map([["u1", "דנה"], ["u2", "יוסי"]]);

  it("names the creator and the last editor", () => {
    expect(ruleAuthorshipLine("u1", "u2", names)).toBe("נוצרה על ידי: דנה · שונתה לאחרונה על ידי: יוסי");
  });

  it("an unknown last editor (a rule from before the column) reads 'לא ידוע'", () => {
    expect(ruleAuthorshipLine("u1", null, names)).toBe("נוצרה על ידי: דנה · שונתה לאחרונה על ידי: לא ידוע");
    expect(ruleAuthorshipLine(null, null, names)).toBe("שונתה לאחרונה על ידי: לא ידוע");
  });
});
