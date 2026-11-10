// EML-02: an email to the customer from the record's card, from an email template, with the record's files and content
// library files (LIB-01) attached. It
// is queued as an OPS-04 message.send job by public.record_email_send (migration record_email), which judges everything
// again; these are the dialog's own rules and texts, kept equal to the database's (tests/unit/record-email.test.ts reads
// the migration).

import { marketingEnvelope } from "@/features/message-templates/envelope";
import { fillMessage, unfilledMergeFields, type MergeValues } from "@/features/message-templates/fields";
import type { MessageType } from "@/features/messaging/providers/types";

export const RECORD_EMAIL_KINDS = ["lead", "contact", "deal"] as const;
export type RecordEmailKind = (typeof RECORD_EMAIL_KINDS)[number];

/** = app.record_email_max_files() */
export const RECORD_EMAIL_MAX_FILES = 5;
/** = app.record_email_max_bytes(): 10 MB together */
export const RECORD_EMAIL_MAX_BYTES = 10 * 1024 * 1024;
/**
 * = app.record_email_service_types(): the service types a card may send (owner (194) א); collection only for whoever
 * records payments (app.can_record_payments). A meeting reminder (CAL-12), a verification code and a punch card notice
 * carry their own context and are sent by their own senders only. Every other type is marketing and is sent only with the
 * customer's consent (the queue's send check).
 */
export const CARD_SERVICE_TYPES = ["requested_document", "collection"] as const satisfies readonly MessageType[];

export type CardTemplate = {
  id: string;
  name: string;
  channel: string;
  messageType: MessageType;
  subject: string | null;
  body: string;
  isActive: boolean;
};

/** The templates the dialog offers: active email templates of marketing or a card's service type (collection only for a payment recorder). */
export function cardEmailTemplates<T extends CardTemplate>(templates: readonly T[], canRecordPayments: boolean): T[] {
  return templates.filter(
    (t) =>
      t.channel === "email" &&
      t.isActive &&
      (t.messageType === "marketing" ||
        ((CARD_SERVICE_TYPES as readonly string[]).includes(t.messageType) && (t.messageType !== "collection" || canRecordPayments))),
  );
}

export type PickableFile = { id: string; name: string; sizeBytes: number };

/**
 * Why the picked files cannot go (null = they can): the count and the total size of the record's files and the library's
 * files together, as the database counts them. A library file is picked by its item's id.
 */
export function fileSelectionProblem(
  files: readonly PickableFile[],
  picked: readonly string[],
  library: readonly PickableFile[] = [],
  pickedLibrary: readonly string[] = [],
): string | null {
  const ids = [...new Set(picked)];
  const libraryIds = [...new Set(pickedLibrary)];
  if (ids.length + libraryIds.length > RECORD_EMAIL_MAX_FILES) return `אפשר לצרף עד ${RECORD_EMAIL_MAX_FILES} קבצים לאימייל אחד.`;
  const byId = new Map(files.map((f) => [f.id, f]));
  const libraryById = new Map(library.map((f) => [f.id, f]));
  if (ids.some((id) => !byId.has(id))) return "אחד הקבצים כבר לא ברשומה. רעננו את הדף ובחרו שוב.";
  if (libraryIds.some((id) => !libraryById.has(id))) return "אחד הקבצים מהספרייה כבר לא זמין. רעננו את הדף ובחרו שוב.";
  const total =
    ids.reduce((sum, id) => sum + (byId.get(id)?.sizeBytes ?? 0), 0) + libraryIds.reduce((sum, id) => sum + (libraryById.get(id)?.sizeBytes ?? 0), 0);
  if (total > RECORD_EMAIL_MAX_BYTES) return "הקבצים גדולים מדי יחד. אפשר לצרף עד 10MB לאימייל אחד.";
  return null;
}

export type EmailPreview = { subject: string | null; body: string; unfilled: string[]; marketing: boolean };

/**
 * The email as the customer will get it: a marketing template inside the envelope the system adds (MSG-02, owner (88)),
 * then the record's values. A field the dialog has no value for stays as it is (the sender fills it).
 */
export function emailPreview(template: Pick<CardTemplate, "messageType" | "subject" | "body">, values: MergeValues): EmailPreview {
  const envelope = marketingEnvelope({ channel: "email", messageType: template.messageType, subject: template.subject, body: template.body });
  const subject = envelope.subject ? fillMessage(envelope.subject, values) : null;
  const body = fillMessage(envelope.body, values);
  return { subject, body, unfilled: unfilledMergeFields(`${subject ?? ""}\n${body}`), marketing: template.messageType === "marketing" };
}

export type QueuedEmail = {
  jobId: string;
  createdAt: string;
  templateName: string | null;
  senderId: string | null;
  files: number;
  state: "waiting" | "sent" | "not_sent";
  reason: "consent" | "paused" | "other" | null;
};

const STATES = new Set(["waiting", "sent", "not_sent"]);
const REASONS = new Set(["consent", "paused", "other"]);

/** Parses public.record_email_queue's answer; a malformed row is left out. */
export function queuedEmails(data: unknown): QueuedEmail[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((row): QueuedEmail[] => {
    if (!row || typeof row !== "object") return [];
    const r = row as Record<string, unknown>;
    if (typeof r.job_id !== "string" || typeof r.created_at !== "string" || typeof r.state !== "string" || !STATES.has(r.state)) return [];
    return [
      {
        jobId: r.job_id,
        createdAt: r.created_at,
        templateName: typeof r.template_name === "string" ? r.template_name : null,
        senderId: typeof r.sender_id === "string" ? r.sender_id : null,
        files: typeof r.files === "number" ? r.files : 0,
        state: r.state as QueuedEmail["state"],
        reason: typeof r.reason === "string" && REASONS.has(r.reason) ? (r.reason as QueuedEmail["reason"]) : null,
      },
    ];
  });
}

/** One line per queued email: waiting (no provider yet, or paused), sent, or not sent and why in plain words. */
export function queuedEmailStateText(email: Pick<QueuedEmail, "state" | "reason">): string {
  if (email.state === "waiting") return "ממתין לשליחה";
  if (email.state === "sent") return "נשלח";
  if (email.reason === "consent") return "לא נשלח: אין הסכמה לקבל הודעות שיווקיות באימייל, או שהכתובת חסומה";
  if (email.reason === "paused") return "לא נשלח: השליחה ללקוחות הייתה עצורה יותר מיממה";
  return "לא נשלח";
}

/** What the dialog says after the email was queued. */
export function queuedMessage(paused: boolean): string {
  return paused
    ? "האימייל ממתין לשליחה. השליחה ללקוחות עצורה כרגע, והוא יישלח כשהיא תחודש."
    : "האימייל ממתין לשליחה. התשובות יגיעו לאימייל שלכם.";
}
