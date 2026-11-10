// SGN-02: a document's states on the record's card, and the message that carries its link. Pure.

export type SignatureStatus = "sent" | "viewed" | "signed" | "cancelled";
export type ShownSignatureState = SignatureStatus | "expired";

const STATUSES: readonly SignatureStatus[] = ["sent", "viewed", "signed", "cancelled"];

export function isSignatureStatus(value: unknown): value is SignatureStatus {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

export const SIGNATURE_STATE_LABELS: Record<ShownSignatureState, string> = {
  sent: "נשלח",
  viewed: "נצפה",
  signed: "נחתם",
  cancelled: "בוטל",
  expired: "פג תוקף",
};

/** The shown state: an unsigned document past its last day reads "expired" (SGN-03 adds reminders). */
export function shownSignatureState(doc: { status: SignatureStatus; expiresAt: string | null }, now: Date = new Date()): ShownSignatureState {
  if ((doc.status === "sent" || doc.status === "viewed") && doc.expiresAt && Date.parse(doc.expiresAt) <= now.getTime()) return "expired";
  return doc.status;
}

/** Whether a document still waits for its signature (a new link and cancelling are offered). */
export function awaitsSignature(doc: { status: SignatureStatus; expiresAt: string | null }, now: Date = new Date()): boolean {
  const state = shownSignatureState(doc, now);
  return state === "sent" || state === "viewed";
}

/** The message with the link; a missing part is left out of the sentence, never shown as a placeholder. */
export function signatureLinkMessage(url: string, title: string, businessName: string | null): string {
  const from = businessName?.trim() ? ` מ${businessName.trim()}` : "";
  return `שלום, מצורף קישור למסמך "${title}"${from} לקריאה ולחתימה מהטלפון: ${url}`;
}

/** wa.me with the message: to the customer's number when it is E.164, else the person picks the chat. */
export function signatureWhatsappHref(url: string, title: string, businessName: string | null, phoneE164: string | null): string {
  const digits = phoneE164 && /^\+[1-9]\d{6,14}$/.test(phoneE164) ? phoneE164.slice(1) : "";
  return `https://wa.me/${digits}?text=${encodeURIComponent(signatureLinkMessage(url, title, businessName))}`;
}
