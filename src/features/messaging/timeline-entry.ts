// MSG-03: a kept message drawn as a read-only timeline entry. Pure, so the wording is unit-tested.

export const MESSAGE_TIMELINE_TYPE = "message_log";

const OUTBOUND: Record<string, string> = { email: "אימייל יוצא", sms: "SMS יוצא", whatsapp: "הודעת WhatsApp יוצאת" };
const INBOUND: Record<string, string> = { email: "אימייל נכנס", sms: "SMS נכנס", whatsapp: "הודעת WhatsApp נכנסת" };

const STATUS: Record<string, string> = {
  sent: "נשלחה.",
  delivered: "נמסרה.",
  read: "נקראה.",
  failed: "השליחה נכשלה.",
  received: "התקבלה.",
};

export type MessageEntryInput = {
  channel: string;
  direction: string;
  status: string;
  provider?: string | null;
  provider_error_code?: string | null;
};

// Owner (96): a message whose filled text passed the channel's cap is not sent and is logged with this code and NO
// provider (the system's own refusal; a provider's error code that happens to read the same is a provider failure)
const REFUSED: Record<string, string> = { too_long: "לא נשלחה: ארוכה מדי." };

/** The entry's label: channel and direction ("SMS יוצא"); an unknown channel reads "הודעה". */
export function messageEntryLabel(message: MessageEntryInput): string {
  const labels = message.direction === "inbound" ? INBOUND : OUTBOUND;
  return labels[message.channel] ?? (message.direction === "inbound" ? "הודעה נכנסת" : "הודעה יוצאת");
}

/** The entry's line: the delivery status only (the text itself is not kept in the system). */
export function messageEntryText(message: MessageEntryInput): string {
  if (message.status === "failed" && !message.provider && message.provider_error_code && REFUSED[message.provider_error_code]) {
    return REFUSED[message.provider_error_code];
  }
  return STATUS[message.status] ?? "";
}

/**
 * Pinned entries first (messages are never pinned), then newest first; entries at the same moment keep their order.
 * The page shows one time window: when either list came back full (its own limit reached), anything older than that
 * list's oldest item is left out of the other one too, so nothing older shows above a gap and nothing repeats or
 * jumps if a later page is added with the same window.
 */
export function mergeTimeline<T extends { pinned: boolean; occurredAt: string }>(
  entries: T[],
  messages: T[],
  full: { entries: boolean; messages: boolean } = { entries: false, messages: false },
): T[] {
  if (messages.length === 0) return entries;
  const time = (x: T) => Date.parse(x.occurredAt);
  const pinned = entries.filter((e) => e.pinned);
  const unpinned = entries.filter((e) => !e.pinned);
  const floors = [
    full.entries && unpinned.length > 0 ? Math.min(...unpinned.map(time)) : -Infinity,
    full.messages ? Math.min(...messages.map(time)) : -Infinity,
  ];
  const floor = Math.max(...floors);
  const rest = [...unpinned, ...messages].filter((x) => time(x) >= floor).sort((a, b) => time(b) - time(a));
  return [...pinned, ...rest];
}
