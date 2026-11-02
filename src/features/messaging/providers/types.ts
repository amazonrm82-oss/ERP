// OPS-04: the provider layer for customer messages. A provider gets ids and codes only; a real adapter (email, SMS),
// chosen by the owner later, reads what it needs to send through its own approved path. None is built yet.

export type MessageChannel = "email" | "sms" | "whatsapp";

/** What the send handler hands a provider: the job and the record it is for, never an address or text. */
export type OutgoingMessage = {
  jobId: string;
  organizationId: string;
  channel: MessageChannel;
  recordType: "lead" | "contact";
  recordId: string;
};

export type ProviderResult = { ok: true; providerId: string } | { ok: false; error: string; final?: boolean };

export type MessagingProvider = {
  name: string;
  send(message: OutgoingMessage): Promise<ProviderResult>;
};
