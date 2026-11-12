import { describe, expect, it } from "vitest";

import { selectableDocumentKinds } from "@/features/document-templates/templates";

import { parseNote } from "@/features/activities/markdown";
import {
  DOCUMENT_BUSINESS_FIELDS,
  DOCUMENT_RECORD_FIELDS,
  DOCUMENT_RECORD_TYPES,
  documentFieldNames,
  fillDocument,
  markdownLiteral,
  unfilledDocumentFields,
  unknownDocumentFields,
} from "@/features/document-templates/fields";
import { documentBodyProblem, documentTemplateSchema } from "@/features/document-templates/schema";
import { DEFAULT_DOCUMENT_TEMPLATES, DOCUMENT_KINDS } from "@/features/document-templates/templates";
import { businessDocumentValues, dayText } from "@/features/document-templates/values";
import { MERGE_FIELD_PATTERN } from "@/features/message-templates/fields";

import { latestMigration } from "./helpers/migrations";

const migration = latestMigration("create table if not exists public.document_templates");
const sql = migration?.sql ?? "";

/** The SQL string concatenations with chr(10) of the seed, read back as one text each. */
function seedTexts(text: string): string {
  return text.replace(/'\s*((?:\|\|\s*chr\(10\)\s*)+)\|\|\s*'/g, (_all, chrs: string) => "\n".repeat((chrs.match(/chr\(10\)/g) ?? []).length));
}

const names = (text: string) => [...text.matchAll(/'([^']*)'/g)].map((m) => m[1]);

describe("document templates (SGN-01)", () => {
  it("the merge fields equal app.document_merge_fields(record_type)", () => {
    expect(migration).toBeDefined();
    const fieldsSql = latestMigration("create or replace function app.document_merge_fields(")?.sql ?? "";
    const body = fieldsSql.slice(fieldsSql.indexOf("create or replace function app.document_merge_fields("));
    const business = /select array\[([^\]]*)\]/.exec(body);
    expect(business).not.toBeNull();
    expect(names(business?.[1] ?? "")).toEqual(DOCUMENT_BUSINESS_FIELDS.map((field) => field.name));
    for (const type of DOCUMENT_RECORD_TYPES) {
      const own = new RegExp(`when '${type}' then array\\[([^\\]]*)\\]`).exec(body);
      expect(own, type).not.toBeNull();
      expect(names(own?.[1] ?? ""), type).toEqual(DOCUMENT_RECORD_FIELDS[type].map((field) => field.name));
      // every name is a field the shared pattern reads (1..30 characters, no ":" "|" braces)
      for (const name of documentFieldNames(type)) expect(`{${name}}`.match(MERGE_FIELD_PATTERN)?.[0], name).toBe(`{${name}}`);
    }
  });

  it("the field pattern and the closed lists equal the database's", () => {
    expect(sql).toContain(`'${MERGE_FIELD_PATTERN.source}'`);
    expect(sql).toContain(`kind in (${DOCUMENT_KINDS.map((t) => `'${t}'`).join(", ")})`);
    expect(sql).toContain(`record_type in (${DOCUMENT_RECORD_TYPES.map((t) => `'${t}'`).join(", ")})`);
  });

  it("the defaults equal the seed, use only their type's fields and pass the schema", () => {
    const seed = seedTexts(sql.slice(sql.indexOf("create or replace function app.seed_document_templates")));
    expect(DEFAULT_DOCUMENT_TEMPLATES.map((d) => d.kind)).toEqual(["service_agreement", "contract", "joining_form"]);
    // owner (202) ב: no health declaration is seeded until PRV-05
    expect(seed).not.toContain("health_declaration");
    // LEGAL-2 (7): nor offered for a new template or a change of kind; a template that has it keeps it
    expect(selectableDocumentKinds()).toEqual(["contract", "service_agreement", "joining_form", "other"]);
    expect(selectableDocumentKinds("contract")).not.toContain("health_declaration");
    expect(selectableDocumentKinds("health_declaration")).toContain("health_declaration");
    for (const d of DEFAULT_DOCUMENT_TEMPLATES) {
      expect(seed, d.name).toContain(`'${d.name}', '${d.kind}', '${d.recordType}',`);
      expect(seed, d.name).toContain(`'${d.body}'`);
      expect(unknownDocumentFields(d.body, d.recordType), d.name).toEqual([]);
      const parsed = documentTemplateSchema.safeParse({ name: d.name, kind: d.kind, record_type: d.recordType, body: d.body, is_active: "on" });
      expect(parsed.success, d.name).toBe(true);
      if (parsed.success) expect(parsed.data.body, d.name).toBe(d.body);
    }
  });

  it("refuses a field of another record type, a broken gender block and a mention", () => {
    expect(unknownDocumentFields("{שם העסקה} {שם מלא} {לא קיים}", "contact")).toEqual(["{שם העסקה}", "{לא קיים}"]);
    expect(unknownDocumentFields("{שם העסקה} {שם מלא}", "deal")).toEqual([]);
    expect(documentBodyProblem("{זכר: אתה | נקבה: את}", "contact")).not.toBeNull();
    expect(documentBodyProblem("{זכר: אתה | נקבה: את | ניטרלי: אתם}", "contact")).toBeNull();
    expect(documentBodyProblem("שלום @[דנה](user:11111111-1111-4111-8111-111111111111)", "contact")).not.toBeNull();
  });

  it("the schema cleans the body as REC-04 does", () => {
    const parsed = documentTemplateSchema.safeParse({
      name: "חוזה",
      kind: "contract",
      record_type: "deal",
      body: "  [לחצו](javascript:void)\r\n**חוזה** {שם העסקה}‮  ",
      is_active: "",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.body).toBe("לחצו\n**חוזה** {שם העסקה}");
      expect(parsed.data.is_active).toBe(false);
    }
  });

  it("fills values as literal text, keeps missing fields and picks the gender wording", () => {
    const filled = fillDocument("שלום {שם מלא}, {זכר: חתום | נקבה: חתומה | ניטרלי: חתום/ה} ב-{תאריך היום}. {טלפון}", { "שם מלא": "**דנה** [x](https://e.com) - 1" }, "female");
    expect(filled).toBe("שלום \\*\\*דנה\\*\\* \\[x\\]\\(https://e.com\\) \\- 1, חתומה ב-{תאריך היום}. {טלפון}");
    // the value is shown exactly as typed: no bold, no link
    const blocks = parseNote(filled);
    expect(blocks).toHaveLength(1);
    const line = blocks[0].kind === "paragraph" ? blocks[0].lines[0] : [];
    expect(line.every((node) => node.kind === "text")).toBe(true);
    expect(line.map((node) => (node.kind === "text" ? node.text : "")).join("")).toContain("**דנה** [x](https://e.com) - 1");
    expect(unfilledDocumentFields(filled, "contact")).toEqual(["{תאריך היום}", "{טלפון}"]);
    // a value that starts a line cannot make a list item, and line breaks become spaces
    expect(markdownLiteral("- א\nב")).toBe("\\- א ב");
  });

  it("the business values and dates", () => {
    expect(dayText("2026-11-09")).toBe("09.11.2026");
    expect(dayText("9.11.2026")).toBeNull();
    expect(
      businessDocumentValues({
        name: "המספרה",
        legalName: null,
        taxId: "515555555",
        addressLine: "הרצל 1",
        city: "חיפה",
        phone: null,
        email: " ",
        userName: "רון",
        today: "2026-11-09",
      }),
    ).toEqual({
      "שם העסק": "המספרה",
      "השם הרשום של העסק": "המספרה",
      "מספר העוסק": "515555555",
      "כתובת העסק": "הרצל 1, חיפה",
      "שם הנציג": "רון",
      "תאריך היום": "09.11.2026",
    });
  });
});
