import { describe, expect, it } from "vitest";

import { buildChecklist, CHECKLIST_ITEM_COUNT, checklistProgress, keptSampleMessage, sampleCounts, type ChecklistFacts } from "@/features/setup/checklist";

const ORG = "11111111-1111-4111-8111-111111111111";

const none: ChecklistFacts = {
  detailsFilled: false,
  realLead: false,
  activeForm: false,
  realDeal: false,
  teamInvited: false,
  importDone: false,
  pushOn: false,
};

describe("setup checklist (USR-04)", () => {
  it("has 5 to 7 items, each with a title, a hint and a link inside the business", () => {
    const items = buildChecklist(ORG, none);
    expect(items).toHaveLength(CHECKLIST_ITEM_COUNT);
    expect(CHECKLIST_ITEM_COUNT).toBeGreaterThanOrEqual(5);
    expect(CHECKLIST_ITEM_COUNT).toBeLessThanOrEqual(7);
    for (const item of items) {
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.hint.length).toBeGreaterThan(0);
      expect(item.href.startsWith(`/o/${ORG}/`)).toBe(true);
    }
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
  });

  it("each item follows its own fact", () => {
    for (const key of Object.keys(none) as (keyof ChecklistFacts)[]) {
      const items = buildChecklist(ORG, { ...none, [key]: true });
      expect(items.filter((i) => i.done).map((i) => i.key)).toEqual([key]);
    }
  });

  it("the percentage is rounded down, so 100% means everything is done", () => {
    expect(checklistProgress(buildChecklist(ORG, none))).toEqual({ done: 0, total: 7, percent: 0 });
    expect(checklistProgress(buildChecklist(ORG, { ...none, realLead: true }))).toEqual({ done: 1, total: 7, percent: 14 });
    const allButOne = { ...Object.fromEntries(Object.keys(none).map((k) => [k, true])), pushOn: false } as ChecklistFacts;
    expect(checklistProgress(buildChecklist(ORG, allButOne)).percent).toBe(85);
    const all = Object.fromEntries(Object.keys(none).map((k) => [k, true])) as ChecklistFacts;
    expect(checklistProgress(buildChecklist(ORG, all))).toEqual({ done: 7, total: 7, percent: 100 });
    expect(checklistProgress([]).percent).toBe(100);
  });
});

describe("sample data counts (USR-04)", () => {
  it("counts the records nobody changed, and the ones kept because they were changed", () => {
    const rows = [
      { record_type: "lead", record_id: "l1", removable: true },
      { record_type: "lead", record_id: "l2", removable: false },
      { record_type: "deal", record_id: "d1", removable: false },
    ];
    expect(sampleCounts(rows)).toEqual({ removable: 1, kept: 2 });
    expect(sampleCounts([])).toEqual({ removable: 0, kept: 0 });
    expect(keptSampleMessage(2)).toBe("2 רשומות דוגמה נשארו כי שינו אותן. אפשר למחוק אותן ידנית.");
    expect(keptSampleMessage(1)).toContain("אחת");
  });
});
