import type { PlatformRole } from "@/lib/database.types";

export const PLATFORM_ROLE_LABELS: Record<PlatformRole, string> = {
  owner: "בעלים",
  support: "תמיכה",
  finance: "כספים",
  readonly: "קריאה בלבד",
};

export const ORG_STATUS_LABELS: Record<string, string> = {
  trial: "ניסיון",
  active: "פעיל",
  past_due: "חיוב נכשל",
  read_only: "קריאה בלבד",
  suspended: "מושעה",
  cancelled: "מבוטל",
};

export const ACTION_LABELS: Record<string, string> = {
  "subscription.update": "שינוי חבילה / מושבים / ניסיון",
  "subscription.overrides": "דריסת מגבלות ויכולות",
  "organization.status": "שינוי מצב ארגון",
  "plan.update": "עריכת חבילה",
  "staff.set": "שינוי בצוות הפלטפורמה",
  "support.open": "כניסת תמיכה לארגון",
  "user.mfa_reset": "איפוס אימות דו-שלבי למשתמש",
  "plan.availability": "שינוי מצב חבילה",
  "trial_end.switch": "הדלקה או כיבוי של המעבר בסוף הניסיון",
  "trial_end.read_only": "סוף ניסיון: מעבר לקריאה בלבד",
  "trial_end.closed": "סוף ניסיון: סגירת העסק",
  "trial_end.restored": "סוף ניסיון: העסק חזר לעבוד",
  "suspension_cancel.switch": "הדלקה או כיבוי של הביטול אחרי השעיה",
  "suspension.cancelled": "ביטול מנוי אחרי 90 יום בהשעיה",
  "suspended_lead_notices.switch": "הדלקה או כיבוי של התראות ליד חדש לעסק מושהה",
  "vat_rate.add": "הוספת שיעור מע\"מ",
  "vat_rate.update": "תיקון שיעור מע\"מ עתידי",
  "vat_rate.remove": "הסרת שיעור מע\"מ עתידי",
  "qr_external.block": "כיבוי הקישורים החיצוניים בקודי QR",
  "qr_external.unblock": "החזרת הקישורים החיצוניים בקודי QR",
};

/** How support checked who is asking before a two-step verification reset (platform_reset_mfa). */
export const IDENTITY_CHECKS: Record<string, string> = {
  org_admin_confirmed: "בעל העסק או מנהל מערכת בעסק אישר בכתב שהבקשה מהמשתמש, אחרי שדיבר איתו",
  account_email_and_details: "הבקשה הגיעה מכתובת האימייל של החשבון, והמשתמש ענה נכון על פרטים מהחשבון",
  video_id: "שיחת וידאו עם תעודה מזהה, ששמה תואם לשם בחשבון",
};

/** Mirrors app.require_platform(): owner passes everywhere. */
export function canDo(role: PlatformRole, allowed: PlatformRole[]): boolean {
  return role === "owner" || allowed.includes(role);
}
