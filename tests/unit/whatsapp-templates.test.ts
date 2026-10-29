import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { mentionIds } from "@/features/mentions/token";
import { sentMessageSchema, templateSchema } from "@/features/whatsapp/schema";
import { COLLECTION_REMINDER_TEXT } from "@/features/collection/reminders";
import {
  COLLECTION_REMINDER_KIND,
  DEFAULT_TEMPLATES,
  fillTemplate,
  firstNameOf,
  MEETING_REMINDER_KIND,
  MESSAGE_MAX,
  missingPlaceholders,
  nextPosition,
  plainMentions,
  recordTemplateValues,
  whatsappMessageUrl,
} from "@/features/whatsapp/templates";

describe("WhatsApp templates (WA-01)", () => {
  it("fills the known placeholders that have a value and leaves the rest", () => {
    const text = "שלום {שם פרטי} ({שם מלא}), כאן {שם הנציג} מ{שם העסק}. נתראה {תאריך} ב-{שעה}. {משהו אחר}";
    expect(fillTemplate(text, { firstName: "דנה", fullName: "דנה כהן", userName: "יוסי", businessName: "מספרת שירה", date: "", time: null })).toBe(
      "שלום דנה (דנה כהן), כאן יוסי ממספרת שירה. נתראה {תאריך} ב-{שעה}. {משהו אחר}",
    );
    expect(fillTemplate("{שם פרטי} {שם פרטי}", { firstName: "דנה" })).toBe("דנה דנה");
  });

  it("does not read a value as a placeholder again", () => {
    expect(fillTemplate("{שם פרטי} {שם העסק}", { firstName: "{שם העסק}", businessName: "העסק" })).toBe("{שם העסק} העסק");
  });

  it("lists what is still to complete, each once, and only known placeholders", () => {
    expect(missingPlaceholders("{תאריך} {שעה} {תאריך} {לא ידוע}")).toEqual(["{תאריך}", "{שעה}"]);
    expect(missingPlaceholders("שלום")).toEqual([]);
  });

  it("first names and record values", () => {
    expect(firstNameOf("  דנה   כהן ")).toBe("דנה");
    expect(firstNameOf("")).toBeNull();
    expect(firstNameOf(null)).toBeNull();
    const context = { user: { displayName: "יוסי לוי" }, org: { name: "העסק שלי" } };
    expect(recordTemplateValues({ fullName: "דנה כהן" }, context)).toEqual({
      firstName: "דנה",
      fullName: "דנה כהן",
      userName: "יוסי לוי",
      businessName: "העסק שלי",
    });
    expect(recordTemplateValues({ firstName: "דני", fullName: "דניאל כהן" }, context).firstName).toBe("דני");
  });

  it("builds the wa.me link from the E.164 number, with the text encoded", () => {
    expect(whatsappMessageUrl("+972501234567", "שלום & ביי?")).toBe(`https://wa.me/972501234567?text=${encodeURIComponent("שלום & ביי?")}`);
    expect(whatsappMessageUrl("+972501234567", "  ")).toBe("https://wa.me/972501234567");
    expect(whatsappMessageUrl(null, "x")).toBeNull();
    expect(whatsappMessageUrl("+12", "x")).toBeNull();
  });

  it("checks a template and a sent message", () => {
    expect(templateSchema.safeParse({ name: " תזכורת ", body: "שורה\r\nשנייה " }).data).toEqual({ name: "תזכורת", body: "שורה\nשנייה" });
    expect(templateSchema.safeParse({ name: "", body: "x" }).success).toBe(false);
    expect(templateSchema.safeParse({ name: "x", body: "x".repeat(1001) }).success).toBe(false);
    expect(sentMessageSchema.safeParse({ text: "x".repeat(MESSAGE_MAX), templateId: null }).success).toBe(true);
    expect(sentMessageSchema.safeParse({ text: "x".repeat(MESSAGE_MAX + 1), templateId: null }).success).toBe(false);
    expect(sentMessageSchema.safeParse({ text: "x", templateId: "not-an-id" }).success).toBe(false);
  });

  it("the defaults equal the latest seed of the migrations, with one meeting reminder and one collection reminder", () => {
    const dir = path.join(process.cwd(), "supabase/migrations");
    // the latest migration that defines app.seed_whatsapp_templates (COL-04 added the collection reminder)
    const file = readdirSync(dir)
      .filter((name) => name.endsWith(".sql") && readFileSync(path.join(dir, name), "utf8").includes("function app.seed_whatsapp_templates("))
      .sort()
      .at(-1);
    expect(file).toBeDefined();
    const sql = readFileSync(path.join(dir, file!), "utf8");
    const rows = [...sql.matchAll(/\((\d+), '([^']+)',\s*'([^']+)', (null(?:::text)?|'[a-z_]+')\)/g)].map((m) => ({
      name: m[2],
      body: m[3],
      kind: m[4].startsWith("null") ? null : m[4].slice(1, -1),
    }));
    expect(rows).toEqual(DEFAULT_TEMPLATES.map((t) => ({ name: t.name, body: t.body, kind: t.kind })));
    expect(DEFAULT_TEMPLATES.filter((t) => t.kind === MEETING_REMINDER_KIND)).toHaveLength(1);
    expect(DEFAULT_TEMPLATES.filter((t) => t.kind === COLLECTION_REMINDER_KIND)).toHaveLength(1);
    expect(DEFAULT_TEMPLATES.find((t) => t.kind === COLLECTION_REMINDER_KIND)?.body).toBe(COLLECTION_REMINDER_TEXT);
    for (const template of DEFAULT_TEMPLATES) {
      expect(templateSchema.safeParse({ name: template.name, body: template.body }).success).toBe(true);
    }
  });
});

describe("logged WhatsApp messages carry no mentions (WA-01)", () => {
  const id = "0b6f6a2e-1c1d-4c4e-9a7b-3f2d1e0c9b8a";

  it("turns every mention token into plain @Name", () => {
    expect(plainMentions(`שלום @[דנה כהן](user:${id}) ו-@[יוסי](user:${id.toUpperCase()})`)).toBe("שלום @דנה כהן ו-@יוסי");
    expect(mentionIds(plainMentions(`@[a](user:${id})`))).toEqual([]);
  });

  it("leaves other text alone, and leaves no token behind even when stripping builds a new one", () => {
    expect(plainMentions("@[לא](mailto:x) [קישור](https://example.com) @שם")).toBe("@[לא](mailto:x) [קישור](https://example.com) @שם");
    const nested = `@[@[x](user:${id})](user:${id})`;
    expect(mentionIds(plainMentions(nested))).toEqual([]);
  });

  it("a new template goes after the highest position", () => {
    expect(nextPosition([])).toBe(0);
    expect(nextPosition([{ position: 0 }, { position: 5 }, { position: 2 }])).toBe(6);
  });
});
