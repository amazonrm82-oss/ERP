import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { automationMissingText, CARD_MESSAGE_FIELDS, cardFieldsErrorMessage, cardMissingText, cardUnfillableFields } from "@/features/message-templates/card-fields";
import { MERGE_FIELD_NAMES } from "@/features/message-templates/fields";

import fixture from "./fixtures/card-unfillable-fields.json";

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

// the latest migration that defines app.card_message_fields()
function latestFieldsMigration(): string {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const found = files.filter((f) => readFileSync(join(MIGRATIONS, f), "utf8").includes("create or replace function app.card_message_fields()"));
  expect(found.length).toBeGreaterThan(0);
  return readFileSync(join(MIGRATIONS, found[found.length - 1]), "utf8");
}

describe("the fields a card's message fills (EML-02, 15 November 2026)", () => {
  it("is the same closed list as app.card_message_fields(), every one a merge field", () => {
    const sql = latestFieldsMigration();
    const body = sql.slice(sql.indexOf("create or replace function app.card_message_fields()"));
    const list = /array\[([^\]]*)\]::text\[\]/.exec(body)?.[1] ?? "";
    const names = [...list.matchAll(/'([^']*)'/g)].map((m) => m[1]);
    expect(names).toEqual([...CARD_MESSAGE_FIELDS]);
    for (const name of CARD_MESSAGE_FIELDS) expect(MERGE_FIELD_NAMES).toContain(name);
  });

  it.each(fixture.cases.map((c, i) => [i, c] as const))("case %i of the shared fixture", (_i, c) => {
    expect(cardUnfillableFields({ messageType: c.type, subject: c.subject, body: c.body })).toEqual(c.missing);
  });

  it("names the missing fields for the card and for a rule", () => {
    expect(cardMissingText([])).toBeNull();
    expect(cardMissingText(["קישור להצעה", "תוקף"])).toBe("חסר בכרטיס: {קישור להצעה}, {תוקף}");
    expect(automationMissingText(["תוכן העדכון"])).toBe("חסר באוטומציה: {תוכן העדכון}");
  });

  it("words the database's refusal with the fields of its detail, and nothing else", () => {
    expect(cardFieldsErrorMessage({ hint: "record_message:unfillable_field", details: "קישור להצעה, תוקף" })).toBe(
      "התבנית לא תישלח מהכרטיס. חסר בכרטיס: {קישור להצעה}, {תוקף}. בחרו תבנית אחרת, או בקשו מבעלי העסק לתקן אותה.",
    );
    // a detail that is not a list of merge fields is never echoed
    expect(cardFieldsErrorMessage({ hint: "record_message:unfillable_field", detail: "<b>x</b>" })).toMatch(/^בתבנית יש שדה/);
    expect(cardFieldsErrorMessage({ hint: "record_email:not_sendable" })).toBeNull();
    expect(cardFieldsErrorMessage(null)).toBeNull();
  });
});

describe("where the fields rule shows", () => {
  it("the card's list says why a message was not sent", async () => {
    const { queuedEmailStateText, queuedEmails } = await import("@/features/record-email/logic");
    const { queuedSmsStateText } = await import("@/features/record-sms/logic");
    expect(queuedEmailStateText({ state: "not_sent", reason: "unfilled" })).toBe("לא נשלח: בתבנית יש שדה בלי ערך");
    expect(queuedSmsStateText({ state: "not_sent", reason: "unfilled" })).toBe("לא נשלח: בתבנית יש שדה בלי ערך");
    expect(queuedEmails([{ job_id: "j", created_at: "2026-11-15T10:00:00Z", state: "not_sent", reason: "unfilled" }])[0].reason).toBe("unfilled");
  });

  it("an automation's step refuses a template it cannot fill, and keeps one it can", async () => {
    const { sendEmailAction } = await import("@/features/automations/send-email");
    const { sendSmsAction } = await import("@/features/automations/send-sms");
    const id = "11111111-1111-4111-8111-111111111111";
    const bad = [{ id, name: "הצעה", messageType: "requested_document", isActive: true, missing: ["קישור להצעה"] }];
    const good = [{ id, name: "הצעה", messageType: "requested_document", isActive: true, missing: [] }];
    expect(sendEmailAction("contact", { template_id: id }, { emailTemplates: bad })).toContain("חסר באוטומציה: {קישור להצעה}");
    expect(sendEmailAction("contact", { template_id: id }, { emailTemplates: good })).toEqual({ type: "send_email", template_id: id });
    expect(sendSmsAction("lead", { template_id: id }, { sms: true, smsTemplates: bad })).toContain("חסר באוטומציה");
    expect(sendSmsAction("lead", { template_id: id }, { sms: true, smsTemplates: good })).toEqual({ type: "send_sms", template_id: id });
  });
});

describe("the card's send dialog (owner, 15 November 2026)", () => {
  it("offers only the templates the card fills and counts the others", async () => {
    const { splitCardTemplates, hiddenTemplatesText } = await import("@/features/message-templates/card-fields");
    const templates = [
      { id: "a", messageType: "requested_document", subject: "הצעה", body: "{קישור להצעה}" },
      { id: "b", messageType: "marketing", subject: "עדכון", body: "שלום {שם פרטי}" },
      { id: "c", messageType: "marketing", subject: null, body: "{תוכן העדכון}" },
    ];
    const { offered, hidden } = splitCardTemplates(templates);
    expect(offered.map((t) => t.id)).toEqual(["b"]);
    expect(hidden).toBe(2);
    expect(hiddenTemplatesText(2)).toBe("2 תבניות לא מוצגות כי יש בהן שדות שהכרטיס לא ממלא.");
    expect(hiddenTemplatesText(1)).toBe("תבנית אחת לא מוצגת כי יש בה שדות שהכרטיס לא ממלא.");
    expect(hiddenTemplatesText(0)).toBeNull();
  });

  it("warns before a marketing send while the envelope's business address or phone is missing", async () => {
    const { marketingEnvelopeMissing, marketingEnvelopeMissingText } = await import("@/features/message-sending/marketing-details");
    expect(marketingEnvelopeMissing({ businessPhone: "03-1", businessAddress: "הרצל 1" })).toEqual([]);
    expect(marketingEnvelopeMissing({ businessPhone: " ", businessAddress: null })).toEqual(["address", "phone"]);
    expect(marketingEnvelopeMissingText(["address"])).toMatch(/^חסרים כתובת או טלפון העסק בהגדרות המסמכים \(חסר: כתובת\)/);
    expect(marketingEnvelopeMissingText([])).toBeNull();
  });
});
