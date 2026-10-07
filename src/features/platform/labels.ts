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
};

/** Mirrors app.require_platform(): owner passes everywhere. */
export function canDo(role: PlatformRole, allowed: PlatformRole[]): boolean {
  return role === "owner" || allowed.includes(role);
}
