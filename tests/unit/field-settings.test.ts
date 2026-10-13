import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  canBeUnique,
  canHaveDefault,
  customValuesForCreate,
  customValuesForUpdate,
  fieldSettingsProblem,
  isEmptyCustomValue,
  UNIQUE_TYPES,
} from "@/features/custom-fields/settings";
import type { FieldDefinition } from "@/features/custom-fields/types";
import { FIELD_TYPES } from "@/features/custom-fields/types";
import { conversionErrorMessage, customFieldMessage, dbErrorMessage, isUniqueFieldClash } from "@/lib/errors";

// FLD-07: the app's rules mirror app.field_settings_check() (migration field_settings).
function latestSettingsCheck(): string {
  const dir = join(process.cwd(), "supabase/migrations");
  const latest = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .filter((name) => readFileSync(join(dir, name), "utf8").includes("create or replace function app.field_settings_check"))
    .pop();
  expect(latest).toBeTruthy();
  return readFileSync(join(dir, latest!), "utf8");
}

describe("custom field settings (FLD-07)", () => {
  it("UNIQUE_TYPES is the database's list", () => {
    const sql = latestSettingsCheck();
    const match = /new\.is_unique and new\.field_type not in \(([^)]*)\)/.exec(sql);
    expect(match).toBeTruthy();
    const dbTypes = [...match![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect([...UNIQUE_TYPES].sort()).toEqual(dbTypes.sort());
    for (const type of UNIQUE_TYPES) expect(FIELD_TYPES).toContain(type);
  });

  it("empty for the read-only rule: null, absent or blank text; 0, false and [] are values (as app.custom_value_empty)", () => {
    for (const value of [null, undefined, "", "   ", "\t"]) expect(isEmptyCustomValue(value), JSON.stringify(value)).toBe(true);
    for (const value of [0, false, "0", "x", [], " a "]) expect(isEmptyCustomValue(value), JSON.stringify(value)).toBe(false);
    const sql = readFileSync(join(process.cwd(), "supabase/migrations", readdirSync(join(process.cwd(), "supabase/migrations")).filter((n) => readFileSync(join(process.cwd(), "supabase/migrations", n), "utf8").includes("function app.custom_value_empty")).sort().pop()!), "utf8");
    expect(sql).toContain("jsonb_typeof(p_value) = 'string' and (p_value #>> '{}') ~ '^[[:space:]]*$'");
  });

  it("unique and default rules", () => {
    expect(canBeUnique("email")).toBe(true);
    expect(canBeUnique("select")).toBe(false);
    expect(canHaveDefault("user")).toBe(false);
    expect(canHaveDefault("select")).toBe(true);
    expect(fieldSettingsProblem("text", true, null)).toBeNull();
    expect(fieldSettingsProblem("text", false, "x")).toBeNull();
    expect(fieldSettingsProblem("checkbox", true, null)).toMatch(/ייחודי/);
    expect(fieldSettingsProblem("text", true, "x")).toMatch(/ברירת מחדל/);
    expect(fieldSettingsProblem("user", false, "11111111-1111-4111-8111-111111111111")).toMatch(/משתמש/);
    expect(fieldSettingsProblem("number", false, 0)).toBeNull();
  });

  it("errors name the field from the detail (PostgREST 'details' or node-postgres 'detail')", () => {
    expect(dbErrorMessage({ code: "23505", hint: "custom_field:unique", details: "מספר לקוח" })).toContain('"מספר לקוח"');
    expect(dbErrorMessage({ code: "P0001", hint: "custom_field:read_only", detail: "מקור" })).toContain('"מקור"');
    expect(dbErrorMessage({ code: "P0001", hint: "custom_field:unique_existing", details: "3" })).toContain("3 רשומות");
    expect(dbErrorMessage({ code: "P0001", hint: "custom_field:unique_existing", details: "x" })).toContain("כמה רשומות");
    expect(customFieldMessage({ code: "23505", hint: "custom_field:unique" })).toBeTruthy();
    expect(customFieldMessage({ code: "23505" })).toBeNull();
    // other errors are untouched
    expect(dbErrorMessage({ code: "23505" })).toBe("כבר קיימת רשומה כזו.");
    // a race: the constraint answers without a hint
    const bare = { code: "23505", message: 'duplicate key value violates unique constraint "custom_unique_values_value"', details: "Key (...)=(...) already exists." };
    expect(dbErrorMessage(bare)).toBe("אחד הערכים כבר קיים ברשומה אחרת, והשדה מוגדר כייחודי.");
    expect(isUniqueFieldClash(bare)).toBe(true);
    expect(isUniqueFieldClash({ code: "23505", message: "other" })).toBe(false);
  });

  it("a conversion refusal says the clash is on the new contact or deal", () => {
    const named = conversionErrorMessage({ code: "23505", hint: "custom_field:unique", details: "מספר לקוח" }, "x");
    expect(named).toContain('"מספר לקוח"');
    expect(named).toContain("לאיש הקשר או לעסקה שנוצרים בהמרה");
    expect(conversionErrorMessage({ code: "23505", message: 'violates unique constraint "custom_unique_values_value"' }, "x")).toContain("שנוצרים בהמרה");
    expect(conversionErrorMessage({ code: "XX000" }, "נפל")).toBe("נפל");
  });
});

describe("form values with read-only fields (FLD-07)", () => {
  const field = (key: string, type: FieldDefinition["type"], extra: Partial<FieldDefinition> = {}): FieldDefinition => ({
    id: key,
    key,
    label: key,
    type,
    options: [],
    isRequired: false,
    isActive: true,
    helpText: null,
    ...extra,
  });
  const definitions = [
    field("locked_box", "checkbox", { isReadOnly: true }),
    field("locked_box_def", "checkbox", { isReadOnly: true, defaultValue: true }),
    field("box", "checkbox"),
    field("locked_text", "text", { isReadOnly: true }),
    field("tier", "select", { options: ["א", "ב"], defaultValue: "א" }),
  ];

  it("a create leaves out an unticked read-only checkbox (false would lock it), and sends null for a cleared default", () => {
    expect(customValuesForCreate(definitions, { locked_box: false, locked_box_def: false, box: false, locked_text: "  ", tier: null })).toEqual({
      box: false,
      locked_box_def: null,
      tier: null,
    });
    expect(customValuesForCreate(definitions, { locked_box: true, locked_box_def: true, box: true, locked_text: "x", tier: "ב" })).toEqual({
      locked_box: true,
      locked_box_def: true,
      box: true,
      locked_text: "x",
      tier: "ב",
    });
  });

  it("an edit sends a read-only field only to fill it", () => {
    expect(customValuesForUpdate(definitions, { locked_box: false, box: false, locked_text: "", tier: null })).toEqual({ box: false, tier: null });
    expect(customValuesForUpdate(definitions, { locked_box: true, locked_text: "x" })).toEqual({ locked_box: true, locked_text: "x" });
  });
});
