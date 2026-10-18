// PRM-02: view seats are free up to the plan's allowance per paid seat (view_seats_per_paid_seat x the full seats bought in
// the subscription; while none are bought, as on a trial, x the active full seats; owner, 18 October 2026).
// The database refuses an active view seat over it (app.assert_view_seat_available, hint
// 'limit:view_seats_per_paid_seat'); the screen counts pending viewer invitations too, so an invitation is not sent
// that could not be accepted.

/** limit: the allowance (null = no limit); used: active view seats; pending: open viewer invitations. */
export type ViewSeatUsage = { limit: number | null; used: number; pending: number };

/** How many more viewers may be invited now; null = no limit. */
export function viewSeatsLeft(usage: ViewSeatUsage): number | null {
  if (usage.limit === null) return null;
  return Math.max(0, usage.limit - usage.used - usage.pending);
}

/** The line under the invitation form. */
export function viewSeatsLine(usage: ViewSeatUsage): string {
  const pending = usage.pending > 0 ? ` ועוד ${usage.pending === 1 ? "הזמנה אחת ממתינה" : `${usage.pending} הזמנות ממתינות`}` : "";
  if (usage.limit === null) {
    return `מושבי צפייה בשימוש: ${usage.used}${pending}.`;
  }
  return `מושבי צפייה: ${usage.used} מתוך ${usage.limit}${pending}. המספר נקבע לפי מספר המושבים בתשלום.`;
}

export const NO_VIEW_SEAT_LEFT =
  "אין מושב צפייה פנוי. מספר מושבי הצפייה נקבע לפי מספר המושבים בתשלום, וההזמנות הממתינות נספרות. אפשר לבטל הזמנה ממתינה או להוסיף מושב בתשלום.";
