import { z } from "zod";

import { type CalendarSettings, DEFAULT_CALENDAR_SETTINGS, isRestDay } from "@/features/calendar-days/holidays";
import { addDays, addMonths, MONTHS } from "@/lib/calendar-grid";
import { isCalendarDate } from "@/lib/calendar-date";
import { zoneDate, zonedIso } from "@/lib/format";
import type { StageKind } from "@/lib/database.types";
import { checkbox, moneyField, optionalDate, optionalId, pick, requiredText } from "@/lib/validation";

/**
 * DEAL-04, the close window. A deal that moves into a won stage first confirms
 * its amount and close date, and may get an onboarding task ("משימת קליטה").
 * Later waves add an order, a document and a project to "what next".
 */

/** The window opens only when a deal enters a won stage; won to another won stage is a plain move. */
export function entersWon(fromKind: StageKind | null | undefined, toKind: StageKind | null | undefined): boolean {
  return toKind === "won" && fromKind !== "won";
}

export const ONBOARDING_TITLE_MAX = 300;

/**
 * How an onboarding task is recognised: tasks have no marker column, so an
 * onboarding task is an open task (status open, not deleted) linked to the deal
 * whose title starts with this prefix. A title edited away from the prefix is no
 * longer one (owner's answer of 13 October 2026: one open onboarding task per deal).
 */
export const ONBOARDING_PREFIX = "קליטת לקוח:";

/** Shown instead of the checkbox when the deal has an open onboarding task. */
export const ONBOARDING_EXISTS = "יש כבר משימת קליטה פתוחה לעסקה, לכן לא תיווצר משימה נוספת.";

/** The onboarding task's title until the user changes it. */
export function onboardingTitle(dealName: string): string {
  return `${ONBOARDING_PREFIX} ${dealName}`.slice(0, ONBOARDING_TITLE_MAX);
}

/** Does a task title mark an onboarding task (see ONBOARDING_PREFIX; titles are stored trimmed, the server matches with like). */
export function isOnboardingTitle(title: string): boolean {
  return title.startsWith(ONBOARDING_PREFIX);
}

/** The longest run of days off searched for the next working day; past it, plain tomorrow. */
const MAX_DAYS_OFF = 60;

/**
 * The onboarding task is due the next working day of the business: the first
 * day after today that is not a weekly rest day nor a holiday or occasion it
 * closes on (CAL-03 settings).
 */
export function onboardingDueDate(today: string, calendar: CalendarSettings = DEFAULT_CALENDAR_SETTINGS): string {
  let day = addDays(today, 1);
  for (let i = 0; i < MAX_DAYS_OFF; i++) {
    if (!isRestDay(day, calendar)) return day;
    day = addDays(day, 1);
  }
  return addDays(today, 1);
}

/**
 * The user's last choice of the onboarding checkbox is kept per device, per user
 * and organization (browser storage). A new user, or a browser without storage,
 * starts checked (owner's answer, 13 October 2026).
 */
export function onboardingChoiceKey(orgId: string, userId: string): string {
  return `crm:deal-won-onboarding:${orgId}:${userId}`;
}

export function onboardingChoiceFromStored(stored: string | null | undefined): boolean {
  return stored !== "off";
}

export function storedOnboardingChoice(checked: boolean): "on" | "off" {
  return checked ? "on" : "off";
}

/**
 * A close date may be any past day (no lower limit by the deal's creation: deals
 * entered or imported later really closed earlier), but one more than three
 * calendar months before today asks for confirmation first (owner's answer,
 * 13 October 2026). App side only. Both days are the organization's calendar days.
 */
export const OLD_CLOSE_MONTHS = 3;

export function closeDateIsOld(day: string, today: string): boolean {
  return isCalendarDate(day) && isCalendarDate(today) && day < addMonths(today, -OLD_CLOSE_MONTHS);
}

/** "תאריך הסגירה הוא 9 ביולי 2026, לפני יותר מ-3 חודשים. לשמור?" */
export function oldCloseDateQuestion(day: string): string {
  const shown = `${Number(day.slice(8, 10))} ב${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
  return `תאריך הסגירה הוא ${shown}, לפני יותר מ-${OLD_CLOSE_MONTHS} חודשים. לשמור?`;
}

/**
 * The instant stored in closed_at for a picked day: now when the day is today
 * (so the time is real), else midday of that day in the organization's zone,
 * which keeps the day the same in every report of that zone.
 */
export function closedAtFor(day: string, today: string, now: Date, timeZone: string): string {
  return day === today ? now.toISOString() : zonedIso(day, "12:00:00", timeZone);
}

export const CLOSE_WON_FIELD_NAMES = ["amount", "closed_date", "onboarding", "task_title", "task_due_date", "task_owner_id"] as const;

const CLOSED_DATE_MISSING = "יש לבחור תאריך סגירה.";

/** The close window's form; today is the organization's calendar day. */
export function closeWonSchema(today: string) {
  return z
    .object({
      amount: moneyField,
      closed_date: optionalDate,
      onboarding: checkbox,
      // checked only when the task is asked for (below)
      task_title: z.unknown(),
      task_due_date: optionalDate,
      task_owner_id: optionalId,
    })
    .superRefine((form, ctx) => {
      if (form.closed_date === null) {
        ctx.addIssue({ code: "custom", path: ["closed_date"], message: CLOSED_DATE_MISSING });
      } else if (form.closed_date > today) {
        ctx.addIssue({ code: "custom", path: ["closed_date"], message: "תאריך הסגירה לא יכול להיות בעתיד." });
      }
    })
    .transform((form, ctx) => {
      if (!form.onboarding) {
        return { amount: form.amount, closedDate: form.closed_date as string, task: null };
      }
      const title = requiredText(ONBOARDING_TITLE_MAX, "יש לכתוב מה צריך לעשות.", "הכותרת ארוכה מדי (עד 300 תווים).").safeParse(form.task_title);
      if (!title.success) {
        ctx.addIssue({ code: "custom", path: ["task_title"], message: title.error.issues[0]?.message ?? "הכותרת אינה תקינה." });
        return z.NEVER;
      }
      return {
        amount: form.amount,
        closedDate: form.closed_date as string,
        task: { title: title.data, dueDate: form.task_due_date, ownerId: form.task_owner_id },
      };
    });
}

export type CloseWon = z.output<ReturnType<typeof closeWonSchema>>;

export function parseCloseWon(formData: FormData, today: string) {
  return closeWonSchema(today).safeParse(pick(formData, CLOSE_WON_FIELD_NAMES));
}

/** Agorot as the amount field shows them: "12500" or "12500.50". */
export function amountInputValue(agorot: number): string {
  return agorot % 100 === 0 ? String(agorot / 100) : (agorot / 100).toFixed(2);
}

// what every close window of a page needs: who can take the onboarding task, the organization's day,
// its next working day (the task's default due date), and whose last choice to remember
export type CloseWindowSetup = {
  owners: { value: string; label: string }[];
  today: string;
  nextWorkingDay: string;
  timeZone: string;
  userId: string;
};

/** Built on the server for a page that may close deals: owners are the active members who write. */
export function closeWindowSetup(
  owners: { value: string; label: string }[],
  timeZone: string,
  calendar: CalendarSettings,
  userId: string,
  now: Date = new Date(),
): CloseWindowSetup {
  const today = zoneDate(now, timeZone);
  return { owners, today, nextWorkingDay: onboardingDueDate(today, calendar), timeZone, userId };
}
