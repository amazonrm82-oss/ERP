import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { auditEntryNote } from "@/features/audit/condition-removal";
import { ACTION_LABELS } from "@/features/audit/labels";
import type { ClaimedJob } from "@/features/jobs/registry";
import { clearFakeSentMessages, createFakeProvider, fakeSentMessages } from "@/features/messaging/providers/fake";
import { createSendHandler, recordEmailParts } from "@/features/messaging/send-handler";
import {
  CARD_SERVICE_TYPES,
  cardEmailTemplates,
  emailPreview,
  fileSelectionProblem,
  queuedEmails,
  queuedEmailStateText,
  queuedMessage,
  RECORD_EMAIL_MAX_BYTES,
  RECORD_EMAIL_MAX_FILES,
} from "@/features/record-email/logic";
import { dbErrorMessage } from "@/lib/errors";

const root = join(__dirname, "..", "..");
const migration = (() => {
  const dir = join(root, "supabase", "migrations");
  const file = readdirSync(dir).find((f) => f.endsWith("_record_email.sql"));
  if (!file) throw new Error("record_email migration missing");
  return readFileSync(join(dir, file), "utf8");
})();

// EML-02 (198) ב: the follow-up that redefines app.record_email_enqueue (library files with a service template, the audit entry)
const followUp = (() => {
  const dir = join(root, "supabase", "migrations");
  const file = readdirSync(dir).find((f) => f.endsWith("_record_email_library_service.sql"));
  if (!file) throw new Error("record_email_library_service migration missing");
  return readFileSync(join(dir, file), "utf8");
})();

const id = (n: number) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;
const template = (over: Partial<Parameters<typeof cardEmailTemplates>[0][number]> = {}) => ({
  id: id(1),
  name: "מסמך",
  channel: "email",
  messageType: "requested_document" as const,
  subject: "המסמך שביקשת",
  body: "שלום {שם פרטי}",
  isActive: true,
  ...over,
});

describe("EML-02: the dialog's rules equal the database's", () => {
  it("the limits and the card's service types are the migration's", () => {
    expect(migration).toMatch(new RegExp(`app\\.record_email_max_files\\(\\)[\\s\\S]*?select ${RECORD_EMAIL_MAX_FILES} \\$\\$`));
    expect(migration).toMatch(new RegExp(`app\\.record_email_max_bytes\\(\\)[\\s\\S]*?select ${RECORD_EMAIL_MAX_BYTES}::bigint`));
    const types = migration.match(/app\.record_email_service_types\(\)[\s\S]*?array\[([^\]]*)\]/);
    expect(types?.[1].split(",").map((t) => t.trim().replace(/'/g, ""))).toEqual([...CARD_SERVICE_TYPES]);
    expect(migration).toMatch(/jsonb_array_length\(p_payload -> 'file_ids'\) between 1 and 5/);
  });

  it("every P0001 hint the migration raises has its own Hebrew message", () => {
    const hints = new Set([...`${migration}\n${followUp}`.matchAll(/errcode = 'P0001', hint = '(record_email:[a-z_]+)'/g)].map((m) => m[1]));
    expect(hints.size).toBeGreaterThan(8);
    // (198) ב: the interim marketing-only refusal is gone; library files are refused only while an automation runs
    expect(followUp).not.toContain("hint = 'record_email:library_service'");
    expect(hints.has("record_email:library_automation")).toBe(true);
    for (const hint of hints) expect(dbErrorMessage({ code: "P0001", hint, message: "" }, "FALLBACK"), hint).not.toBe("FALLBACK");
  });

  it("offers active email templates of marketing or a card's service type only", () => {
    const list = [
      template({ id: id(1) }),
      template({ id: id(2), channel: "sms" }),
      template({ id: id(3), isActive: false }),
      template({ id: id(4), messageType: "meeting_reminder" }),
      template({ id: id(5), messageType: "verification_code" }),
      template({ id: id(6), messageType: "punch_card_notice" }),
      template({ id: id(7), messageType: "marketing" }),
      template({ id: id(8), messageType: "collection" }),
    ];
    // (194) א: collection only for whoever records payments
    expect(cardEmailTemplates(list, true).map((t) => t.id)).toEqual([id(1), id(7), id(8)]);
    expect(cardEmailTemplates(list, false).map((t) => t.id)).toEqual([id(1), id(7)]);
  });

  it("files: at most 5, all of the record, 10 MB together; a repeat counts once", () => {
    const files = Array.from({ length: 7 }, (_, i) => ({ id: id(i + 1), name: `f${i}.pdf`, sizeBytes: 1000 }));
    expect(fileSelectionProblem(files, [])).toBeNull();
    expect(fileSelectionProblem(files, files.slice(0, 5).map((f) => f.id))).toBeNull();
    expect(fileSelectionProblem(files, [id(1), id(1)])).toBeNull();
    expect(fileSelectionProblem(files, files.slice(0, 6).map((f) => f.id))).toMatch(/עד 5/);
    expect(fileSelectionProblem(files, [id(9)])).toMatch(/רעננו/);
    const big = [
      { id: id(1), name: "a", sizeBytes: 6_000_000 },
      { id: id(2), name: "b", sizeBytes: 6_000_000 },
    ];
    expect(fileSelectionProblem(big, [id(1)])).toBeNull();
    expect(fileSelectionProblem(big, [id(1), id(2)])).toMatch(/10MB/);
    // (197) ב: library files count with the record's, by the item's id
    const library = [
      { id: id(8), name: "מצגת", sizeBytes: 5_000_000 },
      { id: id(9), name: "קטלוג", sizeBytes: 100 },
    ];
    expect(fileSelectionProblem(files, files.slice(0, 3).map((f) => f.id), library, [id(8), id(9)])).toBeNull();
    expect(fileSelectionProblem(files, files.slice(0, 4).map((f) => f.id), library, [id(8), id(9)])).toMatch(/עד 5/);
    expect(fileSelectionProblem(files, [], library, [id(7)])).toMatch(/מהספרייה/);
    expect(fileSelectionProblem(big, [id(1)], library, [id(8)])).toMatch(/10MB/);
    expect(fileSelectionProblem(big, [], library, [id(8), id(8)])).toBeNull();
  });

  it("the preview fills the record's values; marketing gets the envelope; an unknown value stays", () => {
    const service = emailPreview(template({ body: "שלום {שם פרטי}, {תאריך}" }), { firstName: "דנה" });
    expect(service).toEqual({ subject: "המסמך שביקשת", body: "שלום דנה, {תאריך}", unfilled: ["{תאריך}"], marketing: false });
    const marketing = emailPreview(template({ messageType: "marketing", subject: "חדש", body: "שלום {שם פרטי}" }), {
      firstName: "דנה",
      businessName: "העסק",
    });
    expect(marketing.subject).toBe("פרסומת: חדש");
    expect(marketing.body).toContain("שלום דנה");
    expect(marketing.body).toContain("העסק");
    expect(marketing.marketing).toBe(true);
    // HEB-01: the gender block by the record's gender
    expect(emailPreview(template({ body: "{זכר: שלום לך אחי | נקבה: שלום לך אחותי | ניטרלי: שלום לך}" }), { gender: "female" }).body).toBe(
      "שלום לך אחותי",
    );
  });

  it("parses the card's list and says each state in plain words", () => {
    const rows = queuedEmails([
      { job_id: id(1), created_at: "2026-11-09T10:00:00Z", template_name: "מסמך", sender_id: id(2), files: 2, state: "waiting", reason: null },
      { job_id: id(3), created_at: "2026-11-09T10:00:00Z", template_name: null, sender_id: null, files: 0, state: "not_sent", reason: "consent" },
      { job_id: id(4), created_at: "x", state: "lost" },
      null,
    ]);
    expect(rows.map((r) => r.jobId)).toEqual([id(1), id(3)]);
    expect(queuedEmails({})).toEqual([]);
    expect(queuedEmailStateText(rows[0])).toBe("ממתין לשליחה");
    expect(queuedEmailStateText({ state: "sent", reason: null })).toBe("נשלח");
    expect(queuedEmailStateText(rows[1])).toMatch(/^לא נשלח: אין הסכמה/);
    expect(queuedEmailStateText({ state: "not_sent", reason: "paused" })).toMatch(/עצורה/);
    expect(queuedEmailStateText({ state: "not_sent", reason: "other" })).toBe("לא נשלח");
    expect(queuedMessage(false)).toMatch(/^האימייל ממתין לשליחה/);
    expect(queuedMessage(true)).toMatch(/עצורה/);
  });
});

describe("EML-02: the send handler hands the email's ids to the provider", () => {
  beforeEach(() => clearFakeSentMessages());
  const job = (payload: Record<string, unknown>): ClaimedJob => ({
    id: id(1),
    lease: id(2),
    kind: "message.send",
    organization_id: id(3),
    payload,
    attempt: 1,
  });

  it("an email from a card carries its template, deal, files and reply-to; any other message carries none", async () => {
    const handler = createSendHandler({ maySend: async () => ({ may_send: true }), providerFor: (channel) => createFakeProvider({ channel }) });
    await handler(
      job({ channel: "email", contact_id: id(4), message_type: "requested_document", template_id: id(5), deal_id: id(6), file_ids: [id(7)], library_file_ids: [id(9)], reply_to_user_id: id(8) }),
    );
    await handler(job({ channel: "email", lead_id: id(4), message_type: "collection", template_id: id(5) }));
    const [card, plain] = fakeSentMessages();
    expect(card.email).toEqual({ templateId: id(5), dealId: id(6), fileIds: [id(7)], libraryFileIds: [id(9)], replyToUserId: id(8) });
    expect(card.recordType).toBe("contact");
    expect("email" in plain).toBe(false);
    expect(recordEmailParts({ channel: "sms" })).toBeUndefined();
    expect(recordEmailParts({ reply_to_user_id: id(1), file_ids: "x" })).toEqual({ templateId: null, dealId: null, fileIds: [], libraryFileIds: [], replyToUserId: id(1) });
    expect(recordEmailParts({ library_file_ids: [id(2), 3] })).toEqual({ templateId: null, dealId: null, fileIds: [], libraryFileIds: [id(2)], replyToUserId: null });
  });
});

describe("EML-02 (198) ב: the audit entry of an email's attachments", () => {
  it("has a Hebrew label and one line naming the files", () => {
    expect(ACTION_LABELS.email_attachments).toBe("קבצים שצורפו לאימייל");
    expect(
      auditEntryNote("email_attachments", {
        job_id: id(1),
        files: [{ id: id(2), name: "הצעה.pdf" }],
        library_files: [{ id: id(3), name: "מצגת.pdf", library_item_id: id(4) }],
      }),
    ).toBe('צורפו מהרשומה: "הצעה.pdf"; מספריית התוכן: "מצגת.pdf"');
    expect(auditEntryNote("email_attachments", { files: [], library_files: [{ id: id(3), name: "מצגת.pdf" }] })).toBe('צורפו מספריית התוכן: "מצגת.pdf"');
    expect(auditEntryNote("email_attachments", { files: [], library_files: [] })).toBeNull();
    expect(auditEntryNote("email_attachments", { files: "x" })).toBeNull();
  });
  it("the definer half writes it on the person's own record, ids and names only", () => {
    expect(followUp).toMatch(/insert into public\.audit_log \(organization_id, actor_id, action, entity_type, entity_id, changes\)\s*values \(p_org, v_user, 'email_attachments'/);
    expect(followUp).toMatch(/case when p_kind = 'lead' then 'leads' else 'contacts' end/);
  });
});
