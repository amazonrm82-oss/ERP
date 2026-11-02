import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { contactSchema } from "@/features/contacts/schema";
import { GENDERS, GENDER_LABELS, genderFromForm, genderLabel, importGender } from "@/features/gender/gender";
import { reminderValues } from "@/features/calendar/tomorrow";
import { DEFAULT_TEMPLATES, fillTemplate, recordTemplateValues } from "@/features/whatsapp/templates";
import { templateSchema } from "@/features/whatsapp/schema";
import { pickVariants, templateVariantProblem } from "@/features/whatsapp/variants";
import { dbErrorMessage } from "@/lib/errors";

import cases from "./fixtures/gender-variants.json";

// HEB-01: found by its suffix (the lead renumbers migrations at merge)
const dir = new URL("../../supabase/migrations/", import.meta.url);
const file = readdirSync(dir).find((name) => name.endsWith("_gender.sql"));
const sql = readFileSync(new URL(file ?? "missing", dir), "utf8");

type Case = { text: string; problem: "variant" | "neutral" | null; male?: string; female?: string; neutral?: string };

describe("gender field (HEB-01)", () => {
  it("the codes equal both check constraints", () => {
    for (const table of ["leads", "contacts"]) {
      const match = new RegExp(`${table}_gender_check\\s+check \\(gender in \\(([^)]*)\\)\\)`).exec(sql);
      expect([...(match?.[1] ?? "").matchAll(/'([^']*)'/g)].map((m) => m[1])).toEqual([...GENDERS]);
    }
    expect(Object.keys(GENDER_LABELS)).toEqual([...GENDERS]);
    expect(genderLabel("female")).toBe("נקבה");
    expect(genderLabel("x")).toBeNull();
    expect(genderLabel(null)).toBeNull();
  });

  it("a form writes the gender only when it has the field", () => {
    const none = new FormData();
    expect(genderFromForm(none)).toEqual({ ok: true, patch: {} });
    const empty = new FormData();
    empty.set("gender", "");
    expect(genderFromForm(empty)).toEqual({ ok: true, patch: { gender: null } });
    const male = new FormData();
    male.set("gender", "male");
    expect(genderFromForm(male)).toEqual({ ok: true, patch: { gender: "male" } });
    const bad = new FormData();
    bad.set("gender", "other");
    expect(genderFromForm(bad).ok).toBe(false);
    expect(contactSchema.safeParse({ first_name: "דנה", gender: "female" }).data?.gender).toBe("female");
    expect(contactSchema.safeParse({ first_name: "דנה", gender: "" }).data?.gender).toBeNull();
    expect(contactSchema.safeParse({ first_name: "דנה", gender: "x" }).success).toBe(false);
  });

  it("an import cell is read from a closed list and never guessed", () => {
    expect(importGender(" זכר ")).toBe("male");
    expect(importGender("F")).toBe("female");
    expect(importGender("לא ידוע")).toBe("unknown");
    expect(importGender("")).toBeNull();
    expect(importGender("דנה")).toBe("invalid");
    expect(importGender("אישה")).toBe("invalid");
  });
});

describe("gender wordings in templates (HEB-01)", () => {
  it.each(cases as Case[])("$text", (c) => {
    expect(templateVariantProblem(c.text)).toBe(c.problem);
    if (c.problem === null) {
      expect(pickVariants(c.text, "male")).toBe(c.male);
      expect(pickVariants(c.text, "female")).toBe(c.female);
      expect(pickVariants(c.text, "unknown")).toBe(c.neutral);
      expect(pickVariants(c.text, null)).toBe(c.neutral);
    } else {
      // a text with a problem is never changed
      expect(pickVariants(c.text, "male")).toBe(c.text);
    }
  });

  it("the seeded defaults stay valid and unchanged", () => {
    for (const template of DEFAULT_TEMPLATES) {
      expect(templateVariantProblem(template.body)).toBeNull();
      expect(pickVariants(template.body, "female")).toBe(template.body);
    }
  });

  it("fillTemplate picks by the record's gender, then fills the placeholders", () => {
    const body = "שלום {שם פרטי}, {זכר: תודה שפנית | נקבה: תודה שפנית | ניטרלי: תודה על הפנייה}. {שם הנציג}";
    const context = { user: { displayName: "רון" }, org: { name: "העסק" } };
    expect(fillTemplate(body, recordTemplateValues({ fullName: "דנה כהן", gender: "female" }, context))).toBe("שלום דנה, תודה שפנית. רון");
    expect(fillTemplate(body, recordTemplateValues({ fullName: "דנה כהן" }, context))).toBe("שלום דנה, תודה על הפנייה. רון");
    expect(fillTemplate(body, recordTemplateValues({ fullName: "דנה כהן", gender: "something" }, context))).toBe("שלום דנה, תודה על הפנייה. רון");
  });

  it("the template form refuses a block without a neutral part, with the hint's own text", () => {
    const parsed = templateSchema.safeParse({ name: "א", body: "{זכר: אתה | נקבה: את}" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0].message).toBe(dbErrorMessage({ code: "P0001", hint: "whatsapp_template:neutral" }));
    expect(dbErrorMessage({ code: "P0001", hint: "whatsapp_template:variant" })).toContain("{זכר:");
  });

  it("tomorrow's meeting reminder takes the person's gender (review L-1)", () => {
    const context = { user: { displayName: "רון" }, org: { name: "העסק", timeZone: "Asia/Jerusalem" } };
    const person = { kind: "contact" as const, id: "c", firstName: "דנה", fullName: "דנה כהן", phone: null, phoneE164: null };
    const body = "{זכר: אתה מוזמן | נקבה: את מוזמנת | ניטרלי: מחכים לך} מחר";
    const meeting = { startsAt: "2026-11-03T08:00:00Z" };
    expect(fillTemplate(body, reminderValues({ ...person, gender: "female" }, meeting, context, "2026-11-03"))).toBe("את מוזמנת מחר");
    expect(fillTemplate(body, reminderValues(person, meeting, context, "2026-11-03"))).toBe("מחכים לך מחר");
  });
});
