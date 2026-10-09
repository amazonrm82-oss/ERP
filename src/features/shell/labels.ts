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
  read_only: "החשבון במצב קריאה בלבד. אפשר לצפות בנתונים, אבל לא להוסיף או לשנות.",
  suspended: "החשבון מושהה. אפשר לצפות בנתונים, אבל לא להוסיף או לשנות.",
  cancelled: "המנוי בוטל. אפשר לצפות בנתונים, אבל לא להוסיף או לשנות.",
};
