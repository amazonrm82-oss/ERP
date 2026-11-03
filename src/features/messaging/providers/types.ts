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

/** What the send handler hands a provider: the job and the record it is for, never an address or text. */
export type OutgoingMessage = {
  jobId: string;
  organizationId: string;
  channel: MessageChannel;
  recordType: "lead" | "contact";
  recordId: string;
};

/**
 * A provider's answer. providerId is the provider's own message id (MSG-03 keeps it, one per provider and business, so a
 * delivery report or a repeated callback is never counted twice); costAgorot is what the provider charged, when it says.
 */
export type ProviderResult =
  | { ok: true; providerId: string; costAgorot?: number | null }
  | { ok: false; error: string; final?: boolean };

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
