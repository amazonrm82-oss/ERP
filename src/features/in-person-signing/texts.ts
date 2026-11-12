import { paths } from "@/lib/paths";

// SGN-07: in-person signing, shared by the actions and the screens (pure).

export const signatureInPersonPath = (orgId: string, docId: string) => `/o/${orgId}/signatures/${docId}/sign`;
export const quoteInPersonPath = (orgId: string, quoteId: string) => `/o/${orgId}/quotes/${quoteId}/sign`;

// declined: owner (290) ב, the customer declined the quote on the rep's device (nothing signed, no PDF)
export type InPersonResult = { status: string; signed: boolean; declined?: boolean; message: string; pdfLater: boolean };

export const IN_PERSON_CANNOT = "אין לכם הרשאה להחתים את הלקוח במקום על המסמך הזה.";
// the rep never reads the signed PDF afterwards (owners and admins only, owner (37) ב)
export const IN_PERSON_PDF_SAVED = "ה-PDF החתום נשמר ברשומה. בעלים ומנהלי מערכת רואים אותו שם.";
export const IN_PERSON_PDF_LATER = "החתימה נשמרה, אבל ה-PDF החתום עוד לא נשמר. בעלים או מנהל מערכת יוכלו ליצור אותו מהרשומה.";
export const IN_PERSON_EVIDENCE =
  "החתימה נעשית פנים אל פנים, במכשיר שלך. נשמרים השם, החתימה, השעה, מי מהצוות היה נוכח, הדפדפן וכתובת ה-IP של המכשיר.";
// owner (290) ב: the customer declined on the rep's device
export const IN_PERSON_DECLINED = "הדחייה נשמרה. ההצעה סומנה כנדחתה.";
export const IN_PERSON_HAND_OVER = "מסרו את המכשיר ללקוח: הוא קורא את המסמך וחותם באצבע.";

type RecordLinks = { lead_id: string | null; contact_id: string | null; company_id: string | null; deal_id: string | null };

/** The record page a document for signature belongs to, or null for a detached one. */
export function recordPathOf(orgId: string, doc: RecordLinks): string | null {
  if (doc.lead_id) return paths.lead(orgId, doc.lead_id);
  if (doc.contact_id) return paths.contact(orgId, doc.contact_id);
  if (doc.company_id) return paths.company(orgId, doc.company_id);
  if (doc.deal_id) return paths.deal(orgId, doc.deal_id);
  return null;
}
