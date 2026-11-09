import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FIELD_USE_REASONS, FILES_LINE, VALUES_LINE, fieldDeleteBlockedText, parseFieldUsage } from "@/features/custom-fields/usage";

describe("custom field delete: the reason line (FLD, owner 9 November 2026)", () => {
  it("no reason = the field may be deleted", () => {
    expect(fieldDeleteBlockedText([])).toBeNull();
  });

  it("stored values come first, in the owner's words", () => {
    expect(VALUES_LINE).toBe("אי אפשר למחוק: יש ערכים שמורים — אפשר להסתיר");
    expect(fieldDeleteBlockedText(["automation", "values", "files"])).toBe(VALUES_LINE);
    expect(fieldDeleteBlockedText(["files", "form"])).toBe(FILES_LINE);
  });

  it("names where the field is used", () => {
    expect(fieldDeleteBlockedText(["automation"])).toBe("אי אפשר למחוק: השדה משמש באוטומציה — אפשר להסתיר");
    expect(fieldDeleteBlockedText(["form", "automation"])).toBe("אי אפשר למחוק: השדה משמש באוטומציה ובטופס לידים — אפשר להסתיר");
    expect(fieldDeleteBlockedText(["segment", "condition", "lead_score"])).toBe(
      "אי אפשר למחוק: השדה משמש בתנאי של שדה אחר, בניקוד לידים ובפילוח — אפשר להסתיר",
    );
  });

  it("a hidden field is not told it may be hidden", () => {
    expect(fieldDeleteBlockedText(["values"], { hidden: true })).toBe("אי אפשר למחוק: יש ערכים שמורים");
    expect(fieldDeleteBlockedText(["form"], { hidden: true })).toBe("אי אפשר למחוק: השדה משמש בטופס לידים");
    expect(fieldDeleteBlockedText(["x"], { hidden: true })).toBe("אי אפשר למחוק: השדה בשימוש");
    expect(fieldDeleteBlockedText([], { hidden: true })).toBeNull();
  });

  it("every reason has a line, and an unknown code still blocks", () => {
    for (const reason of FIELD_USE_REASONS) {
      expect(fieldDeleteBlockedText([reason])).toMatch(/^אי אפשר למחוק: .+ — אפשר להסתיר$/);
    }
    expect(fieldDeleteBlockedText(["something_new"])).toBe("אי אפשר למחוק: השדה בשימוש — אפשר להסתיר");
  });

  it("the codes are the database's", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261006021194_custom_field_delete.sql"), "utf8");
    const found = new Set([...sql.matchAll(/select f\.id, '([a-z_]+)'/g)].map((m) => m[1]));
    expect([...found].sort()).toEqual([...FIELD_USE_REASONS].sort());
  });

  it("reads the page function's answer and ignores a malformed one", () => {
    expect(parseFieldUsage({ a: [{ reason: "values", uses: 3 }, { reason: "form", uses: 1 }], b: [] })).toEqual({ a: ["values", "form"] });
    expect(parseFieldUsage(null)).toEqual({});
    expect(parseFieldUsage([1, 2])).toEqual({});
    expect(parseFieldUsage({ a: "x" })).toEqual({});
  });
});
