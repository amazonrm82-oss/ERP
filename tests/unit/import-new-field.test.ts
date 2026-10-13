import { describe, expect, it } from "vitest";

import { createFieldSchema } from "@/features/custom-fields/schema";
import { parseCustomFields } from "@/features/custom-fields/values";
import { inputName, type FieldDefinition } from "@/features/custom-fields/types";
import { columnOptions, columnValues, IMPORT_NEW_FIELD_TYPES, MAX_COLUMN_OPTIONS, suggestFieldType } from "@/features/imports/new-field";

describe("IMP-01: a new field from an imported column", () => {
  it("reads the filled cells of one column", () => {
    expect(columnValues([["a", " x "], ["b", ""], ["c"]], 1)).toEqual(["x"]);
  });

  it("guesses the type only when every value fits it", () => {
    expect(suggestFieldType([])).toBe("text");
    expect(suggestFieldType(["a@b.co", "C@D.org"])).toBe("email");
    expect(suggestFieldType(["2026-10-13", "1980-01-31"])).toBe("date");
    // a day-first date is not read by the import as a date field: stays text
    expect(suggestFieldType(["13/10/2026"])).toBe("text");
    expect(suggestFieldType(["https://a.co", "www.b.co.il/x"])).toBe("url");
    expect(suggestFieldType(["12", "3.5", "1,200"])).toBe("number");
    expect(suggestFieldType(["0521234567", "031234567"])).toBe("phone");
    expect(suggestFieldType(["+972 52-123-4567", "052-1234567"])).toBe("phone");
    expect(suggestFieldType(["x".repeat(501)])).toBe("long_text");
    expect(suggestFieldType(["גבוה", "נמוך", "גבוה", "גבוה", "נמוך", "בינוני", "גבוה", "נמוך", "בינוני"])).toBe("select");
    expect(suggestFieldType(["אחד", "שתיים", "שלוש"])).toBe("text");
  });

  it("never offers a member field (a file has no member ids)", () => {
    expect(IMPORT_NEW_FIELD_TYPES).not.toContain("user");
    expect(IMPORT_NEW_FIELD_TYPES).toContain("multi_select");
  });

  it("makes the choices from distinct values, at most 50, splitting commas only for several", () => {
    expect(columnOptions(["א", "ב", "א", " ב "], "select")).toEqual({ options: ["א", "ב"], more: false });
    expect(columnOptions(["א, ב", "ג;א"], "multi_select")).toEqual({ options: ["א", "ב", "ג"], more: false });
    expect(columnOptions(["א, ב"], "select").options).toEqual(["א, ב"]);
    const many = Array.from({ length: 60 }, (_, i) => `v${i}`);
    const made = columnOptions(many, "select");
    expect(made.options).toHaveLength(MAX_COLUMN_OPTIONS);
    expect(made.more).toBe(true);
    // a choice longer than the field settings allow is left out
    expect(columnOptions(["x".repeat(101), "ok"], "select").options).toEqual(["ok"]);
  });

  it("the choices pass the field settings schema and the import's value check", () => {
    const values = ["גבוה", "נמוך", "גבוה, נמוך"];
    const { options } = columnOptions(values, "multi_select");
    const parsed = createFieldSchema.safeParse({
      label: "עדיפות",
      options: options.join("\n"),
      help_text: "",
      is_required: null,
      object_type: "lead",
      field_type: "multi_select",
    });
    expect(parsed.success).toBe(true);
    const field: FieldDefinition = { id: "1", key: "f_x", label: "עדיפות", type: "multi_select", options, isRequired: false, isActive: true, helpText: null };
    for (const value of values) {
      const form = new FormData();
      form.set(inputName("f_x"), value);
      expect(parseCustomFields([field], form).errors).toEqual({});
    }
  });
});
