import { describe, expect, it } from "vitest";

import {
  AUTO,
  autoTarget,
  checkMapPicks,
  claimedTargets,
  currentChoice,
  mappingNeedsFix,
  NONE,
  offeredTargets,
  REMOVED,
  targetDeleteWarning,
  targetHideWarning,
  type MapField,
  type MapRow,
} from "@/features/conversion-map/rules";

const row = (r: Omit<MapRow, "targetRemoved"> & { targetRemoved?: boolean }): MapRow => ({ targetRemoved: false, ...r });
const field = (id: string, label: string, type = "text", isActive = true): MapField => ({ id, label, type, isActive });

const leadFields = [field("L1", "תקציב", "number"), field("L2", "הערה"), field("L3", "מקור")];
const contact = [field("C1", " תקציב ", "number"), field("C2", "הערה"), field("C3", "הערה נוספת"), field("C4", "מוסתר", "text", false), field("C5", "תאריך", "date"), field("C6", "הערה")];
const deal = [field("D1", "הערה"), field("D2", "תיאור")];
const targets = { contact, deal };

describe("conversion field mapping rules (LEAD-06)", () => {
  it("offers only active fields of the same type", () => {
    expect(offeredTargets(leadFields[1], contact).map((f) => f.id)).toEqual(["C2", "C3", "C6"]);
    expect(offeredTargets(leadFields[0], contact).map((f) => f.id)).toEqual(["C1"]);
  });

  it("auto picks the first field with the same label (spaces and case ignored) and type, like the database", () => {
    expect(autoTarget(leadFields[0], contact)?.id).toBe("C1");
    expect(autoTarget(leadFields[2], contact)).toBeNull();
    // same label but another type is not a match
    expect(autoTarget(field("L9", "תאריך"), contact)).toBeNull();
  });

  it("auto never reaches a field another lead field picked by hand", () => {
    const rows: MapRow[] = [
      row({ id: "r1", leadFieldId: "L3", targetType: "contact", mode: "field", targetFieldId: "C2" }),
      row({ id: "r2", leadFieldId: "L1", targetType: "deal", mode: "none", targetFieldId: null }),
    ];
    const claimed = claimedTargets(rows, "contact");
    expect([...claimed]).toEqual(["C2"]);
    expect(autoTarget(leadFields[1], contact, claimed)?.id).toBe("C6");
    expect(claimedTargets(rows, "deal").size).toBe(0);
  });

  it("reads the stored choice", () => {
    const rows: MapRow[] = [
      row({ id: "r1", leadFieldId: "L1", targetType: "contact", mode: "none", targetFieldId: null }),
      row({ id: "r2", leadFieldId: "L2", targetType: "deal", mode: "field", targetFieldId: "D2" }),
      row({ id: "r3", leadFieldId: "L3", targetType: "deal", mode: "auto", targetFieldId: null }),
    ];
    expect(currentChoice(rows, "L1", "contact")).toBe(NONE);
    expect(currentChoice(rows, "L2", "deal")).toBe("D2");
    expect(currentChoice(rows, "L3", "deal")).toBe(AUTO);
    expect(currentChoice(rows, "L2", "contact")).toBe(AUTO);
  });

  it("accepts offered fields, auto and none", () => {
    expect(
      checkMapPicks(
        [
          { leadFieldId: "L1", targetType: "contact", choice: AUTO },
          { leadFieldId: "L2", targetType: "deal", choice: NONE },
          { leadFieldId: "L3", targetType: "contact", choice: "C3" },
        ],
        [],
        leadFields,
        targets,
      ),
    ).toEqual({ ok: true });
  });

  it("refuses a field that is not offered, unless it is the one already stored", () => {
    const pick = (choice: string) => [{ leadFieldId: "L2", targetType: "contact" as const, choice }];
    expect(checkMapPicks(pick("C4"), [], leadFields, targets)).toEqual({ ok: false, reason: "invalid" });
    expect(checkMapPicks(pick("C5"), [], leadFields, targets)).toEqual({ ok: false, reason: "invalid" });
    expect(checkMapPicks(pick("D1"), [], leadFields, targets)).toEqual({ ok: false, reason: "invalid" });
    // hidden since it was picked: kept as it is
    const stored: MapRow[] = [row({ id: "r1", leadFieldId: "L2", targetType: "contact", mode: "field", targetFieldId: "C4" })];
    expect(checkMapPicks(pick("C4"), stored, leadFields, targets)).toEqual({ ok: true });
    // an unknown lead field, and the same slot twice
    expect(checkMapPicks([{ leadFieldId: "X", targetType: "deal", choice: NONE }], [], leadFields, targets)).toEqual({ ok: false, reason: "invalid" });
    expect(checkMapPicks([...pick(AUTO), ...pick(NONE)], [], leadFields, targets)).toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses two lead fields on one field, also against a stored pick the form did not send", () => {
    const both = [
      { leadFieldId: "L2", targetType: "deal" as const, choice: "D1" },
      { leadFieldId: "L3", targetType: "deal" as const, choice: "D1" },
    ];
    expect(checkMapPicks(both, [], leadFields, targets)).toEqual({ ok: false, reason: "duplicate" });
    const stored: MapRow[] = [row({ id: "r1", leadFieldId: "L2", targetType: "deal", mode: "field", targetFieldId: "D1" })];
    expect(checkMapPicks([both[1]], stored, leadFields, targets)).toEqual({ ok: false, reason: "duplicate" });
  });

  it("a swap is allowed", () => {
    const rows: MapRow[] = [
      row({ id: "r1", leadFieldId: "L2", targetType: "deal", mode: "field", targetFieldId: "D1" }),
      row({ id: "r2", leadFieldId: "L3", targetType: "deal", mode: "field", targetFieldId: "D2" }),
    ];
    expect(
      checkMapPicks(
        [
          { leadFieldId: "L2", targetType: "deal", choice: "D2" },
          { leadFieldId: "L3", targetType: "deal", choice: "D1" },
        ],
        rows,
        leadFields,
        targets,
      ),
    ).toEqual({ ok: true });
  });

  it("a deleted target shows until a person chooses again, and drives the reminder", () => {
    const rows: MapRow[] = [
      row({ id: "r1", leadFieldId: "L2", targetType: "deal", mode: "none", targetFieldId: null, targetRemoved: true }),
      row({ id: "r2", leadFieldId: "L3", targetType: "deal", mode: "none", targetFieldId: null }),
    ];
    expect(currentChoice(rows, "L2", "deal")).toBe(REMOVED);
    // an explicit "do not copy" is not a deleted target
    expect(currentChoice(rows, "L3", "deal")).toBe(NONE);
    expect(mappingNeedsFix(rows)).toBe(true);
    expect(mappingNeedsFix([rows[1]])).toBe(false);
    // leaving it as it is, or choosing again, is fine; "removed" for another row is not
    expect(checkMapPicks([{ leadFieldId: "L2", targetType: "deal", choice: REMOVED }], rows, leadFields, targets)).toEqual({ ok: true });
    expect(checkMapPicks([{ leadFieldId: "L2", targetType: "deal", choice: "D2" }], rows, leadFields, targets)).toEqual({ ok: true });
    expect(checkMapPicks([{ leadFieldId: "L3", targetType: "deal", choice: REMOVED }], rows, leadFields, targets)).toEqual({ ok: false, reason: "invalid" });
  });

  it("words the hide question by target type", () => {
    expect(targetHideWarning("תקציב", "contact")).toBe("השדה הזה מקבל ערכים מלידים בהמרה. אחרי ההסתרה הערך של תקציב לא יועבר לאיש הקשר.");
    expect(targetHideWarning("תקציב", "deal")).toBe("השדה הזה מקבל ערכים מלידים בהמרה. אחרי ההסתרה הערך של תקציב לא יועבר לעסקה.");
  });

  it("words the delete warning by target type", () => {
    expect(targetDeleteWarning("תקציב", "contact")).toBe("השדה הזה מקבל ערכים מלידים בהמרה. אחרי המחיקה הערך של תקציב לא יועבר לאיש הקשר.");
    expect(targetDeleteWarning("תקציב", "deal")).toBe("השדה הזה מקבל ערכים מלידים בהמרה. אחרי המחיקה הערך של תקציב לא יועבר לעסקה.");
  });
});
