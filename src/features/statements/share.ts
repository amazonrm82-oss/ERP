// BAL-04: the statement link goes out by WhatsApp or email from the card, like the quote link (QUO-08). Pure helpers.

/** The message with the link; a missing part is left out of the sentence, never shown as a placeholder. */
export function statementLinkMessage(url: string, businessName: string | null, customerName: string | null): string {
  const greeting = customerName?.trim() ? `שלום ${customerName.trim()},` : "שלום,";
  const from = businessName?.trim() ? ` כאן ${businessName.trim()}.` : "";
  return `${greeting}${from} דף החשבון שלך, עם פירוט החובות הפתוחים, נמצא בקישור הזה: ${url}`;
}

/** wa.me with the message: to the customer's number when it is E.164, else the person picks the chat. */
export function statementWhatsappHref(url: string, businessName: string | null, customerName: string | null, phoneE164: string | null): string {
  const digits = phoneE164 && /^\+[1-9]\d{6,14}$/.test(phoneE164) ? phoneE164.slice(1) : "";
  return `https://wa.me/${digits}?text=${encodeURIComponent(statementLinkMessage(url, businessName, customerName))}`;
}

// a plain address only: anything that could add headers or more recipients to the mailto link is left out
const PLAIN_EMAIL = /^[^\s@?&#,;:<>"]+@[^\s@?&#,;:<>"]+\.[^\s@?&#,;:<>"]+$/;

/** mailto with a subject and body, to the customer when their email is a plain address. */
export function statementMailtoHref(url: string, businessName: string, customerName: string | null, email: string | null): string {
  const subject = `דף חשבון מ${businessName}`;
  const body = [customerName?.trim() ? `שלום ${customerName.trim()},` : "שלום,", "", "דף החשבון שלך, עם פירוט החובות הפתוחים, נמצא בקישור הזה:", url, "", "בברכה,", businessName].join("\n");
  const to = email && PLAIN_EMAIL.test(email.trim()) ? encodeURIComponent(email.trim()).replace(/%40/g, "@") : "";
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
