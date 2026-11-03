import { z } from "zod";

import type { PrivacyRequestStatus, PrivacyRequestType, PrivacyVerifyMethod } from "@/lib/database.types";

// PRK-02: data-subject requests. The closed lists mirror the checks of migration _privacy_requests.sql (unit test
// privacy-requests reads it). Wording is a DRAFT until the lawyer edits it (owner, 8 October 2026).

/** The business's secret link: 64 base64url characters (only its SHA-256 is kept). */
export const PRIVACY_LINK_TOKEN = /^[A-Za-z0-9_-]{64}$/;

export const publicPrivacyPath = (token: string) => `/f/privacy/${token}`;
export const privacySubmitPath = (token: string) => `/api/forms/privacy/${token}`;

export const PRIVACY_REQUEST_TYPES = ["access", "correction", "erasure"] as const satisfies readonly PrivacyRequestType[];
export const PRIVACY_REQUEST_STATUSES = ["new", "verifying", "in_progress", "done", "refused"] as const satisfies readonly PrivacyRequestStatus[];
export const PRIVACY_VERIFY_METHODS = ["id_document", "known_details", "signed_form", "other"] as const satisfies readonly PrivacyVerifyMethod[];

/** What the person asks for (public page and staff screens). */
export const REQUEST_TYPE_LABELS: Record<PrivacyRequestType, string> = {
  access: "לעיין במידע שנשמר עליי",
  correction: "לתקן מידע שנשמר עליי",
  erasure: "למחוק מידע שנשמר עליי",
};

/** Short names for the staff list. */
export const REQUEST_TYPE_SHORT: Record<PrivacyRequestType, string> = {
  access: "עיון",
  correction: "תיקון",
  erasure: "מחיקה",
};

export const STATUS_LABELS: Record<PrivacyRequestStatus, string> = {
  new: "חדשה",
  verifying: "באימות זהות",
  in_progress: "בטיפול",
  done: "טופלה",
  refused: "נדחתה",
};

export const VERIFY_METHOD_LABELS: Record<PrivacyVerifyMethod, string> = {
  id_document: "הצגת תעודה מזהה",
  known_details: "פרטים שרק הפונה יודע",
  signed_form: "בקשה חתומה",
  other: "דרך אחרת",
};

/** Ready reasons for a refusal; "other" asks for the reason in words. Junk is refused, never deleted. */
export const REFUSAL_REASONS = ["לא ניתן לאמת את הזהות", "בקשה לא רצינית / ספאם"] as const;
export const OTHER_REFUSAL = "other";

/** The stored reason: a ready one, or the words typed for "other" (null = missing). */
export function refusalReasonFrom(choice: string, detail: string): string | null {
  if ((REFUSAL_REASONS as readonly string[]).includes(choice)) return choice;
  if (choice === OTHER_REFUSAL) return detail.trim() === "" ? null : detail.trim();
  return null;
}

export const NAME_MAX = 200;
export const CONTACT_MAX = 254;
export const DETAILS_MAX = 2000;
export const NOTE_MAX = 500;
/** The owner's 30-day count (hard rule 5, wave 3 use (3)). */
export const TARGET_DAYS = 30;

export const isClosed = (status: PrivacyRequestStatus) => status === "done" || status === "refused";

/** Overdue: still open after its target day (YYYY-MM-DD) in the business's zone. */
export function isOverdue(status: PrivacyRequestStatus, targetDate: string, today: string): boolean {
  return !isClosed(status) && targetDate < today;
}

/** Whole days from today to the target (negative = late). */
export function daysLeft(targetDate: string, today: string): number {
  const a = Date.parse(`${targetDate}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  return Math.round((a - b) / 86_400_000);
}

/** The line next to the target date in the list. */
export function targetLine(status: PrivacyRequestStatus, targetDate: string, today: string): string | null {
  if (isClosed(status)) return null;
  const left = daysLeft(targetDate, today);
  if (left < 0) return left === -1 ? "באיחור של יום" : `באיחור של ${-left} ימים`;
  if (left === 0) return "היום";
  return left === 1 ? "נשאר יום" : `נשארו ${left} ימים`;
}

/** The statuses a person may move to from here (closed = none; the database judges again). */
export function nextStatuses(status: PrivacyRequestStatus, verified: boolean): PrivacyRequestStatus[] {
  if (isClosed(status)) return [];
  const all: PrivacyRequestStatus[] = ["verifying", "in_progress", "done"];
  return all.filter((s) => s !== status && (verified || (s !== "in_progress" && s !== "done")));
}

const phoneOk = (value: string) => /^[0-9+() -]+$/.test(value) && value.replace(/\D/g, "").length >= 7 && value.replace(/\D/g, "").length <= 15;
const emailOk = (value: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);

/** What the public form sends; the same rules as public.privacy_request_submit. */
export const publicRequestSchema = z
  .object({
    request_type: z.enum(PRIVACY_REQUEST_TYPES, { message: "יש לבחור מה מבקשים." }),
    name: z.string().trim().min(1, "יש לכתוב שם.").max(NAME_MAX, "השם ארוך מדי."),
    contact_kind: z.enum(["email", "phone"], { message: "יש לבחור איך לחזור אליכם." }),
    contact_value: z.string().trim().min(1, "יש לכתוב איך לחזור אליכם.").max(CONTACT_MAX, "הפרט ארוך מדי."),
    details: z.string().trim().max(DETAILS_MAX, "הטקסט ארוך מדי.").optional().default(""),
  })
  .superRefine((value, ctx) => {
    if (value.contact_kind === "email" && !emailOk(value.contact_value)) {
      ctx.addIssue({ code: "custom", path: ["contact_value"], message: "כתובת האימייל אינה תקינה." });
    }
    if (value.contact_kind === "phone" && !phoneOk(value.contact_value)) {
      ctx.addIssue({ code: "custom", path: ["contact_value"], message: "מספר הטלפון אינו תקין." });
    }
  });
export type PublicRequest = z.infer<typeof publicRequestSchema>;

/** What the page shows: the business's display name and brand only. */
const pageSchema = z.object({
  business: z.string(),
  brand: z.object({ logo: z.string().nullable().optional(), color: z.string().nullable().optional() }),
  built_with: z.boolean().optional(),
});
export type PrivacyPage = { business: string; logoPath: string | null; color: string | null; builtWith: boolean };

export function privacyPageFrom(data: unknown): PrivacyPage | null {
  const parsed = pageSchema.safeParse(data);
  if (!parsed.success) return null;
  return {
    business: parsed.data.business,
    logoPath: parsed.data.brand.logo ?? null,
    color: parsed.data.brand.color ?? null,
    builtWith: parsed.data.built_with ?? true,
  };
}

/** The page's draft wording (DRAFT until the lawyer edits it). */
export const PUBLIC_TEXTS = {
  title: "בקשה בנושא פרטיות",
  intro:
    "כאן אפשר לבקש לעיין במידע שהעסק שומר עליכם, לתקן אותו או למחוק אותו. נחזור אליכם בדרך שתבחרו, ולפני הטיפול נבקש לוודא שהבקשה באמת שלכם.",
  received: "הבקשה התקבלה",
  receivedLine: "נחזור אליכם בדרך שבחרתם, תוך 30 יום ממועד קבלת הבקשה.",
  draft: "נוסח טיוטה, ממתין לעריכה משפטית.",
} as const;

/** PRK-02 (76) א: personal details are kept 12 months after closing (or after receipt, if never closed); mirrors
 * app.privacy_request_retention_months() in migration _privacy_request_retention.sql. */
export const RETENTION_MONTHS = 12;

/** The line shown in place of an emptied request's name: the retention job, or a privacy erasure of the linked record. */
export function erasedDetailsText(row: { erased_by_retention: boolean }): string {
  return row.erased_by_retention ? "פרטי הבקשה נמחקו לפי מדיניות השמירה" : "הפרטים נמחקו (מחיקת פרטיות)";
}
