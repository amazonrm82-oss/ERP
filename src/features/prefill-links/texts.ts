// BIZ-05: the texts of the prefill form (Hebrew, short; none names the customer)

export const PREFILL_PAGE_TITLE = "השלמת פרטים";

// the link preview is always generic: the page is never read for a preview (a read counts a call)
export const PREFILL_PREVIEW = { what: "השלמת פרטים", description: "טופס קצר לבדיקה ולהשלמה של הפרטים שלכם, בקישור אישי." } as const;

export const PREFILL_CARD_TEXTS = {
  title: "טופס השלמת פרטים",
  intro: "שולחים ללקוח קישור אישי לטופס עם הפרטים שכבר רשומים אצלכם. מה שהוא משלים נכנס לרשומה ולציר הזמן.",
  pick: "טופס",
  create: "יצירת קישור",
  linkLabel: "הקישור לטופס",
  shownOnce: "הקישור מוצג עכשיו בלבד. העתיקו או שלחו אותו לפני שסוגרים. הוא בתוקף 14 ימים ולמילוי אחד.",
  whatsapp: "שליחה ב-WhatsApp",
  copy: "העתקה",
  copied: "הועתק",
  copyFailed: "לא הצלחנו להעתיק. סמנו את הקישור והעתיקו אותו ידנית.",
  done: "סיום",
  noForms: "אין עדיין טופס פעיל לסוג הרשומה הזה.",
  toSettings: "להגדרת טפסים",
  sent: "קישורים שנשלחו",
  none: "עוד לא נשלח קישור.",
  revoke: "ביטול הקישור",
  revokeTitle: "לבטל את הקישור?",
  revokeText: "הלקוח לא יוכל לפתוח אותו יותר. אפשר ליצור קישור חדש בכל רגע.",
  notInPlan: "טופס השלמת פרטים אינו כלול בחבילה הנוכחית.",
} as const;

export const PREFILL_STATE_LABELS = {
  open: "ממתין למילוי",
  submitted: "מולא",
  expired: "פג תוקף",
  revoked: "בוטל",
} as const;

export type PrefillLinkState = keyof typeof PREFILL_STATE_LABELS;

/** The WhatsApp message with the link; a missing part is left out of the sentence. */
export function prefillLinkMessage(url: string, businessName: string | null, customerName: string | null): string {
  const greeting = customerName?.trim() ? `שלום ${customerName.trim()},` : "שלום,";
  const from = businessName?.trim() ? ` כאן ${businessName.trim()}.` : "";
  return `${greeting}${from} נשמח שתבדקו ותשלימו את הפרטים שלכם בקישור הזה: ${url}`;
}

/** wa.me with the message: to the customer's number when it is E.164, else the person picks the chat. */
export function prefillWhatsappHref(url: string, businessName: string | null, customerName: string | null, phoneE164: string | null): string {
  const digits = phoneE164 && /^\+[1-9]\d{6,14}$/.test(phoneE164) ? phoneE164.slice(1) : "";
  return `https://wa.me/${digits}?text=${encodeURIComponent(prefillLinkMessage(url, businessName, customerName))}`;
}
