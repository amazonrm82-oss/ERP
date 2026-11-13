import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { FieldDefinition } from "@/features/custom-fields/types";
import { FORM_EXCLUDED_TYPES } from "@/features/intake/fields";
import { checkPrefillFields, PREFILL_BUILT_IN, prefillChoices, prefillFieldProblem } from "@/features/prefill-links/fields";
import { prefillWrongField, publicPrefillFrom } from "@/features/prefill-links/public";
import { prefillWhatsappHref } from "@/features/prefill-links/texts";

const migration = (suffix: string) => {
  const dir = join(process.cwd(), "supabase/migrations");
  const file = readdirSync(dir).find((f) => f.endsWith(suffix));
  if (!file) throw new Error(suffix);
  return readFileSync(join(dir, file), "utf8");
};

const definition = (key: string, type: FieldDefinition["type"], extra: Partial<FieldDefinition> = {}): FieldDefinition => ({
  id: key,
  key,
  label: `שדה ${key}`,
  type,
  options: [],
  isRequired: false,
  isActive: true,
  helpText: null,
  ...extra,
});

describe("BIZ-05 prefill fields", () => {
  it("the built-in lists, labels and types equal the migration's (app.prefill_builtin_keys / _label / _type)", () => {
    const forms = migration("_prefill_forms.sql");
    const links = migration("_prefill_links.sql");
    for (const type of ["lead", "contact"] as const) {
      const line = new RegExp(`-- prefill-builtins:${type}\\n\\s*when '${type}' then array\\[([^\\]]+)\\]`).exec(forms);
      expect(line, type).not.toBeNull();
      const keys = [...(line?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
      expect(keys).toEqual(PREFILL_BUILT_IN[type].map((f) => f.key));
      for (const field of PREFILL_BUILT_IN[type]) {
        expect(links, field.key).toContain(`when '${field.key}' then '${field.label}'`);
        if (field.type !== "text") expect(links).toContain(`when '${field.key}' then '${field.type}'`);
      }
    }
    // the excluded custom field types equal FORM_EXCLUDED_TYPES
    const excluded = /select array\[([^\]]+)\]\n\$\$;\nrevoke all on function app\.prefill_excluded_types/.exec(forms);
    expect([...(excluded?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual([...FORM_EXCLUDED_TYPES].sort());
  });

  it("a key is asked only when it is a built-in of the type or an active, public-form, non-sensitive custom field", () => {
    const defs = [
      definition("diet", "select"),
      definition("doc", "file"),
      definition("notes", "rich_text"),
      definition("allergy", "text", { privacyClass: "sensitive" }),
      definition("old", "text", { isActive: false }),
      definition("street", "address"),
    ];
    expect(prefillFieldProblem("contact", "first_name", defs)).toBeNull();
    expect(prefillFieldProblem("lead", "first_name", defs)).toBe("field");
    expect(prefillFieldProblem("contact", "cf:diet", defs)).toBeNull();
    expect(prefillFieldProblem("contact", "cf:street", defs)).toBeNull();
    expect(prefillFieldProblem("contact", "cf:doc", defs)).toBe("field");
    expect(prefillFieldProblem("contact", "cf:notes", defs)).toBe("field");
    expect(prefillFieldProblem("contact", "cf:old", defs)).toBe("field");
    expect(prefillFieldProblem("contact", "cf:missing", defs)).toBe("field");
    expect(prefillFieldProblem("contact", "cf:allergy", defs)).toBe("sensitive");
    expect(prefillChoices("contact", defs).map((c) => c.key)).toEqual([...PREFILL_BUILT_IN.contact.map((f) => f.key), "cf:diet", "cf:street"]);
    expect(checkPrefillFields("contact", [], defs)).toBe("empty");
    expect(checkPrefillFields("contact", ["email", "email"], defs)).toBe("field");
    expect(checkPrefillFields("contact", ["email", "cf:allergy"], defs)).toBe("sensitive");
    expect(checkPrefillFields("contact", Array.from({ length: 21 }, (_, i) => `cf:f${i}`), defs)).toBe("many");
    expect(checkPrefillFields("contact", ["email", "cf:diet"], defs)).toBeNull();
  });
});

describe("BIZ-05 public answer", () => {
  const business = { business: "עסק", brand: { logo: null, color: "#336699" }, built_with: true };

  it("shapes an open page and a done page; refuses anything else", () => {
    const open = publicPrefillFrom({
      status: "open",
      ...business,
      title: "פרטים",
      intro: null,
      notice: { name: "עסק", email: null, phone: "03-1234567" },
      fields: [
        { key: "first_name", label: "שם פרטי", type: "text", options: [], help: null, required: false, read_only: false, value: "דנה" },
        { key: "cf:diet", label: "תזונה", type: "select", options: ["א"], help: "עזרה", required: true, read_only: false, value: null },
      ],
    });
    expect(open).toMatchObject({ status: "open", title: "פרטים", color: "#336699", notice: { business: "עסק", phone: "03-1234567" } });
    expect(open?.status === "open" && open.fields.map((f) => [f.key, f.required, f.value])).toEqual([
      ["first_name", false, "דנה"],
      ["cf:diet", true, null],
    ]);
    expect(publicPrefillFrom({ status: "done", ...business })).toEqual({ status: "done", business: "עסק", logoPath: null, color: "#336699", builtWith: true });
    expect(publicPrefillFrom({ status: "open", ...business })).toBeNull();
    expect(publicPrefillFrom(null)).toBeNull();
  });

  it("maps the submit's fixed messages to the field, never a value", () => {
    expect(prefillWrongField("invalid email address")).toBe("email");
    expect(prefillWrongField("invalid phone")).toBe("phone");
    expect(prefillWrongField("invalid birth date")).toBe("birth_date");
    expect(prefillWrongField("invalid custom field: diet")).toBe("cf:diet");
    expect(prefillWrongField("required field missing: cf:diet")).toBe("cf:diet");
    expect(prefillWrongField("something else")).toBeUndefined();
  });

  it("the WhatsApp link goes to the person's number only when it is E.164", () => {
    expect(prefillWhatsappHref("https://x/f/fill/t", "עסק", "דנה", "+972501234567")).toMatch(/^https:\/\/wa\.me\/972501234567\?text=/);
    expect(prefillWhatsappHref("https://x/f/fill/t", null, null, "050")).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(decodeURIComponent(prefillWhatsappHref("https://x/f/fill/t", "עסק", "דנה", null))).toContain("שלום דנה, כאן עסק.");
  });
});
