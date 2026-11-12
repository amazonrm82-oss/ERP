// MSG-01: the provider layer, one provider per channel, an adapter per provider. A module never names a provider: it
// asks for the channel's provider (select.ts), so replacing a provider is a change of configuration and one adapter
// file. A provider gets ids and codes only; a real adapter (chosen by the owner later) reads what it needs to send
// through its own approved path. Only the fake adapter exists.

/** The channels a queued message can go out on (the OPS-04 payload's `channel`, app.job_payload_ok). */
export const MESSAGE_CHANNELS = ["email", "sms", "whatsapp"] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

/** Telephony is a channel of the layer too, but nothing places a call yet: a type only (MSG-01). */
export type ProviderChannel = MessageChannel | "phone";

export function isMessageChannel(value: unknown): value is MessageChannel {
  return typeof value === "string" && (MESSAGE_CHANNELS as readonly string[]).includes(value);
}

/**
 * CNS-07 (owner 3 November 2026, answer (73) א): every queued message has a type from a closed list (the payload's
 * `message_type`, app.job_payload_ok). Service is a CLOSED list of types, never a flag a business sets: a meeting
 * reminder, a document the customer asked for, collection, a verification code (SERVICE_MESSAGE_TYPES =
 * app.service_message_types()). Every other type, and a job queued without one, is marketing: sent only with a recorded
 * grant for the channel. A service message goes after an ordinary opt-out from marketing, never to an address on the
 * blocklist or blocked by a privacy erasure. The database's send check judges; an adapter adds what the law asks of an
 * advertisement ("פרסומת", sender, opt-out) to a marketing message only.
 */
export const MESSAGE_TYPES = ["meeting_reminder", "requested_document", "collection", "verification_code", "punch_card_notice", "instant_reply", "review_request", "marketing"] as const;
// RET-02: review_request, a request for a Google review after a won deal or a held meeting: MARKETING (a grant of the
// channel, the caps); its templates are judged by a closed field list like a service type (service-rule.ts)
export type MessageType = (typeof MESSAGE_TYPES)[number];
// PKG-03 (owner (127) ב): punch_card_notice, a punch card's few entries left or last day near (no price, link or offer)
// SPD-04 (owner (80) א): instant_reply, the automatic reply to a web form inquiry (to the typed address only; no link or offer)
export const SERVICE_MESSAGE_TYPES = ["meeting_reminder", "requested_document", "collection", "verification_code", "punch_card_notice", "instant_reply"] as const;
export type MessagePurpose = "marketing" | "service";

export function isMessageType(value: unknown): value is MessageType {
  return typeof value === "string" && (MESSAGE_TYPES as readonly string[]).includes(value);
}

/** service for the closed service list only; any other type, or none, is marketing */
export function messagePurpose(type: MessageType | null): MessagePurpose {
  return type !== null && (SERVICE_MESSAGE_TYPES as readonly string[]).includes(type) ? "service" : "marketing";
}

/** What the send handler hands a provider: the job and the record it is for, never an address or text. */
export type OutgoingMessage = {
  jobId: string;
  organizationId: string;
  channel: MessageChannel;
  // null = queued before types existed (judged as marketing)
  messageType: MessageType | null;
  purpose: MessagePurpose;
  // SMS-01b: "sender_check" = the code that verifies the business's own sender number (recordId = the check's id; the
  // adapter gets the code and the phone from public.sms_sender_code_issue, its own approved path, not built yet)
  recordType: "lead" | "contact" | "sender_check";
  recordId: string;
  // EML-02: an email a person sent from a record's card: the template, the deal it was sent from (the record is then the
  // deal's contact), the record files and the content-library files to attach (told apart by their own payload keys) and
  // the person whose address is the reply-to. Ids only: a real adapter
  // reads the content through its own approved path. Absent on every other message.
  email?: RecordEmailParts;
  // SMS-02: an SMS a person sent from a record's card or an automation queued: the template, the deal it was sent from
  // (the record is then the deal's contact), and who queued it. Ids only; the sender name (SMS-01) and the text are read by
  // a real adapter through its own approved path. Absent on every other message.
  sms?: SmsParts;
};

export type SmsParts = {
  templateId: string | null;
  dealId: string | null;
  sentByUserId: string | null;
  automationId: string | null;
};

export type RecordEmailParts = {
  templateId: string | null;
  dealId: string | null;
  fileIds: string[];
  libraryFileIds: string[];
  replyToUserId: string | null;
  // AUT-08: the rule that queued an automation's email (present only then)
  automationId?: string;
};

/**
 * A provider's answer. providerId is the provider's own message id (MSG-03 keeps it, one per provider and business, so a
 * delivery report or a repeated callback is never counted twice); code is the provider's short error code of a failure
 * (kept on the message when the send failed for good; owner (75) א: ids and codes only, no content, no cost).
 */
export type ProviderResult =
  | { ok: true; providerId: string }
  | { ok: false; error: string; final?: boolean; code?: string };

/** An adapter for one provider on one channel. `name` is the provider's code, kept on every message it sent. */
export type MessagingProvider = {
  name: string;
  channel: MessageChannel;
  send(message: OutgoingMessage): Promise<ProviderResult>;
};

/** What a telephony adapter will look like (click to call, call logging). No adapter and no caller exist yet. */
export type TelephonyCall = {
  organizationId: string;
  userId: string;
  recordType: "lead" | "contact";
  recordId: string;
};

export type TelephonyProvider = {
  name: string;
  channel: "phone";
  startCall(call: TelephonyCall): Promise<{ ok: true; providerCallId: string } | { ok: false; error: string }>;
};
