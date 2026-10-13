import { z } from "zod";

import { addDays } from "@/lib/calendar-grid";
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

/** The onboarding task's title until the user changes it. */
export function onboardingTitle(dealName: string): string {
  return `קליטת לקוח: ${dealName}`.slice(0, ONBOARDING_TITLE_MAX);
}

/** The onboarding task is due the next day by default. */
export function onboardingDueDate(today: string): string {
  return addDays(today, 1);
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

// what every close window of a page needs: who can take the onboarding task, and the organization's day
export type CloseWindowSetup = { owners: { value: string; label: string }[]; today: string; timeZone: string };

/** Built on the server for a page that may close deals: owners are the active members who write. */
export function closeWindowSetup(owners: { value: string; label: string }[], timeZone: string, now: Date = new Date()): CloseWindowSetup {
  return { owners, today: zoneDate(now, timeZone), timeZone };
}
