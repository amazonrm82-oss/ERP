import { describe, expect, it } from "vitest";

import { confirmsName, countLines, familyOf, matchHint, notPreselected, previewFrom } from "@/features/privacy-erase/erase";

// PRV-03: the confirmation window reads the preview, counts what goes and asks for the person's name.

const raw = {
  people: {
    leads: [{ id: "l1", name: "נועה  לוי", in_bin: false }],
    contacts: [{ id: "c1", name: "Noa Levi", in_bin: true }],
  },
  matches: [
    { type: "leads", id: "l2", via: "phone", shared: 1, family: "l2", relatives: 0, preselect: true, name: null },
    { type: "contacts", id: "c9", via: "email", shared: 4, family: "c9", relatives: 1, preselect: false, name: "משרד" },
    { type: "leads", id: "l9", via: "email", shared: 4, family: "c9", relatives: 1, preselect: false, name: "משרד ליד" },
  ],
  matches_truncated: true,
  counts: { leads: 2, contacts: 1, channels: 0, files: 3, inquiries: 1, meetings: 2, activities: 0 },
  deals: [{ id: "d1", name: "שיפוץ אצל נועה", must_rename: true, suggested: "עסקה (לקוח נמחק)" }],
};

describe("removing a person: the confirmation", () => {
  it("reads the preview, naming records with no name", () => {
    expect(previewFrom(raw)).toEqual({
      leads: [{ id: "l1", name: "נועה  לוי", inBin: false }],
      contacts: [{ id: "c1", name: "Noa Levi", inBin: true }],
      matches: [
        { type: "leads", id: "l2", via: "phone", name: "ללא שם", shared: 1, family: "l2", relatives: 0, preselect: true },
        { type: "contacts", id: "c9", via: "email", name: "משרד", shared: 4, family: "c9", relatives: 1, preselect: false },
        { type: "leads", id: "l9", via: "email", name: "משרד ליד", shared: 4, family: "c9", relatives: 1, preselect: false },
      ],
      matchesTruncated: true,
      counts: raw.counts,
      deals: [{ id: "d1", name: "שיפוץ אצל נועה", mustRename: true, suggested: "עסקה (לקוח נמחק)" }],
    });
    expect(previewFrom({ people: { leads: [] } })).toBeNull();
    expect(previewFrom(null)).toBeNull();
  });

  it("accepts the name of any of the person's records, ignoring spaces and case, and nothing shorter than two letters", () => {
    const preview = previewFrom(raw)!;
    expect(confirmsName("נועה לוי", preview)).toBe(true);
    expect(confirmsName("  noa   LEVI ", preview)).toBe(true);
    expect(confirmsName("נועה", preview)).toBe(false);
    expect(confirmsName("", preview)).toBe(false);
    expect(confirmsName("ללא שם", { leads: [{ id: "x", name: "ללא שם", inBin: false }], contacts: [] })).toBe(false);
  });

  it("counts what goes by type, leaving out what is not there, and says meetings stay", () => {
    expect(countLines(raw.counts)).toEqual(["2 לידים", "איש קשר אחד", "3 קבצים", "פנייה אחת מטופס", "2 פגישות נשארות בלי פרטי האדם"]);
  });

  it("ticks only the preselected matches, and says why one is not", () => {
    const preview = previewFrom(raw)!;
    expect([...notPreselected(preview.matches, (m) => `${m.type}:${m.id}`)]).toEqual(["contacts:c9", "leads:l9"]);
    expect(familyOf(preview.matches, preview.matches[1]).map((m) => m.id)).toEqual(["l9"]);
    expect(familyOf(preview.matches, preview.matches[0])).toEqual([]);
    expect(matchHint(preview.matches[2], ["משרד"])).toBe("אותו אימייל · נמחק יחד עם משרד · משותף ל-4 רשומות · יחד איתה תימחק עוד רשומה קשורה אחת");
    expect(matchHint(preview.matches[0])).toBe("אותו טלפון");
    expect(matchHint(preview.matches[1])).toBe("אותו אימייל · משותף ל-4 רשומות · יחד איתה תימחק עוד רשומה קשורה אחת");
    expect(matchHint({ via: "phone", shared: 2, relatives: 3 })).toBe("אותו טלפון · יחד איתה יימחקו עוד 3 רשומות קשורות");
  });
});
