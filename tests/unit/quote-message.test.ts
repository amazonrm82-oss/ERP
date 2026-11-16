import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MERGE_FIELD_NAMES } from "@/features/message-templates/fields";
import {
  QUOTE_MESSAGE_FIELDS,
  quoteDocumentName,
  quoteMessagePreview,
  quoteMessageTemplates,
  quoteUnfillableFields,
  queuedQuoteMessages,
  queuedQuoteMessageText,
} from "@/features/quote-message/logic";
import { DEFAULT_QUOTE_REMINDER_TEMPLATES, quoteCustomerReminderOf, quoteReminderSchema } from "@/features/quote-message/reminders";

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

function latest(marker: string): string {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => readFileSync(join(MIGRATIONS, f), "utf8").includes(marker));
  expect(files.length).toBeGreaterThan(0);
  return readFileSync(join(MIGRATIONS, files[files.length - 1]), "utf8");
}

const tpl = (over: Partial<{ channel: string; messageType: string; body: string; subject: string | null; isActive: boolean; noticeKind: string | null }>) => ({
  id: "t",
  name: "t",
  channel: "email",
  messageType: "requested_document",
  subject: "הצעת המחיר מ{שם העסק}",
  body: "שלום {שם פרטי}, {קישור להצעה} עד {תוקף}",
  isActive: true,
  noticeKind: null,
  ...over,
});

describe("sending a quote to its customer (QUO-18)", () => {
  it("fills the same closed list as app.quote_message_fields(), every one a merge field", () => {
    const sql = latest("create or replace function app.quote_message_fields()");
    const body = sql.slice(sql.indexOf("create or replace function app.quote_message_fields()"));
    const names = [...(/array\[([^\]]*)\]::text\[\]/.exec(body)?.[1] ?? "").matchAll(/'([^']*)'/g)].map((m) => m[1]);
    expect(names).toEqual([...QUOTE_MESSAGE_FIELDS]);
    for (const name of QUOTE_MESSAGE_FIELDS) expect(MERGE_FIELD_NAMES).toContain(name);
  });

  it("offers only active requested_document templates of the channel that a quote send fills", () => {
    const ok = tpl({});
    const list = [
      ok,
      tpl({ channel: "sms", subject: null }),
      tpl({ messageType: "marketing" }),
      tpl({ isActive: false }),
      tpl({ noticeKind: "quote_reminder" }),
      tpl({ body: "שלום {תוכן העדכון}" }),
    ];
    expect(quoteMessageTemplates(list, "email", true)).toEqual([ok]);
    expect(quoteMessageTemplates(list, "email", false)).toEqual([]);
    expect(quoteMessageTemplates([tpl({ body: "שלום {שם פרטי}: {קישור להצעה}" })], "email", false)).toHaveLength(1);
    // review F5: an optional part with {תוקף} goes on a quote without validity too
    expect(quoteMessageTemplates([tpl({ body: "שלום: {קישור להצעה}{ בתוקף עד {תוקף}}" })], "email", false)).toHaveLength(1);
    expect(quoteUnfillableFields(tpl({ body: "{מסמך} {קישור להצעה} {תוקף} {שעה}" }))).toEqual(["שעה"]);
  });

  it("names the document, previews with a placeholder link, and reads the queue", () => {
    expect(quoteDocumentName("1007")).toBe("הצעת מחיר 1007");
    expect(quoteDocumentName(null)).toBe("הצעת מחיר");
    const preview = quoteMessagePreview(tpl({}), { firstName: "דנה", businessName: "העסק", validUntil: "30 בנובמבר 2026" });
    expect(preview.subject).toBe("הצעת המחיר מהעסק");
    expect(preview.body).toBe("שלום דנה, [הקישור להצעה] עד 30 בנובמבר 2026");
    const rows = queuedQuoteMessages([
      { job_id: "j", created_at: "2026-11-16T10:00:00Z", channel: "sms", state: "not_sent", reason: "quote_changed" },
      { job_id: "k", created_at: "x", channel: "fax", state: "sent" },
      "junk",
    ]);
    expect(rows).toHaveLength(1);
    expect(queuedQuoteMessageText(rows[0])).toBe("לא נשלחה: ההצעה או הלקוח שלה השתנו לפני השליחה");
  });
});

describe("automatic quote reminders (QUO-18, owner (381)-(384))", () => {
  it("seeds the same DRAFT templates as app.seed_quote_reminder_templates", () => {
    const sql = latest("create or replace function app.seed_quote_reminder_templates(");
    const body = sql.slice(sql.indexOf("create or replace function app.seed_quote_reminder_templates("));
    for (const t of DEFAULT_QUOTE_REMINDER_TEMPLATES) {
      expect(body).toContain(`'${t.name}', '${t.channel}'`);
      if (t.subject) expect(body).toContain(`'${t.subject}'`);
      for (const line of t.body.split("\n").filter((l) => l !== "")) expect(body, line).toContain(line);
    }
    expect(body).toContain("'quote-reminder-draft-1'");
  });

  it("is off unless switched on", () => {
    expect(quoteCustomerReminderOf(true)).toBe(true);
    for (const v of [false, null, undefined, "true"]) expect(quoteCustomerReminderOf(v)).toBe(false);
    expect(quoteReminderSchema.parse({ quote_customer_reminder: "on" })).toEqual({ quote_customer_reminder: true });
    expect(quoteReminderSchema.parse({})).toEqual({ quote_customer_reminder: false });
  });
});
