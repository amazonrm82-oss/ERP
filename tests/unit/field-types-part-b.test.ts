import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { mapLinks } from "@/features/custom-fields/links";
import { canBeRequired, canHaveDefault } from "@/features/custom-fields/settings";
import { createFieldSchema } from "@/features/custom-fields/schema";
import { LINK_TARGETS, sortableField, type FieldDefinition, type FieldType } from "@/features/custom-fields/types";
import { displayCustomFields, FILE_FALLBACK, parseCustomFields, RECORD_LINK_FALLBACK } from "@/features/custom-fields/values";
import { automationSettable } from "@/features/automations/set-field";
import { boardCatalog } from "@/features/deals/board-fields";
import { copyCustomFields } from "@/features/deals/copy";
import { FORM_EXCLUDED_TYPES } from "@/features/intake/fields";

const field = (type: FieldType, extra: Partial<FieldDefinition> = {}): FieldDefinition => ({
  id: "f",
  key: "f",
  label: "שדה",
  type,
  options: [],
  isRequired: false,
  isActive: true,
  helpText: null,
  ...extra,
});
const parse = (definition: FieldDefinition, input: string | null) => {
  const form = new FormData();
  if (input !== null) form.set("cf_f", input);
  return parseCustomFields([definition], form);
};
const ID = "0b7c7c64-34c4-4b4e-9b62-0d9f8a3c1e11";

// FLD-06 part B: address, record link and file fields.
describe("address", () => {
  it("is one line up to 500 characters", () => {
    expect(parse(field("address"), " הרצל 1, תל אביב ").values.f).toBe("הרצל 1, תל אביב");
    expect(parse(field("address"), "x".repeat(500)).values.f).toBe("x".repeat(500));
    expect(parse(field("address"), "x".repeat(501)).errors.cf_f).toBeTruthy();
    expect(parse(field("address"), "שורה\nשנייה").errors.cf_f).toBe("הכתובת צריכה להיות בשורה אחת.");
    expect(parse(field("address"), "").values.f).toBeNull();
  });

  it("links to Waze and Google Maps by the text, URL-encoded, without a key", () => {
    expect(mapLinks("הרצל 1, תל אביב")).toEqual({
      waze: `https://waze.com/ul?q=${encodeURIComponent("הרצל 1, תל אביב")}&navigate=yes`,
      google: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent("הרצל 1, תל אביב")}`,
    });
    // spaces folded; characters that would break the link are encoded
    expect(mapLinks("  רחוב  א&ב #3 ")?.google).toBe("https://www.google.com/maps/search/?api=1&query=%D7%A8%D7%97%D7%95%D7%91%20%D7%90%26%D7%91%20%233");
    expect(mapLinks("   ")).toBeNull();
    const [shown] = displayCustomFields([field("address")], { f: "הרצל 1" });
    expect(shown.text).toBe("הרצל 1");
    expect(shown.maps?.waze).toContain("waze.com/ul?q=");
    expect(shown.href).toBeNull();
  });
});

describe("record link", () => {
  it("takes the picker's id; the database judges what it names", () => {
    expect(parse(field("record_link", { linkTarget: "contact" }), ID.toUpperCase()).values.f).toBe(ID);
    expect(parse(field("record_link", { linkTarget: "contact" }), "דנה כהן").errors.cf_f).toBe("יש לבחור רשומה מהחיפוש.");
    expect(parse(field("record_link", { linkTarget: "contact" }), "").values.f).toBeNull();
  });

  it("shows the record's name and page only when the page could read it; otherwise a neutral word", () => {
    const linked = field("record_link", { linkTarget: "company", refs: { [ID]: { label: "אקמה", href: `/o/x/companies/${ID}` } } });
    const [readable] = displayCustomFields([linked], { f: ID });
    expect(readable.text).toBe("אקמה");
    expect(readable.internalHref).toBe(`/o/x/companies/${ID}`);
    const [hidden] = displayCustomFields([field("record_link", { linkTarget: "company" })], { f: ID });
    expect(hidden.text).toBe(RECORD_LINK_FALLBACK);
    expect(hidden.internalHref).toBeNull();
    expect(hidden.text).not.toContain(ID);
  });

  it("needs its target when the field is made; four targets", () => {
    expect(LINK_TARGETS).toEqual(["lead", "contact", "company", "deal"]);
    const base = { label: "לקוח", options: "", help_text: "", is_required: null, is_unique: null, is_read_only: null, object_type: "deal", field_type: "record_link" };
    expect(createFieldSchema.safeParse(base).success).toBe(false);
    expect(createFieldSchema.safeParse({ ...base, link_target: "task" }).success).toBe(false);
    expect(createFieldSchema.safeParse({ ...base, link_target: "contact" }).success).toBe(true);
  });
});

describe("file", () => {
  it("is never read from the record's form (it is uploaded on its own), so an edit never clears it", () => {
    const { values, errors } = parse(field("file", { isRequired: true }), null);
    expect(values).toEqual({});
    expect(errors).toEqual({});
  });

  it("shows the file's name with its download link, or a neutral word", () => {
    const [shown] = displayCustomFields([field("file", { refs: { [ID]: { label: "חוזה.pdf", href: `/o/x/files/${ID}` } } })], { f: ID });
    expect(shown.text).toBe("חוזה.pdf");
    expect(shown.internalHref).toBe(`/o/x/files/${ID}`);
    expect(displayCustomFields([field("file")], { f: ID })[0].text).toBe(FILE_FALLBACK);
  });
});

describe("where the new types go (type-decisions.ts)", () => {
  it("public forms take an address only; no default for a link or a file; a file is never required", () => {
    expect(FORM_EXCLUDED_TYPES).not.toContain("address");
    expect(FORM_EXCLUDED_TYPES).toContain("record_link");
    expect(FORM_EXCLUDED_TYPES).toContain("file");
    expect(canHaveDefault("address")).toBe(true);
    expect(canHaveDefault("record_link")).toBe(false);
    expect(canHaveDefault("file")).toBe(false);
    expect(canBeRequired("file")).toBe(false);
    expect(canBeRequired("record_link")).toBe(true);
  });

  it("lists sort, automations set and board cards show an address but not a link or a file", () => {
    for (const type of ["record_link", "file"] as const) {
      expect(sortableField({ type }), type).toBe(false);
      expect(automationSettable({ type }), type).toBe(false);
    }
    expect(sortableField({ type: "address" })).toBe(true);
    expect(automationSettable({ type: "address" })).toBe(true);
    const keys = boardCatalog([
      { key: "a", label: "כתובת", type: "address" },
      { key: "l", label: "קישור", type: "record_link" },
      { key: "f", label: "קובץ", type: "file" },
    ]).map((column) => column.key);
    expect(keys).toContain("cf:a");
    expect(keys).not.toContain("cf:l");
    expect(keys).not.toContain("cf:f");
  });

  it("the database's value check has the same address rule and the same link targets", () => {
    const dir = join(process.cwd(), "supabase/migrations");
    const sql = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => readFileSync(join(dir, name), "utf8"))
      .filter((text) => text.includes("field_definitions_link_target_check"))
      .pop() as string;
    expect(sql).toContain("link_target in ('lead', 'contact', 'company', 'deal')");
    expect(sql).toContain("char_length(v_text) <= 500 and position(chr(10) in v_text) = 0");
  });

  it("a deal copy carries a record link (the server then checks the copier may use it) and never a file, silently", () => {
    const copied = copyCustomFields({ link: ID, doc: ID, site: "הרצל 1" }, [
      field("record_link", { key: "link", linkTarget: "contact" }),
      field("file", { key: "doc" }),
      field("address", { key: "site" }),
    ]);
    expect(copied.values).toEqual({ link: ID, site: "הרצל 1" });
    expect(copied.skipped).toEqual([]);
  });
});
