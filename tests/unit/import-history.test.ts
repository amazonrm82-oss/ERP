import { describe, expect, it } from "vitest";

import { canRemoveImportNoteHint, parseTimelineFilter } from "@/features/activities/schema";
import { IMPORT_TARGETS, suggestMapping } from "@/features/imports/fields";
import {
  createdLineText,
  importNote,
  mapsHistory,
  NOTE_TOO_LONG,
  noteDateUnknown,
  originalCreatedOn,
  originalDateOutOfRange,
  originalDateUnknown,
} from "@/features/imports/history";

const TODAY = "2026-10-26";

// GAP-12: the original creation date and the notes of an imported file
describe("history in an import (GAP-12)", () => {
  it("reads the original date in the closed formats, day first", () => {
    expect(originalCreatedOn("04/03/2012", TODAY)).toEqual({ date: "2012-03-04", warning: null });
    expect(originalCreatedOn("4.3.2012", TODAY)).toEqual({ date: "2012-03-04", warning: null });
    expect(originalCreatedOn("2012-03-04", TODAY)).toEqual({ date: "2012-03-04", warning: null });
    // an Excel date cell with a time of day
    expect(originalCreatedOn("2012-03-04 10:15", TODAY)).toEqual({ date: "2012-03-04", warning: null });
    expect(originalCreatedOn("26/10/2026", TODAY)).toEqual({ date: "2026-10-26", warning: null });
    expect(originalCreatedOn("", TODAY)).toEqual({ date: null, warning: null });
    expect(originalCreatedOn(undefined, TODAY)).toEqual({ date: null, warning: null });
  });

  it("never guesses: an unknown format, a day that does not exist, before 1990 or in the future is reported and not kept", () => {
    expect(originalCreatedOn("March 2012", TODAY)).toEqual({ date: null, warning: originalDateUnknown("March 2012") });
    expect(originalCreatedOn("31/02/2012", TODAY)).toEqual({ date: null, warning: originalDateUnknown("31/02/2012") });
    expect(originalCreatedOn("03/2012", TODAY)).toEqual({ date: null, warning: originalDateUnknown("03/2012") });
    expect(originalCreatedOn("31/12/1989", TODAY)).toEqual({ date: null, warning: originalDateOutOfRange("31/12/1989") });
    expect(originalCreatedOn("27/10/2026", TODAY)).toEqual({ date: null, warning: originalDateOutOfRange("27/10/2026") });
    expect(originalCreatedOn("01/01/1990", TODAY).date).toBe("1990-01-01");
  });

  it("a note: trimmed, at most 5,000 characters, its own date when it is a valid day", () => {
    expect(importNote("  שיחה ראשונה ", "10/02/2014", TODAY)).toEqual({ note: { body: "שיחה ראשונה", date: "2014-02-10" }, warning: null });
    expect(importNote("בלי תאריך", undefined, TODAY)).toEqual({ note: { body: "בלי תאריך", date: null }, warning: null });
    // a date alone is no note
    expect(importNote("   ", "10/02/2014", TODAY)).toEqual({ note: null, warning: null });
    expect(importNote("x".repeat(5000), undefined, TODAY).note?.body).toHaveLength(5000);
    expect(importNote("x".repeat(5001), undefined, TODAY)).toEqual({ note: null, warning: NOTE_TOO_LONG });
    // a date that is not a valid day leaves the note without a date of its own
    expect(importNote("הערה", "אתמול", TODAY)).toEqual({ note: { body: "הערה", date: null }, warning: noteDateUnknown("אתמול") });
    expect(importNote("הערה", "01/01/2030", TODAY)).toEqual({ note: { body: "הערה", date: null }, warning: noteDateUnknown("01/01/2030") });
  });

  it("the history columns are offered for leads, contacts, companies and deals, and found by their headers", () => {
    for (const entity of ["lead", "contact", "company", "deal"] as const) {
      const keys = IMPORT_TARGETS[entity].map((t) => t.key);
      expect(keys).toEqual(expect.arrayContaining(["original_created_on", "import_note", "import_note_date"]));
    }
    expect(IMPORT_TARGETS.task.map((t) => t.key)).not.toContain("import_note");
    expect(suggestMapping(["שם", "תאריך יצירה", "הערות", "תאריך ההערה"], IMPORT_TARGETS.lead)).toEqual([
      "full_name",
      "original_created_on",
      "import_note",
      "import_note_date",
    ]);
    // the lead's own message stays its own field
    expect(suggestMapping(["הודעה"], IMPORT_TARGETS.lead)).toEqual(["message"]);
    expect(mapsHistory(["full_name", "import_note"])).toBe(true);
    expect(mapsHistory(["full_name", "phone"])).toBe(false);
  });

  it("the record card shows the original day first, then when it came in", () => {
    expect(createdLineText("26.10.2026, 14:05", "4.3.2012")).toBe("4.3.2012 במערכת הקודמת · יובא 26.10.2026, 14:05");
    expect(createdLineText("26.10.2026, 14:05", null)).toBe("26.10.2026, 14:05");
  });

  it("an import note is under the timeline's notes, not its changes, and only owners and admins remove it", () => {
    expect(parseTimelineFilter("note").types).toContain("import_note");
    expect(parseTimelineFilter("system").excludeTypes).toContain("import_note");
    const viewer = (role: string, canWrite = true) => ({ userId: "u", role, canWrite });
    expect(canRemoveImportNoteHint({ type: "import_note" }, viewer("owner"))).toBe(true);
    expect(canRemoveImportNoteHint({ type: "import_note" }, viewer("admin"))).toBe(true);
    expect(canRemoveImportNoteHint({ type: "import_note" }, viewer("admin", false))).toBe(false);
    expect(canRemoveImportNoteHint({ type: "import_note" }, viewer("manager"))).toBe(false);
    expect(canRemoveImportNoteHint({ type: "import_note" }, viewer("member"))).toBe(false);
    expect(canRemoveImportNoteHint({ type: "note" }, viewer("owner"))).toBe(false);
  });
});
