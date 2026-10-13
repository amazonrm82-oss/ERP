// CAP-09: a leave is a date range per member, both ends included, at most a
// year long (member_leaves_range in the migration).
import { isCalendarDate } from "@/lib/calendar-date";
import { addDays } from "@/lib/calendar-grid";

export const MAX_LEAVE_DAYS = 366;

export type LeaveResult = { ok: true; startsOn: string; endsOn: string } | { ok: false; field: "starts_on" | "ends_on"; message: string };

/** The two dates of the leave form ("YYYY-MM-DD"); a missing end is a one-day leave. */
export function parseLeave(startsOn: unknown, endsOn: unknown): LeaveResult {
  if (typeof startsOn !== "string" || !isCalendarDate(startsOn)) {
    return { ok: false, field: "starts_on", message: "יש לבחור את היום הראשון של החופשה." };
  }
  const end = typeof endsOn === "string" && endsOn !== "" ? endsOn : startsOn;
  if (!isCalendarDate(end)) {
    return { ok: false, field: "ends_on", message: "יש לבחור את היום האחרון של החופשה." };
  }
  if (end < startsOn) {
    return { ok: false, field: "ends_on", message: "היום האחרון צריך להיות אחרי היום הראשון, או באותו יום." };
  }
  if (end > addDays(startsOn, MAX_LEAVE_DAYS - 1)) {
    return { ok: false, field: "ends_on", message: "חופשה אחת יכולה להימשך עד שנה. לחופשה ארוכה יותר הוסיפו עוד אחת." };
  }
  return { ok: true, startsOn, endsOn: end };
}

/** Is the day inside one of the leaves? */
export function onLeave(day: string, leaves: readonly { startsOn: string; endsOn: string }[]): boolean {
  return leaves.some((leave) => day >= leave.startsOn && day <= leave.endsOn);
}
