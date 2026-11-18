// DOC-15 (owner (414) א): the document link goes out from the documents card by WhatsApp (wa.me) or by the person's own email
// program. Pure helpers.

/** The placeholder that replaces the link in the timeline entry: the secret address is never stored. */
export const LINK_PLACEHOLDER = "[קישור למסמך]";

/** The message with the link; a missing part is left out of the sentence, never shown as a placeholder. */
export function documentLinkMessage(url: string, title: string, businessName: string | null, customerName: string | null): string {
  const greeting = customerName?.trim() ? `שלום ${customerName.trim()},` : "שלום,";
  const from = businessName?.trim() ? ` כאן ${businessName.trim()}.` : "";
  return `${greeting}${from} ${title} נמצאת בקישור הזה: ${url}`;
}

/** The same message as it goes on the record's timeline: the link replaced by a placeholder. */
export function documentLinkLogText(url: string, title: string, businessName: string | null, customerName: string | null): string {
  return documentLinkMessage(url, title, businessName, customerName).split(url).join(LINK_PLACEHOLDER);
}

/** wa.me with the message: to the customer's number when it is E.164, else the person picks the chat. */
export function documentWhatsappHref(message: string, phoneE164: string | null): string {
  const digits = phoneE164 && /^\+[1-9]\d{6,14}$/.test(phoneE164) ? phoneE164.slice(1) : "";
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

// a plain address only: anything that could add headers or more recipients to the mailto link is left out
const PLAIN_EMAIL = /^[^\s@?&#,;:<>"]+@[^\s@?&#,;:<>"]+\.[^\s@?&#,;:<>"]+$/;

/** mailto with a subject and body, to the customer when their email is a plain address. */
export function documentMailtoHref(url: string, title: string, businessName: string, customerName: string | null, email: string | null): string {
  const subject = `${title} מ${businessName}`;
  const body = [customerName?.trim() ? `שלום ${customerName.trim()},` : "שלום,", "", `${title} נמצאת בקישור הזה:`, url, "", "בברכה,", businessName].join("\n");
  const to = email && PLAIN_EMAIL.test(email.trim()) ? encodeURIComponent(email.trim()).replace(/%40/g, "@") : "";
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
