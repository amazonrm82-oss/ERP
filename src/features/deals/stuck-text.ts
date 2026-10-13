// Words for a row of public.report_stuck_deals (owner's decision, 13 October 2026, DEAL-01):
// a deal is stuck by time in its stage; every row also says when the last activity was.
// No server imports, so unit tests and client code can use it.

import { formatDate } from "@/lib/format";

export type StuckRow = {
  id: string;
  stuck: boolean;
  // would be stuck, but postponed to a day after today
  postponed?: boolean;
  snoozed_until?: string | null;
  days_in_stage: number;
  limit_days: number;
  last_activity_at: string | null;
  idle_days: number;
  no_next_step: boolean;
};

/** What the board and the deal page show about an open deal that needs attention. */
export type StuckInfo = {
  // stuck by time in stage
  stuck: boolean;
  // would be stuck, postponed to a later day
  postponed: boolean;
  noNextStep: boolean;
  text: string;
};

const whole = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0);

/** "פעילות אחרונה היום" / "פעילות אחרונה לפני 5 ימים" / "אין פעילות" */
export function lastActivityText(row: Pick<StuckRow, "last_activity_at" | "idle_days">, format: (n: number) => string): string {
  if (!row.last_activity_at) return "אין פעילות";
  const days = whole(row.idle_days);
  if (days === 0) return "פעילות אחרונה היום";
  if (days === 1) return "פעילות אחרונה לפני יום אחד";
  return `פעילות אחרונה לפני ${format(days)} ימים`;
}

/** Why an open deal needs attention, in words; the board and the deal page show it. */
export function stuckReason(
  row: Pick<StuckRow, "stuck" | "postponed" | "snoozed_until" | "days_in_stage" | "limit_days" | "last_activity_at" | "idle_days" | "no_next_step">,
  format: (n: number) => string,
): string {
  const parts: string[] = [];
  if (row.stuck) {
    parts.push(`${format(whole(row.days_in_stage))} ימים בשלב (מעל ${format(whole(row.limit_days))})`);
  }
  if (row.postponed && row.snoozed_until) parts.push(`נדחתה עד ${formatDate(row.snoozed_until)}`);
  if (row.no_next_step) parts.push("אין משימה או פגישה");
  parts.push(lastActivityText(row, format));
  return parts.join(" · ");
}
