// QUO-08 (owner, 18 October 2026): the customer's link goes out by WhatsApp or email right when the quote is sent, and
// from the link card later. Pure helpers, shared by both places and the unit tests.

/** Asked before a new link replaces a working one (owner, 18 October 2026: "הקישור הקודם יפסיק לעבוד"). */
export const NEW_LINK_WARNING = "הקישור הקודם יפסיק לעבוד מיד: מי שיפתח אותו לא יראה את ההצעה. אחר כך שלחו ללקוח את הקישור החדש.";

/** The line that goes with the link in WhatsApp. */
export function quoteLinkMessage(url: string, numberDisplay: string | null): string {
  return `${numberDisplay ? `הצעת מחיר ${numberDisplay}` : "הצעת מחיר"}: ${url}`;
}

/**
 * wa.me with the message. With the customer's number (E.164) the chat opens with them; without one the person picks the
 * chat. A number that is not E.164 is left out rather than guessed.
 */
export function quoteWhatsappHref(url: string, numberDisplay: string | null, phoneE164: string | null): string {
  const digits = phoneE164 && /^\+[1-9]\d{6,14}$/.test(phoneE164) ? phoneE164.slice(1) : "";
  return `https://wa.me/${digits}?text=${encodeURIComponent(quoteLinkMessage(url, numberDisplay))}`;
}

// a plain address only: anything that could add headers or more recipients to the mailto link is left out
const PLAIN_EMAIL = /^[^\s@?&#,;:<>"]+@[^\s@?&#,;:<>"]+\.[^\s@?&#,;:<>"]+$/;

/** The email's subject and body; the business is named by its display name (customer-facing communication). */
export function quoteEmailText(url: string, numberDisplay: string | null, businessName: string, customerName: string | null) {
  const quote = numberDisplay ? `הצעת מחיר ${numberDisplay}` : "הצעת מחיר";
  const subject = `${quote} מ${businessName}`;
  const body = [customerName ? `שלום ${customerName},` : "שלום,", "", `${quote} מחכה לך בקישור הזה:`, url, "", "בברכה,", businessName].join("\n");
  return { subject, body };
}

/** mailto with the subject and body, addressed to the customer when their email is a plain address. */
export function quoteMailtoHref(url: string, numberDisplay: string | null, businessName: string, customerName: string | null, email: string | null): string {
  const { subject, body } = quoteEmailText(url, numberDisplay, businessName, customerName);
  const to = email && PLAIN_EMAIL.test(email.trim()) ? encodeURIComponent(email.trim()).replace(/%40/g, "@") : "";
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// A part of the customer's name as the user's session read it: null = there is none, "hidden" = the user may not read it.
type Part<T> = T | null | "hidden";

export type CustomerNameParts = {
  contact: Part<{ fullName: string | null; billingName: string | null; companyId: string | null }>;
  // the contact's company; only read when the contact has one
  contactCompany: Part<{ name: string | null; billingName: string | null }>;
  // the quote's own company
  company: Part<{ name: string | null }>;
};

/**
 * The customer's name by the rule public.quote_send() uses when it prints it (CON-08 order): the contact's name for
 * invoices, else its company's, else its company, else the quote's company, else the contact. Keep the two in step
 * (test 158 compares them). Null when a part the rule reaches is hidden from the user, so the screen never shows a
 * "current name" built from what the user could not see.
 */
export function quoteCustomerName(parts: CustomerNameParts): string | null {
  const { contact, contactCompany, company } = parts;
  const steps: Array<() => string | null | "hidden"> = [
    () => (contact === "hidden" ? "hidden" : (contact?.billingName ?? null)),
    () => (contact === "hidden" ? "hidden" : !contact?.companyId ? null : contactCompany === "hidden" ? "hidden" : (contactCompany?.billingName ?? null)),
    () => (contact === "hidden" ? "hidden" : !contact?.companyId ? null : contactCompany === "hidden" ? "hidden" : (contactCompany?.name ?? null)),
    () => (company === "hidden" ? "hidden" : (company?.name ?? null)),
    () => (contact === "hidden" ? "hidden" : (contact?.fullName ?? null)),
  ];
  for (const step of steps) {
    const value = step();
    if (value === "hidden") return null;
    if (value !== null) return value;
  }
  return null;
}

/** "השם הנוכחי" is shown only when the printed name and today's name are both known and differ. */
export function currentNameIfChanged(printed: string | null, current: string | null): string | null {
  if (!printed || !current) return null;
  return printed.trim() === current.trim() ? null : current;
}
