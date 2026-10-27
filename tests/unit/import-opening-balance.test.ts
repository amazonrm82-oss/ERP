import { describe, expect, it } from "vitest";

import { IMPORT_TARGETS } from "@/features/imports/fields";
import { importOpening, mapsOpeningBalance, OPENING_KEYS, openingsUndoneText } from "@/features/imports/opening-balance";

// GAP-12 (owner, 26 October 2026, answers (1) א, (3) ב, (4) ג): the opening balance column of a contacts or companies import.
describe("import: opening balance (GAP-12)", () => {
  const today = "2026-10-26";

  it("is offered on contacts and companies only", () => {
    for (const entity of ["contact", "company"] as const) expect(IMPORT_TARGETS[entity].some((t) => t.key === "opening_balance")).toBe(true);
    for (const entity of ["lead", "deal", "task", "product"] as const) expect(IMPORT_TARGETS[entity].some((t) => OPENING_KEYS.has(t.key))).toBe(false);
    expect(mapsOpeningBalance(["", "opening_balance_date"])).toBe(true);
    expect(mapsOpeningBalance(["phone"])).toBe(false);
  });

  it("reads a signed amount, the balance's date (else today) and a typed due date on a debt only", () => {
    expect(importOpening("1,250.50", "31/12/2025", "", today)).toEqual({ opening: { amountAgorot: 125050, date: "2025-12-31", due: null }, warning: null });
    expect(importOpening("-300", "", "", today).opening).toEqual({ amountAgorot: -30000, date: today, due: null });
    expect(importOpening("500", "01/01/2026", "15/01/2026", today).opening?.due).toBe("2026-01-15");
    // a due date on a credit, or before the balance's date, is dropped with a warning
    expect(importOpening("-500", "01/01/2026", "15/01/2026", today)).toMatchObject({ opening: { due: null } });
    expect(importOpening("500", "01/02/2026", "15/01/2026", today).warning).toMatch(/מועד התשלום/);
  });

  it("never guesses: an empty or zero amount is none; a bad amount or date records nothing, with a warning", () => {
    expect(importOpening("", "01/01/2026", "", today)).toEqual({ opening: null, warning: null });
    expect(importOpening("0", "", "", today)).toEqual({ opening: null, warning: null });
    expect(importOpening("אלף", "", "", today)).toMatchObject({ opening: null });
    expect(importOpening("אלף", "", "", today).warning).toMatch(/אינה סכום/);
    expect(importOpening("100", "1/1/1980", "", today).opening).toBeNull();
    expect(importOpening("100", "1/1/2030", "", today).opening).toBeNull();
  });

  it("the undo message names the cancelled opening balances", () => {
    expect(openingsUndoneText(0)).toBe("");
    expect(openingsUndoneText(1)).toContain("יתרת הפתיחה");
    expect(openingsUndoneText(3)).toContain("3 יתרות הפתיחה");
  });
});
