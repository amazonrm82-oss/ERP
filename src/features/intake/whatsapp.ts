import { normalizePhone } from "@/lib/phone";

/** CAP-05: the longest text written in the chat in advance (forms.whatsapp_text). */
export const MAX_WHATSAPP_TEXT = 300;

/** A number WhatsApp can open: E.164, 8 to 15 digits (the same rule as intake_form()). */
const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * A typed phone ("050-1234567", "+972 50 123 4567") as the E.164 number a
 * WhatsApp chat opens, or null when it is not a usable number.
 */
export function whatsappNumber(phone: string | null | undefined): string | null {
  const e164 = normalizePhone(phone);
  return e164 && E164.test(e164) ? e164 : null;
}

/**
 * The thank-you page's button link: https://wa.me/<digits>, with the text
 * prefilled when there is one. Null when the number is not a valid E.164 one,
 * so the page shows no button.
 */
export function whatsappChatUrl(phoneE164: string | null | undefined, text?: string | null): string | null {
  if (!phoneE164 || !E164.test(phoneE164)) {
    return null;
  }
  const message = text?.trim().slice(0, MAX_WHATSAPP_TEXT);
  const base = `https://wa.me/${phoneE164.slice(1)}`;
  return message ? `${base}?text=${encodeURIComponent(message)}` : base;
}
