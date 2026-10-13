import { describe, expect, it } from "vitest";

import {
  amountInputValue,
  closedAtFor,
  closeWindowSetup,
  entersWon,
  ONBOARDING_TITLE_MAX,
  onboardingDueDate,
  onboardingTitle,
  parseCloseWon,
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

  it("dates the onboarding task the next day, across a month's end", () => {
    expect(onboardingDueDate(TODAY)).toBe("2026-10-14");
    expect(onboardingDueDate("2026-10-31")).toBe("2026-11-01");
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
    const setup = closeWindowSetup([], ZONE, new Date("2026-10-13T22:30:00Z"));
    expect(setup.today).toBe("2026-10-14");
    expect(closeWindowSetup([], "UTC", new Date("2026-10-13T22:30:00Z")).today).toBe("2026-10-13");
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
