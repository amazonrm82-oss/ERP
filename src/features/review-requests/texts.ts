// RVW-94 (FLD-10 on the review-request screens): every text that names a deal, a contact or a lead, in the business's own
// words. Pure, unit tested (tests/unit/rvw94-module-terms.test.ts). "לקוח" stays: the person who gets the request.

import { byGender, withPrefixThe, type OrgTerms } from "@/features/terminology/terms";

/** "אחרי שעסקה נסגרה בהצלחה" / "אחרי שתיק נסגר בהצלחה" */
export function reviewDealWonLabel(terms: OrgTerms): string {
  return `אחרי ש${terms.deal.singular} ${byGender(terms.deal, "נסגר", "נסגרה")} בהצלחה`;
}

/** The first paragraph of "איך זה עובד": when the request goes out and to whom. */
export function reviewHowItWorks(terms: OrgTerms, gapDays: number): string {
  const { deal, contact, lead } = terms;
  return (
    `כמה ימים אחרי ש${deal.singular} ${byGender(deal, "נסגר", "נסגרה")} בהצלחה, או אחרי פגישה שהתקיימה, הלקוח מקבל הודעה עם הקישור לדף הביקורות ` +
    `של העסק (ב-Google, בפייסבוק, ב-easy, בזאפ או בכל אתר אחר). ההודעה יוצאת ${withPrefixThe("ל", contact)} של ${deal.theSingular} או של הפגישה, ` +
    `ואם לפגישה יש רק ${lead.singular}, ${withPrefixThe("ל", lead)}: בערוץ המועדף, ואם אין, ב-SMS או באימייל. ` +
    `כל לקוח מקבל בקשה אחת לכל היותר ב-${gapDays} יום.`
  );
}

/** "הבקשה נשלחת רק על עסקאות ופגישות מהרגע שהפעלתם" */
export function reviewOnlySince(terms: OrgTerms): string {
  return `הבקשה נשלחת רק על ${terms.deal.plural} ופגישות מהרגע שהפעלתם, לא על מה שהיה לפני.`;
}
