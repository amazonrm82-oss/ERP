import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { MERGE_FIELD_NAMES, unknownMergeFields } from "@/features/message-templates/fields";
import { MESSAGE_MERGE_FIELDS } from "@/features/message-templates/fields";
import { editedTemplateProblemText, messageTemplateProblem, NOTICE_KIND_FIELDS, SERVICE_BODY_MAX, SERVICE_TYPE_FIELDS } from "@/features/message-templates/service-rule";
import { cardEmailTemplates } from "@/features/record-email/logic";
import { cardSmsTemplates } from "@/features/record-sms/logic";
import { dbErrorMessage } from "@/lib/errors";
import { DEFAULT_SIGNATURE_REMINDER_TEMPLATES, SIGNATURE_REMINDER_WORDING_VERSION } from "@/features/message-templates/templates";
import { NOTIFICATION_KINDS } from "@/features/notifications/settings";
import { signatureDayText } from "@/features/signatures/public";
import {
  SIGNATURE_REMINDER_CHOICES,
  SIGNATURE_REMINDER_DEFAULT,
  SIGNATURE_REMINDER_MAX,
  SIGNATURE_REMINDERS_MAX,
  signatureCustomerReminderOf,
  signatureReminderDaysOf,
  signatureReminderLabel,
  signatureReminderSchema,
} from "@/features/signatures/reminder";
import { signatureDatesLine } from "@/features/signatures/states";

const migration = readFileSync(path.join(process.cwd(), "supabase/migrations/20261006021218_signature_status_reminders.sql"), "utf8");

describe("SGN-03 signature states and reminders", () => {
  const fmt = (iso: string) => iso.slice(0, 10);
  const day = (iso: string) => `יום ${iso.slice(8, 10)}`;
  const doc = { sentAt: "2026-11-01T10:00:00Z", viewedAt: null, signedAt: null, cancelledAt: null, expiresAt: null };

  it("writes the dates of the states on one line; the last day as a day", () => {
    expect(signatureDatesLine(doc, "sent", fmt)).toBe("נשלח ב-2026-11-01");
    expect(signatureDatesLine({ ...doc, viewedAt: "2026-11-02T10:00:00Z", expiresAt: "2026-11-11T21:59:59Z" }, "viewed", fmt, day)).toBe(
      "נשלח ב-2026-11-01 · נצפה ב-2026-11-02 · בתוקף עד יום 11",
    );
    expect(signatureDatesLine({ ...doc, expiresAt: "2026-11-05T10:00:00Z" }, "expired", fmt, day)).toBe("נשלח ב-2026-11-01 · פג ב-יום 05");
    expect(signatureDatesLine({ ...doc, signedAt: "2026-11-03T10:00:00Z", expiresAt: "2026-11-05T10:00:00Z" }, "signed", fmt)).toBe("נשלח ב-2026-11-01 · נחתם ב-2026-11-03");
    expect(signatureDatesLine({ ...doc, cancelledAt: "2026-11-03T10:00:00Z" }, "cancelled", fmt)).toBe("נשלח ב-2026-11-01 · בוטל ב-2026-11-03");
  });

  it("(247) ב: the last day is shown in the business zone without a time", () => {
    // 23:59:59.999 in Jerusalem on 15 November
    expect(signatureDayText("2026-11-15T21:59:59.999Z", "Asia/Jerusalem")).toBe("15 בנובמבר");
    expect(signatureDayText("2026-11-15T21:59:59.999Z", "Not/AZone")).toBe("15 בנובמבר");
    // review L7: a document sent before 021218 ends at another moment: the day and the time
    expect(signatureDayText("2026-11-15T12:30:00Z", "Asia/Jerusalem")).toBe("15 בנובמבר, 14:30");
    expect(signatureDayText("x", "Asia/Jerusalem")).toBe("");
    expect(migration).toContain("- interval '1 millisecond'");
  });

  it("the settings mirror the database: an interval of 0..30 business days, default 3, at most 3 reminders; the customer's on by default", () => {
    expect(migration).toContain("signature_reminder_days smallint not null default 3");
    expect(migration).toContain("check (signature_reminder_days between 0 and 30)");
    expect(migration).toContain("signature_customer_reminder boolean not null default true");
    expect(migration).toContain("reminders between 0 and 3");
    expect(SIGNATURE_REMINDERS_MAX).toBe(3);
    expect(SIGNATURE_REMINDER_DEFAULT).toBe(3);
    expect(SIGNATURE_REMINDER_MAX).toBe(30);
    expect(SIGNATURE_REMINDER_CHOICES).toContain(SIGNATURE_REMINDER_DEFAULT);
    expect(SIGNATURE_REMINDER_CHOICES.every((n) => n >= 0 && n <= SIGNATURE_REMINDER_MAX)).toBe(true);
    expect(signatureReminderDaysOf(undefined)).toBe(3);
    expect(signatureReminderDaysOf(0)).toBe(0);
    expect(signatureReminderDaysOf(31)).toBe(3);
    expect(signatureCustomerReminderOf(undefined)).toBe(true);
    expect(signatureCustomerReminderOf(false)).toBe(false);
    expect(signatureReminderSchema.safeParse({ signature_reminder_days: "7", signature_customer_reminder: "on" }).data).toEqual({
      signature_reminder_days: 7,
      signature_customer_reminder: true,
    });
    expect(signatureReminderSchema.safeParse({ signature_reminder_days: "7", signature_customer_reminder: null }).data?.signature_customer_reminder).toBe(false);
    expect(signatureReminderSchema.safeParse({ signature_reminder_days: "31" }).success).toBe(false);
    expect(signatureReminderSchema.safeParse({ signature_reminder_days: "x" }).success).toBe(false);
    expect(signatureReminderLabel(0)).toBe("בלי תזכורת");
    expect(signatureReminderLabel(1)).toBe("כל יום עבודה");
    expect(signatureReminderLabel(5)).toBe("כל 5 ימי עבודה");
  });

  it("(248) ב: the reminder's own notification kind, mutable", () => {
    expect(NOTIFICATION_KINDS.find((k) => k.key === "signature_reminder")).toMatchObject({ shown: true });
  });

  it("(249) א: the two DRAFT templates equal their seed and pass the service rule", () => {
    expect(migration).toContain(`'${SIGNATURE_REMINDER_WORDING_VERSION}'`);
    for (const d of DEFAULT_SIGNATURE_REMINDER_TEMPLATES) {
      expect(migration, d.name).toContain(`'${d.name}', '${d.channel}', ${d.subject === null ? "null::text" : `'${d.subject}'`},`);
      expect(migration, d.name).toContain(`'${d.body}'`);
      expect(unknownMergeFields(`${d.subject ?? ""} ${d.body}`), d.name).toEqual([]);
      expect(messageTemplateProblem({ channel: d.channel, messageType: d.messageType, subject: d.subject, body: d.body, noticeKind: d.noticeKind }), d.name).toBeNull();
      // review M1: the same text without the mark is a person's template, which may not hold the document's fields
      expect(messageTemplateProblem({ channel: d.channel, messageType: d.messageType, subject: d.subject, body: d.body }), d.name).toBe("field_not_allowed");
      if (d.channel === "sms") expect([...d.body].length).toBeLessThanOrEqual(SERVICE_BODY_MAX.sms);
    }
    expect(MERGE_FIELD_NAMES).toContain("שם המסמך");
    expect(SERVICE_TYPE_FIELDS.requested_document).not.toContain("documentName");
    expect(SERVICE_TYPE_FIELDS.requested_document).not.toContain("manageLink");
  });

  it("review M1: the mark's extra fields equal app.message_notice_fields; the system's templates are on no card", () => {
    const match = migration.match(/p_type = 'requested_document' and p_notice_kind = 'signature_reminder' then array\[([^\]]*)\]/);
    expect(match).not.toBeNull();
    const names = [...(match?.[1] ?? "").matchAll(/'([^']*)'/g)].map((m) => m[1]);
    expect(names).toEqual((NOTICE_KIND_FIELDS.requested_document?.signature_reminder ?? []).map((key) => MESSAGE_MERGE_FIELDS[key].token.slice(1, -1)));
    const base = { name: "t", subject: null, body: "שלום", isActive: true, messageType: "requested_document" as const };
    const own = { ...base, id: "a", channel: "sms", noticeKind: null };
    const system = { ...base, id: "b", channel: "sms", noticeKind: "signature_reminder" };
    expect(cardSmsTemplates([own, system], true).map((t) => t.id)).toEqual(["a"]);
    expect(cardEmailTemplates([{ ...own, channel: "email" }, { ...system, channel: "email" }], true).map((t) => t.id)).toEqual(["a"]);
    expect(dbErrorMessage({ code: "P0001", message: "x", hint: "record_message:notice_template" })).toContain("המערכת שולחת לבד");
    // delta review D1: the editor and the save judge a seeded system template with its own mark
    for (const d of DEFAULT_SIGNATURE_REMINDER_TEMPLATES) {
      const values = { channel: d.channel, messageType: d.messageType, subject: d.subject, body: d.body };
      expect(editedTemplateProblemText(values, d.noticeKind, { ownDomain: null, businessEmail: null }), d.name).toBeNull();
      expect(editedTemplateProblemText(values, null, {}), d.name).toContain("התבנית לא תישלח");
    }
  });
});
