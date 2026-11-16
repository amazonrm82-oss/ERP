// USR-09 (review fix 3): the line under a pending invitation about its latest email. Pure. The composer mints a new token
// before the email goes out, so a send that failed after composing left the earlier link dead: the screen says so.

export type InvitationEmailState = "sent" | "waiting" | "failed";

export type InvitationEmailStatus = { state: InvitationEmailState; composed: boolean; whenText: string };

export const FAILED_AFTER_COMPOSE = "השליחה נכשלה; הקישור הקודם כבר לא פעיל — שלחו שוב או צרו הזמנה חדשה";
export const FAILED_BEFORE_COMPOSE = "השליחה נכשלה; שלחו שוב או צרו הזמנה חדשה";

/** The line for the latest email of an invitation; null when it was never sent by email. */
export function invitationEmailLine(status: InvitationEmailStatus | null): string | null {
  if (!status) return null;
  switch (status.state) {
    case "sent":
      return `נשלחה במייל ב-${status.whenText}`;
    case "waiting":
      // delta review 2: an attempt that already minted the link (a retry after a failure) left the earlier link dead
      return status.composed ? `נשלחת במייל (התבקשה ב-${status.whenText}). הקישור הקודם כבר לא פעיל.` : `נשלחת במייל (התבקשה ב-${status.whenText})`;
    case "failed":
      return status.composed ? FAILED_AFTER_COMPOSE : FAILED_BEFORE_COMPOSE;
  }
}

/** One row of public.invitation_email_status, or null for a shape that is not its own. */
export function parseInvitationEmailStatus(row: unknown): ({ invitationId: string; lastRequestedAt: string } & Omit<InvitationEmailStatus, "whenText">) | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const r = row as Record<string, unknown>;
  if (typeof r.invitation_id !== "string" || typeof r.last_requested_at !== "string") return null;
  if (r.state !== "sent" && r.state !== "waiting" && r.state !== "failed") return null;
  return { invitationId: r.invitation_id, lastRequestedAt: r.last_requested_at, state: r.state, composed: r.composed === true };
}
