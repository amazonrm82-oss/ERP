import { describe, expect, it } from "vitest";

import { DEFAULT_CALENDAR_SETTINGS, type CalendarSettings } from "@/features/calendar-days/holidays";
import {
  amountInputValue,
  closeDateIsOld,
  closedAtFor,
  closeWindowSetup,
  entersWon,
  isOnboardingTitle,
  onboardingChoiceFromStored,
  onboardingChoiceKey,
  ONBOARDING_TITLE_MAX,
  onboardingDueDate,
  onboardingTitle,
  oldCloseDateQuestion,
  parseCloseWon,
  storedOnboardingChoice,
} from "@/features/deals/close-window";

const TODAY = "2026-10-13";
const ZONE = "Asia/Jerusalem";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

// DEAL-04: the close window of a deal that is won
describe("deal close window (DEAL-04)", () => {
  it("opens only when a deal enters a won stage", () => {
    expect(entersWon("open", "won")).toBe(true);
    expect(entersWon("lost", "won")).toBe(true);
    expect(entersWon(undefined, "won")).toBe(true);
    expect(entersWon("won", "won")).toBe(false);
    expect(entersWon("open", "lost")).toBe(false);
    expect(entersWon("won", "open")).toBe(false);
  });

  it("suggests an onboarding title from the deal's name, within the task's limit", () => {
    expect(onboardingTitle("אתר לחברת אורן")).toBe("קליטת לקוח: אתר לחברת אורן");
    expect(onboardingTitle("א".repeat(400))).toHaveLength(ONBOARDING_TITLE_MAX);
  });

  it("dates the onboarding task the next working day, across a month's end", () => {
    // Tuesday to Wednesday
    expect(onboardingDueDate(TODAY)).toBe("2026-10-14");
    // Thursday: Friday and Saturday are the default days off
    expect(onboardingDueDate("2026-10-15")).toBe("2026-10-18");
    // Friday 30 October to Sunday 1 November
    expect(onboardingDueDate("2026-10-30")).toBe("2026-11-01");
    // a Saturday close still lands on Sunday
    expect(onboardingDueDate("2026-10-31")).toBe("2026-11-01");
  });

  it("skips the holidays the business closes on, and only those", () => {
    // erev Rosh Hashana (Friday) -> Rosh Hashana on Saturday and Sunday -> Monday
    expect(onboardingDueDate("2026-09-11")).toBe("2026-09-14");
    // erev Pesach 2027 (Wednesday): Pesach Thursday, then the weekend; chol hamoed is a working day by default
    expect(onboardingDueDate("2027-04-21")).toBe("2027-04-25");
    // a business that closes on chol hamoed opens again on erev shvi'i shel Pesach (an eve is a working day by default)
    const cholHamoedOff: CalendarSettings = { ...DEFAULT_CALENDAR_SETTINGS, restOccasions: ["chol_hamoed_pesach"] };
    expect(onboardingDueDate("2027-04-21", cholHamoedOff)).toBe("2027-04-27");
    // eves off as well: Monday -> erev and shvi'i shel Pesach closed -> Thursday
    const evesOff: CalendarSettings = { ...DEFAULT_CALENDAR_SETTINGS, holidayEvesRest: true };
    expect(onboardingDueDate("2027-04-26", evesOff)).toBe("2027-04-29");
    // holidays not off: Pesach itself is a working day
    expect(onboardingDueDate("2027-04-21", { ...DEFAULT_CALENDAR_SETTINGS, holidaysRest: false })).toBe("2027-04-22");
  });

  it("follows the business's own weekly days off", () => {
    const saturdayOnly: CalendarSettings = { ...DEFAULT_CALENDAR_SETTINGS, restWeekdays: [6] };
    expect(onboardingDueDate("2026-10-15", saturdayOnly)).toBe("2026-10-16");
    expect(onboardingDueDate("2026-10-16", saturdayOnly)).toBe("2026-10-18");
    const noDaysOff: CalendarSettings = { restWeekdays: [], holidaysRest: false, holidayEvesRest: false, restOccasions: [] };
    expect(onboardingDueDate("2026-10-16", noDaysOff)).toBe("2026-10-17");
  });

  it("gives the window the next working day of the organization's day", () => {
    // Thursday 22:30 UTC is already Friday in Jerusalem: next working day is Sunday
    const setup = closeWindowSetup([], ZONE, DEFAULT_CALENDAR_SETTINGS, "u1", new Date("2026-10-15T22:30:00Z"));
    expect(setup.today).toBe("2026-10-16");
    expect(setup.nextWorkingDay).toBe("2026-10-18");
    expect(setup.userId).toBe("u1");
  });

  it("recognises an onboarding task by its title prefix", () => {
    expect(isOnboardingTitle(onboardingTitle("אתר"))).toBe(true);
    expect(isOnboardingTitle("קליטת לקוח: משהו אחר")).toBe(true);
    expect(isOnboardingTitle("להתקשר ללקוח")).toBe(false);
    expect(isOnboardingTitle("קליטת לקוח")).toBe(false);
  });

  it("starts checked unless this user last chose not to create the task", () => {
    expect(onboardingChoiceFromStored(null)).toBe(true);
    expect(onboardingChoiceFromStored(undefined)).toBe(true);
    expect(onboardingChoiceFromStored("garbage")).toBe(true);
    expect(onboardingChoiceFromStored(storedOnboardingChoice(true))).toBe(true);
    expect(onboardingChoiceFromStored(storedOnboardingChoice(false))).toBe(false);
  });

  it("keeps the choice per user and organization", () => {
    const key = onboardingChoiceKey("org-1", "user-1");
    expect(key).not.toBe(onboardingChoiceKey("org-1", "user-2"));
    expect(key).not.toBe(onboardingChoiceKey("org-2", "user-1"));
  });

  it("asks before saving a close date more than three calendar months back", () => {
    // three months before 13 October is 13 July: that day is fine, the day before asks
    expect(closeDateIsOld("2026-07-13", TODAY)).toBe(false);
    expect(closeDateIsOld("2026-07-12", TODAY)).toBe(true);
    expect(closeDateIsOld(TODAY, TODAY)).toBe(false);
    expect(closeDateIsOld("2020-01-01", TODAY)).toBe(true);
    // month ends: 31 May -> 28 February; 31 March -> 31 December; a leap year's 29 February
    expect(closeDateIsOld("2026-02-28", "2026-05-31")).toBe(false);
    expect(closeDateIsOld("2026-02-27", "2026-05-31")).toBe(true);
    expect(closeDateIsOld("2025-12-31", "2026-03-31")).toBe(false);
    expect(closeDateIsOld("2025-12-30", "2026-03-31")).toBe(true);
    expect(closeDateIsOld("2028-02-29", "2028-05-31")).toBe(false);
    expect(closeDateIsOld("2028-02-28", "2028-05-31")).toBe(true);
    // no lower limit otherwise, and nothing to ask about a malformed day
    expect(closeDateIsOld("", TODAY)).toBe(false);
  });

  it("words the question with the day in Hebrew", () => {
    expect(oldCloseDateQuestion("2026-07-09")).toBe("תאריך הסגירה הוא 9 ביולי 2026, לפני יותר מ-3 חודשים. לשמור?");
  });

  it("shows the amount as the deal form does", () => {
    expect(amountInputValue(1_250_000)).toBe("12500");
    expect(amountInputValue(1_250_050)).toBe("12500.50");
    expect(amountInputValue(0)).toBe("0");
  });

  it("stores today as the real moment, and another day at midday in the organization's zone", () => {
    const now = new Date("2026-10-13T08:15:00Z");
    expect(closedAtFor(TODAY, TODAY, now, ZONE)).toBe(now.toISOString());
    // 12:00 in Jerusalem on 1 October 2026 (summer time, UTC+3)
    expect(closedAtFor("2026-10-01", TODAY, now, ZONE)).toBe("2026-10-01T09:00:00.000Z");
    // winter time (UTC+2)
    expect(closedAtFor("2026-01-15", TODAY, now, ZONE)).toBe("2026-01-15T10:00:00.000Z");
  });

  it("takes the organization's day for today", () => {
    // 22:30 UTC is already the next day in Jerusalem
    const setup = closeWindowSetup([], ZONE, DEFAULT_CALENDAR_SETTINGS, "u1", new Date("2026-10-13T22:30:00Z"));
    expect(setup.today).toBe("2026-10-14");
    expect(closeWindowSetup([], "UTC", DEFAULT_CALENDAR_SETTINGS, "u1", new Date("2026-10-13T22:30:00Z")).today).toBe("2026-10-13");
  });

  it("confirms amount and date without a task", () => {
    const parsed = parseCloseWon(form({ amount: "12,500", closed_date: TODAY }), TODAY);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ amount: 1_250_000, closedDate: TODAY, task: null });
  });

  it("ignores the task fields while the task is not asked for", () => {
    const parsed = parseCloseWon(form({ amount: "0", closed_date: "2026-09-30", task_title: "" }), TODAY);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.task).toBeNull();
  });

  it("needs a close date, not in the future", () => {
    const missing = parseCloseWon(form({ amount: "100", closed_date: "" }), TODAY);
    expect(missing.success).toBe(false);
    expect(missing.error?.issues.map((i) => i.path[0])).toEqual(["closed_date"]);

    const future = parseCloseWon(form({ amount: "100", closed_date: "2026-10-14" }), TODAY);
    expect(future.success).toBe(false);
    expect(future.error?.issues[0]?.message).toBe("תאריך הסגירה לא יכול להיות בעתיד.");

    const bad = parseCloseWon(form({ amount: "100", closed_date: "2026-02-30" }), TODAY);
    expect(bad.success).toBe(false);
  });

  it("rejects an amount that is not money", () => {
    const parsed = parseCloseWon(form({ amount: "שלושה", closed_date: TODAY }), TODAY);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path[0]).toBe("amount");
  });

  it("builds the onboarding task when asked", () => {
    const owner = "8f0d7c4e-2b1a-4c3d-9e8f-1a2b3c4d5e6f";
    const parsed = parseCloseWon(
      form({ amount: "5000", closed_date: TODAY, onboarding: "on", task_title: "  שיחת פתיחה  ", task_due_date: "2026-10-14", task_owner_id: owner }),
      TODAY,
    );
    expect(parsed.success).toBe(true);
    expect(parsed.data?.task).toEqual({ title: "שיחת פתיחה", dueDate: "2026-10-14", ownerId: owner });
  });

  it("lets the task go without a date or an owner, but not without a title", () => {
    const loose = parseCloseWon(form({ amount: "5000", closed_date: TODAY, onboarding: "on", task_title: "קליטה" }), TODAY);
    expect(loose.data?.task).toEqual({ title: "קליטה", dueDate: null, ownerId: null });

    const untitled = parseCloseWon(form({ amount: "5000", closed_date: TODAY, onboarding: "on", task_title: " " }), TODAY);
    expect(untitled.success).toBe(false);
    expect(untitled.error?.issues[0]?.path[0]).toBe("task_title");

    const badOwner = parseCloseWon(form({ amount: "5000", closed_date: TODAY, onboarding: "on", task_title: "קליטה", task_owner_id: "x" }), TODAY);
    expect(badOwner.success).toBe(false);
  });
});
