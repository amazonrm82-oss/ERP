import type { MembershipRole, OrgStatus } from "@/lib/database.types";

export const ROLE_LABELS: Record<MembershipRole, string> = {
  owner: "בעלים",
  admin: "מנהל מערכת",
  manager: "מנהל צוות",
  member: "משתמש",
  viewer: "צופה",
};

// Shown as a banner when the organization cannot be written to.
export const ORG_STATUS_NOTICES: Partial<Record<OrgStatus, string>> = {
  past_due: "התשלום האחרון לא עבר. כדי להמשיך לעבוד בלי הפרעה צריך להסדיר אותו.",
  read_only: "העסק במצב קריאה בלבד. אפשר לצפות בנתונים, אבל לא להוסיף או לשנות.",
  // BIL-09 (owner, 13 October 2026): no viewing while suspended; the closed screen says the rest
  suspended: "הגישה לעסק סגורה עד לתשלום. הנתונים שמורים, והטפסים ממשיכים לקלוט לידים.",
  cancelled: "המנוי בוטל והגישה לעסק סגורה. הנתונים שמורים.",
};
