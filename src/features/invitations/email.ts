// USR-09 (owner (387) א): the fixed text of a staff invitation email. Pure. A service text the business cannot edit; the
// wording is a DRAFT until the owner approves it (INVITATION_EMAIL_WORDING names the version).

import { ROLE_LABELS } from "@/features/shell/labels";
import type { MembershipRole } from "@/lib/database.types";

export const INVITATION_EMAIL_WORDING = "invite-draft-1";

/** The word the composer sends instead of a business name that holds a link, an "@" or a "://" (delta review 1b). */
export const NEUTRAL_BUSINESS_NAME = "העסק";

export type InvitationEmailInput = {
  businessName: string;
  role: MembershipRole;
  /** when the invitation ends (ISO) */
  expiresAt: string;
  /** the absolute join link the composer's new token makes */
  link: string;
};

export type InvitationEmail = { subject: string; text: string; links: string[] };

function cleanName(name: string): string {
  const flat = name.replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
  return (flat || "העסק").slice(0, 80);
}

/** The end of the invitation, as a date in Israel ("23 בנובמבר 2026"); null for anything else. */
export function invitationExpiryLabel(iso: string): string | null {
  const date = new Date(iso);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(iso) || Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Jerusalem" }).format(date);
}

export function buildInvitationEmail(input: InvitationEmailInput): InvitationEmail | null {
  const until = invitationExpiryLabel(input.expiresAt);
  const role = ROLE_LABELS[input.role];
  if (!until || !role || input.role === "owner") return null;
  const business = cleanName(input.businessName);
  const neutral = business === NEUTRAL_BUSINESS_NAME;
  const subject = (neutral ? "הזמנה להצטרף לעסק במקסוז" : `הזמנה להצטרף ל${business} במקסוז`).slice(0, 255);
  const text = [
    "שלום,",
    neutral ? `הוזמנת להצטרף לעסק במערכת מקסוז, בתפקיד ${role}.` : `הוזמנת להצטרף לעסק ${business} במערכת מקסוז, בתפקיד ${role}.`,
    "",
    `להצטרפות: ${input.link}`,
    `הקישור בתוקף עד ${until}, ומתאים רק לכתובת המייל הזו.`,
    "",
    "אם לא ציפית להזמנה הזו, אפשר להתעלם מהמייל.",
    "—",
    neutral ? "המייל נשלח ממקסוז לבקשת העסק. אין להשיב למייל הזה." : `המייל נשלח ממקסוז לבקשת ${business}. אין להשיב למייל הזה.`,
  ].join("\n");
  return { subject, text, links: [input.link] };
}
