// LIB-02: the Hebrew texts of the customer's page and of the card on the record

import { withPrefixThe, type OrgTerms } from "@/features/terminology/terms";

import type { LibraryRecordKind } from "./record";

export const LIBRARY_PAGE_TEXTS = {
  title: "חומר מהעסק",
  openLink: "פתיחת הקישור",
  opensSite: "הקישור פותח את האתר",
  openFile: "פתיחת הקובץ",
  // BIZ-03's emergency switch is on for the business: the outside site is not offered
  linkOff: "הקישור לאתר אינו זמין כרגע.",
} as const;

export const LIBRARY_CARD_TEXTS = {
  title: "חומרים מהספרייה",
  noItems: "אין כרגע בספרייה פריטים שאפשר לשלוח (פעילים ובתוקף).",
  toLibrary: "לספריית התוכן",
  pick: "פריט לשליחה",
  create: "יצירת קישור",
  linkLabel: "הקישור האישי",
  whatsapp: "שליחה ב-WhatsApp",
  email: "שליחה באימייל",
  copy: "העתקת הקישור",
  copied: "הועתק",
  copyFailed: "ההעתקה לא הצליחה. סמנו את הקישור והעתיקו ידנית.",
  done: "סיום",
  sent: "קישורים שנשלחו",
  none: "עוד לא נשלחו קישורים מהספרייה.",
  notOpened: "עוד לא נפתח",
  revoked: "בוטל",
  revoke: "ביטול הקישור",
  revokeTitle: "לבטל את הקישור?",
} as const;

/** "נפתח 3 פעמים, לאחרונה ב-…" / "נפתח פעם אחת ב-…" */
export function viewsText(count: number, lastText: string): string {
  if (count <= 0) return LIBRARY_CARD_TEXTS.notOpened;
  if (count === 1) return `נפתח פעם אחת, ב-${lastText}`;
  return `נפתח ${count} פעמים, לאחרונה ב-${lastText}`;
}

/** The card's texts that name who gets the link: in the business's words (RVW-94, FLD-10): the lead on a lead, the contact on
 * a contact and on a deal (its customer), the company on a company. */
export type LibraryRecipientTexts = { intro: string; shownOnce: string; revokeText: string };

export function libraryRecipientTexts(kind: LibraryRecordKind, terms: OrgTerms): LibraryRecipientTexts {
  const who =
    kind === "company"
      ? { to: "לחברה", the: "החברה", feminine: true }
      : (() => {
          const term = kind === "lead" ? terms.lead : terms.contact;
          return { to: withPrefixThe("ל", term), the: term.theSingular, feminine: term.gender === "f" };
        })();
  return {
    intro: `שולחים ${who.to} פריט מספריית התוכן בקישור אישי, ורואים מתי הקישור נפתח. בפתיחה הראשונה תקבלו התראה, וכל יום שבו הקישור נפתח נרשם בציר הזמן.`,
    shownOnce: `הקישור מוצג רק עכשיו. שלחו אותו ${who.to}: כל מי שיש לו את הקישור יכול לפתוח את הפריט.`,
    revokeText: `${who.the} לא ${who.feminine ? "תוכל" : "יוכל"} לפתוח את הפריט מהקישור הזה.`,
  };
}
