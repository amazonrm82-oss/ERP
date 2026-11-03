import { describe, expect, it } from "vitest";

import { fillMessage, MERGE_FIELD_NAMES, MERGE_FIELD_PATTERN, unfilledMergeFields, unknownMergeFields } from "@/features/message-templates/fields";
import { messageTemplateSchema } from "@/features/message-templates/schema";
import { DEFAULT_MESSAGE_TEMPLATES, isServiceType, smsLengthWarning, smsLimit, TEMPLATE_LOCALES } from "@/features/message-templates/templates";
import { PLACEHOLDERS } from "@/features/whatsapp/templates";
import { MESSAGE_TYPES, SERVICE_MESSAGE_TYPES } from "@/features/messaging/providers/types";

import { latestMigration } from "./helpers/migrations";

const migration = latestMigration("create table if not exists public.message_templates");
const sql = migration?.sql ?? "";

/** The SQL string concatenations with chr(10) of the seed, read back as one text each. */
function seedTexts(text: string): string {
  return text.replace(/'\s*((?:\|\|\s*chr\(10\)\s*)+)\|\|\s*'/g, (_all, chrs: string) => "\n".repeat((chrs.match(/chr\(10\)/g) ?? []).length));
}

describe("message templates (MSG-02)", () => {
  it("the merge fields equal app.message_merge_fields() and keep WA-01's placeholders", () => {
    expect(migration).toBeDefined();
    const fieldsSql = latestMigration("create or replace function app.message_merge_fields()")?.sql ?? "";
    const list = fieldsSql.match(/app\.message_merge_fields\(\) returns text\[\][\s\S]*?select array\[([^\]]*)\]/);
    expect(list).not.toBeNull();
    const names = [...(list?.[1] ?? "").matchAll(/'([^']*)'/g)].map((m) => m[1]);
    expect(names).toEqual([...MERGE_FIELD_NAMES]);
    for (const placeholder of Object.values(PLACEHOLDERS)) expect(MERGE_FIELD_NAMES).toContain(placeholder.token.slice(1, -1));
  });

  it("the field pattern equals the database's", () => {
    expect(sql).toContain(`'${MERGE_FIELD_PATTERN.source}'`);
  });

  it("the closed lists equal the table's checks", () => {
    expect(sql).toContain(`message_type in (${MESSAGE_TYPES.map((t) => `'${t}'`).join(", ")})`);
    expect(sql).toContain(`locale in (${TEMPLATE_LOCALES.map((t) => `'${t}'`).join(", ")})`);
    expect(MESSAGE_TYPES.filter(isServiceType)).toEqual([...SERVICE_MESSAGE_TYPES]);
  });

  it("the defaults equal the seed", () => {
    const seed = seedTexts(sql.slice(sql.indexOf("create or replace function app.seed_message_templates")));
    for (const d of DEFAULT_MESSAGE_TEMPLATES) {
      expect(seed, d.name).toContain(`'${d.name}', '${d.channel}', '${d.messageType}', ${d.subject === null ? "null::text" : `'${d.subject}'`},`);
      expect(seed, d.name).toContain(`'${d.body}'`);
      expect(unknownMergeFields(`${d.subject ?? ""} ${d.body}`), d.name).toEqual([]);
    }
  });

  it("finds unknown fields, never a gender block", () => {
    expect(unknownMergeFields("שלום {שם פרטי} {כתובת} {כתובת} {abc}")).toEqual(["{כתובת}", "{abc}"]);
    expect(unknownMergeFields("{זכר: אתה | נקבה: את | ניטרלי: {שם פרטי}}")).toEqual([]);
    expect(unknownMergeFields("{" + "א".repeat(31) + "}")).toEqual([]);
  });

  it("fills by gender and leaves fields without a value", () => {
    const text = "{זכר: שלום | נקבה: שלום לך | ניטרלי: היי} {שם פרטי}, ההצעה: {קישור להצעה}. {שם העסק}";
    expect(
      fillMessage(text, {
        firstName: "דנה",
        gender: "female",
        businessName: "העסק",
      }),
    ).toBe("שלום לך דנה, ההצעה: {קישור להצעה}. העסק");
    expect(fillMessage(text, { firstName: "דן" })).toBe("היי דן, ההצעה: {קישור להצעה}. {שם העסק}");
    expect(unfilledMergeFields("{קישור להצעה} {שם העסק} {קישור להצעה} {אחר}")).toEqual(["{קישור להצעה}", "{שם העסק}"]);
  });

  it("warns about a long SMS by its alphabet", () => {
    expect(smsLimit("hello")).toBe(160);
    expect(smsLimit("שלום")).toBe(70);
    expect(smsLengthWarning("א".repeat(70))).toBeNull();
    expect(smsLengthWarning("א".repeat(71))).toContain("2 הודעות");
    expect(smsLengthWarning("a".repeat(160))).toBeNull();
    expect(smsLengthWarning("a".repeat(161))).toContain("2 הודעות");
  });

  it("the form rules: subject for email only, known fields, closed lists", () => {
    const base = {
      name: "x",
      channel: "sms",
      message_type: "collection",
      subject: "ignored",
      body: "שלום {שם פרטי}",
      locale: "he",
      is_active: "on",
    };
    const sms = messageTemplateSchema.safeParse(base);
    expect(sms.success && sms.data).toMatchObject({
      subject: null,
      is_active: true,
    });
    expect(
      messageTemplateSchema.safeParse({
        ...base,
        channel: "email",
        subject: "",
      }).success,
    ).toBe(false);
    const email = messageTemplateSchema.safeParse({
      ...base,
      channel: "email",
      subject: "מ{שם העסק}",
      is_active: null,
    });
    expect(email.success && email.data).toMatchObject({
      subject: "מ{שם העסק}",
      is_active: false,
    });
    expect(
      messageTemplateSchema.safeParse({
        ...base,
        channel: "email",
        subject: "{כתובת}",
      }).success,
    ).toBe(false);
    expect(messageTemplateSchema.safeParse({ ...base, body: "{כתובת}" }).success).toBe(false);
    expect(messageTemplateSchema.safeParse({ ...base, body: "{זכר: א}" }).success).toBe(false);
    expect(messageTemplateSchema.safeParse({ ...base, message_type: "promo" }).success).toBe(false);
    expect(messageTemplateSchema.safeParse({ ...base, locale: "de" }).success).toBe(false);
    expect(messageTemplateSchema.safeParse({ ...base, body: "a\r\nb" }).data?.body).toBe("a\nb");
    // review finding 3: no control characters in the name or the subject (the body keeps its line breaks)
    expect(messageTemplateSchema.safeParse({ ...base, channel: "email", subject: "a\r\nBcc: x@y" }).success).toBe(false);
    expect(messageTemplateSchema.safeParse({ ...base, channel: "email", subject: "a\u0085b" }).success).toBe(false);
    expect(messageTemplateSchema.safeParse({ ...base, name: "שם\tשני" }).success).toBe(false);
    expect(messageTemplateSchema.safeParse({ ...base, body: "שורה\nשורה" }).success).toBe(true);
  });
});
