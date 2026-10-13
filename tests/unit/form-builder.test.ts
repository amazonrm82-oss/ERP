import { describe, expect, it } from "vitest";

import { formFieldOptions, parseFieldsConfig, storedFields, type FormFieldConfig } from "@/features/intake/fields";
import { publicFormFrom } from "@/features/intake/public-form";
import { checkSubmission, conditionMet, hasValue, wrongField, type PublicField } from "@/features/intake/public-validate";
import { checkFormFields } from "@/features/intake/schema";
import { customInputs } from "@/features/intake/server";
import type { FieldDefinition } from "@/features/custom-fields/types";

const def = (key: string, type: FieldDefinition["type"], options: string[] = [], isActive = true): FieldDefinition => ({
  id: key,
  key,
  label: `שדה ${key}`,
  type,
  options,
  isRequired: false,
  isActive,
  helpText: null,
});

const OPTIONS = formFieldOptions([
  def("service", "select", ["שיפוץ", "ניקיון"]),
  def("budget", "currency"),
  def("extras", "multi_select", ["חלונות", "גג"]),
  def("agree", "checkbox"),
  def("who", "user"),
  def("old", "text", [], false),
]);

describe("form builder: the stored shape (CAP-01)", () => {
  it("reads old forms and new ones, and writes back the database's shape", () => {
    expect(parseFieldsConfig([{ key: "full_name", required: true }, { key: "password" }, { key: "full_name" }])).toEqual([
      { key: "full_name", required: true, help: null, showIf: null },
    ]);
    const fields: FormFieldConfig[] = [
      { key: "cf:service", required: true, help: " עזרה ", showIf: null },
      { key: "phone", required: false, help: null, showIf: { field: "cf:service", value: "שיפוץ" } },
      // a condition on a later field is dropped
      { key: "email", required: false, help: null, showIf: { field: "message", value: null } },
      { key: "message", required: false, help: null, showIf: null },
    ];
    const stored = storedFields(fields);
    expect(stored).toEqual([
      { key: "cf:service", required: true, help: " עזרה " },
      { key: "phone", required: false, show_if: { field: "cf:service", value: "שיפוץ" } },
      { key: "email", required: false, show_if: { field: "message", value: null } },
      { key: "message", required: false },
    ]);
    expect(parseFieldsConfig(stored).map((f) => [f.key, f.help, f.showIf])).toEqual([
      ["cf:service", "עזרה", null],
      ["phone", null, { field: "cf:service", value: "שיפוץ" }],
      ["email", null, null],
      ["message", null, null],
    ]);
  });

  it("offers the built-in fields and the lead's custom fields, without team-member pickers", () => {
    expect(OPTIONS.map((o) => o.key)).toEqual(["full_name", "phone", "email", "company_name", "message", "cf:service", "cf:budget", "cf:extras", "cf:agree", "cf:old"]);
  });

  it("checks what the builder sends", () => {
    const ok = checkFormFields(
      [
        { key: "phone", required: true },
        { key: "cf:service", required: false, help: "  " },
        { key: "cf:budget", required: true, showIf: { field: "cf:service", value: "שיפוץ" } },
        { key: "cf:extras", required: false, showIf: { field: "phone", value: null } },
      ],
      OPTIONS,
    );
    expect(ok).toEqual({
      ok: true,
      fields: [
        { key: "phone", required: true, help: null, showIf: null },
        { key: "cf:service", required: false, help: null, showIf: null },
        { key: "cf:budget", required: true, help: null, showIf: { field: "cf:service", value: "שיפוץ" } },
        { key: "cf:extras", required: false, help: null, showIf: { field: "phone", value: null } },
      ],
    });
    const fail = (input: Parameters<typeof checkFormFields>[0]) => {
      const result = checkFormFields(input, OPTIONS);
      return result.ok ? null : result.message;
    };
    expect(fail([{ key: "phone", required: false }, { key: "cf:who", required: false }])).toMatch(/כבר לא קיים/);
    expect(fail([{ key: "phone", required: false }, { key: "cf:nope", required: false }])).toMatch(/כבר לא קיים/);
    expect(fail([{ key: "phone", required: false }, { key: "phone", required: false }])).toMatch(/פעמיים/);
    expect(fail([{ key: "phone", required: false, showIf: { field: "email", value: null } }, { key: "email", required: false }])).toMatch(/לפניו/);
    expect(fail([{ key: "phone", required: false }, { key: "email", required: false, showIf: { field: "phone", value: "x" } }])).toMatch(/אחת האפשרויות/);
    expect(fail([{ key: "phone", required: false }, { key: "cf:service", required: false }, { key: "email", required: false, showIf: { field: "cf:service", value: "אחר" } }])).toMatch(
      /אחת האפשרויות/,
    );
    expect(fail([{ key: "phone", required: false, help: "x".repeat(301) }])).toMatch(/ארוך מדי/);
    // a name, phone or email without a condition
    expect(fail([{ key: "cf:agree", required: false }, { key: "phone", required: false, showIf: { field: "cf:agree", value: null } }])).toMatch(/שם, טלפון או אימייל/);
    expect(fail([{ key: "message", required: false }])).toMatch(/שם, טלפון או אימייל/);
  });
});

const FIELDS: PublicField[] = [
  { key: "full_name", required: true, label: "שם מלא" },
  { key: "phone", required: false, label: "טלפון" },
  { key: "cf:service", required: true, custom: { type: "select", label: "שירות", options: ["שיפוץ", "ניקיון"] } },
  { key: "cf:budget", required: true, showIf: { field: "cf:service", value: "שיפוץ" }, custom: { type: "currency", label: "תקציב", options: [] } },
  { key: "cf:extras", required: false, showIf: { field: "cf:service", value: null }, custom: { type: "multi_select", label: "תוספות", options: ["חלונות", "גג"] } },
  { key: "message", required: true, showIf: { field: "cf:extras", value: "גג" }, label: "הודעה" },
  { key: "cf:agree", required: true, custom: { type: "checkbox", label: "מסכים", options: [] } },
];

describe("hosted form: conditions, required and custom values (CAP-01)", () => {
  it("'has a value' and conditions match the database (app.intake_has_value / intake_condition_met)", () => {
    expect([null, undefined, "", "  ", false, []].map(hasValue)).toEqual([false, false, false, false, false, false]);
    expect(["x", 0, true, ["a"]].map(hasValue)).toEqual([true, true, true, true]);
    expect(conditionMet("שיפוץ", "שיפוץ")).toBe(true);
    expect(conditionMet("ניקיון", "שיפוץ")).toBe(false);
    expect(conditionMet(["גג", "חלונות"], "גג")).toBe(true);
    expect(conditionMet(5, null)).toBe(true);
    expect(conditionMet(5, "5")).toBe(false);
    expect(conditionMet(false, null)).toBe(false);
  });

  it("shows a field only when its condition holds, and types the custom values", () => {
    const empty = checkSubmission(FIELDS, {});
    expect([...empty.visible]).toEqual(["full_name", "phone", "cf:service", "cf:agree"]);
    expect(empty.errors).toEqual({ full_name: "יש למלא שם מלא.", cf_service: "יש למלא את השדה.", cf_agree: "יש לסמן את השדה." });

    const full = checkSubmission(FIELDS, {
      full_name: " דנה ",
      cf_service: "שיפוץ",
      cf_budget: "1,250.50",
      cf_extras: ["גג", "חלונות"],
      message: "שלום",
      cf_agree: "on",
    });
    expect(full.errors).toEqual({});
    expect([...full.visible]).toEqual(["full_name", "phone", "cf:service", "cf:budget", "cf:extras", "message", "cf:agree"]);
    expect(full.custom).toEqual({ service: "שיפוץ", budget: 125050, extras: ["חלונות", "גג"], agree: true });
    expect(full.builtins).toEqual({ full_name: "דנה", phone: null, email: null, company_name: null, message: "שלום" });
  });

  it("drops what was typed into a field that is hidden now, and does not require it", () => {
    const r = checkSubmission(FIELDS, { full_name: "דנה", cf_service: "ניקיון", cf_budget: "abc", message: "נשאר מקודם", cf_agree: "on" });
    expect(r.errors).toEqual({});
    expect(r.custom).toEqual({ service: "ניקיון", agree: true });
    expect(r.builtins.message).toBeNull();
  });

  it("names the wrong custom inputs", () => {
    const r = checkSubmission(FIELDS, { full_name: "דנה", cf_service: "אחר", cf_agree: "on" });
    expect(r.errors).toEqual({ cf_service: "יש לבחור ערך מהרשימה." });
    const budget = checkSubmission(FIELDS, { full_name: "דנה", cf_service: "שיפוץ", cf_budget: "הרבה", cf_agree: "on" });
    expect(budget.errors).toEqual({ cf_budget: "יש להזין סכום בשקלים." });
  });

  it("a custom field missing from the definitions is left out", () => {
    const r = checkSubmission([{ key: "phone", required: true, label: "טלפון" }, { key: "cf:gone", required: true }], { phone: "050-1234567", cf_gone: "x" });
    expect(r.errors).toEqual({});
    expect(r.custom).toEqual({});
  });

  it("maps the database's new errors to the input", () => {
    expect(wrongField("required field missing: cf:budget")).toBe("cf_budget");
    expect(wrongField("invalid custom field: budget")).toBe("cf_budget");
    expect(wrongField("invalid custom field: Bad")).toBeUndefined();
  });
});

describe("hosted form: what the server reads (CAP-01)", () => {
  it("turns intake_form()'s reply into fields, leaving out what cannot be shown", () => {
    const form = publicFormFrom({
      title: "בקשת הצעה",
      intro: "",
      submit_label: null,
      fields: [
        { key: "full_name", required: true, help: "שם ומשפחה", show_if: null, label: null, type: null, options: null },
        { key: "cf:service", required: false, help: null, show_if: null, label: "שירות", type: "select", options: ["א", "ב"] },
        { key: "cf:who", required: false, help: null, show_if: null, label: "מי", type: "user", options: [] },
        { key: "cf:budget", required: true, help: null, show_if: { field: "cf:who", value: null }, label: "תקציב", type: "currency", options: [] },
        { key: "cf:weird", required: false, help: null, show_if: null, label: "?", type: "hologram", options: [] },
      ],
    });
    expect(form).toEqual({
      title: "בקשת הצעה",
      intro: null,
      submitLabel: "שליחת הפרטים",
      fields: [
        { key: "full_name", required: true, help: "שם ומשפחה", showIf: null, label: "שם מלא", custom: null },
        { key: "cf:service", required: false, help: null, showIf: null, label: "שירות", custom: { type: "select", label: "שירות", options: ["א", "ב"] } },
      ],
      brand: { logoPath: null, color: null },
      thanks: { whatsappUrl: null },
      callback: null,
    });
    expect(publicFormFrom(null)).toBeNull();
  });

  it("reads the business's logo and colour (FLD-04), and drops anything that is not one", () => {
    const logo = "11111111-2222-4333-8444-555555555555/66666666-7777-4888-8999-aaaaaaaaaaaa";
    expect(publicFormFrom({ title: "t", fields: [], brand: { logo, color: "#1e56d6" } })?.brand).toEqual({ logoPath: logo, color: "#1e56d6" });
    for (const brand of [{ logo: "../x", color: "red" }, { logo: `${logo}/x`, color: "#1E56D6" }, "x", null]) {
      expect(publicFormFrom({ title: "t", fields: [], brand })?.brand).toEqual({ logoPath: null, color: null });
    }
  });

  it("reads only cf_ inputs from a post, capped", () => {
    expect(
      customInputs({
        cf_service: " שיפוץ ",
        cf_extras: ["גג", 3, { x: 1 }],
        cf_agree: true,
        cf_count: 4,
        cf_Bad: "x",
        full_name: "דנה",
        cf_long: "א".repeat(6000),
      }),
    ).toEqual({ cf_service: "שיפוץ", cf_extras: ["גג", "3"], cf_agree: "on", cf_count: "4", cf_long: "א".repeat(5000) });
    const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`cf_f${i}`, "x"]));
    expect(Object.keys(customInputs(many))).toHaveLength(60);
    expect((customInputs({ cf_list: Array.from({ length: 80 }, () => "x") }).cf_list as string[]).length).toBe(50);
  });
});

describe("hosted form: lead fields that are not on the form", () => {
  it("pass as sent, and count as a way back to the person", () => {
    const r = checkSubmission([{ key: "message", required: false, label: "הודעה" }], { message: "שלום", email: "dana@example.com" });
    expect(r.errors).toEqual({});
    expect(r.builtins).toMatchObject({ email: "dana@example.com", message: "שלום" });
  });
});
