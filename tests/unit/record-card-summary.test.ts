import { describe, expect, it } from "vitest";

import { agoText, buildSummaryView, dealLine, formatAmount, moreTasksText, nextActionHref, parseRecordSummary, pickNextAction } from "@/features/record-summary/summary";

const TZ = "Asia/Jerusalem";
// 12 October 2026, 10:00 in Jerusalem (UTC+3)
const NOW = new Date("2026-10-12T07:00:00Z");

describe("record card summary (REC-10)", () => {
  it("reads the function's JSON and ignores what is malformed", () => {
    const data = parseRecordSummary({
      deals: [
        { status: "won", currency: "ILS", count: 2, sum: 150000 },
        { status: "open", currency: "ILS", count: "1", sum: "5050" },
        { status: "lost", currency: "ILS", count: 9, sum: 1 },
        { status: "won" },
        "junk",
      ],
      last_touch: { type: "call", occurred_at: "2026-10-10T12:00:00Z" },
      next_task: { id: "t1", title: "להתקשר", task_type: "call", due_at: null },
      open_tasks: 3,
    });
    expect(data.deals).toEqual([
      { status: "won", currency: "ILS", count: 2, sum: 150000 },
      { status: "open", currency: "ILS", count: 1, sum: 5050 },
    ]);
    expect(data.lastTouch).toEqual({ type: "call", occurredAt: "2026-10-10T12:00:00Z" });
    expect(data.nextTask).toEqual({ id: "t1", title: "להתקשר", taskType: "call", dueAt: null });
    expect(data.openTasks).toBe(3);
    expect(parseRecordSummary(null)).toEqual({ deals: [], lastTouch: null, nextTask: null, openTasks: 0, nextMeeting: null });
  });

  it("formats agorot in the given currency, whole amounts without decimals", () => {
    expect(formatAmount(150000, "ILS")).toMatch(/1,500/);
    expect(formatAmount(150000, "ILS")).not.toMatch(/\.00/);
    expect(formatAmount(5050, "ILS")).toMatch(/50\.50/);
    expect(formatAmount(1000, "USD")).toMatch(/\$/);
    expect(formatAmount(1000, "NOPE!")).toBe("10 NOPE!");
  });

  it("never adds amounts in different currencies; the organization's currency comes first", () => {
    const line = dealLine(
      [
        { status: "open", currency: "USD", count: 1, sum: 10000 },
        { status: "open", currency: "ILS", count: 2, sum: 30000 },
        { status: "won", currency: "ILS", count: 5, sum: 1 },
      ],
      "open",
      "ILS",
    );
    expect(line?.count).toBe(3);
    expect(line?.countText).toBe("3 עסקאות");
    expect(line?.amounts).toHaveLength(2);
    expect(line?.amounts[0]).toMatch(/300/);
    expect(line?.amounts[1]).toMatch(/\$/);
    expect(dealLine([], "won", "ILS")).toBeNull();
    expect(dealLine([{ status: "won", currency: "ILS", count: 1, sum: 100 }], "won", "ILS")?.countText).toBe("עסקה אחת");
  });

  it("says how long ago by calendar days in the organization's zone", () => {
    expect(agoText("2026-10-12T05:00:00Z", NOW, TZ)).toBe("היום");
    // 23:30 on the 11th in Jerusalem is yesterday, though less than 24 hours ago
    expect(agoText("2026-10-11T20:30:00Z", NOW, TZ)).toBe("אתמול");
    expect(agoText("2026-10-10T08:00:00Z", NOW, TZ)).toBe("לפני יומיים");
    expect(agoText("2026-10-02T08:00:00Z", NOW, TZ)).toBe("לפני 10 ימים");
  });

  it("builds the card: last touch with its kind, next task overdue or not, and how many more", () => {
    const view = buildSummaryView(
      parseRecordSummary({
        deals: [{ status: "won", currency: "ILS", count: 1, sum: 100000 }],
        last_touch: { type: "whatsapp", occurred_at: "2026-10-11T09:00:00Z" },
        next_task: { id: "t1", title: "לשלוח הצעה", task_type: "todo", due_at: "2026-10-12T06:00:00Z" },
        open_tasks: 2,
      }),
      { currency: "ILS", timeZone: TZ, now: NOW },
    );
    expect(view.won?.countText).toBe("עסקה אחת");
    expect(view.open).toBeNull();
    expect(view.lastTouch).toMatchObject({ label: "WhatsApp", ago: "אתמול" });
    expect(view.lastTouch?.dateText).toMatch(/2026/);
    expect(view.nextTask).toMatchObject({ title: "לשלוח הצעה", overdue: true, moreCount: 1 });
    // 09:00 in Jerusalem, not 06:00 UTC
    expect(view.nextTask?.dateText).toMatch(/\b9:00/);

    const later = buildSummaryView(
      parseRecordSummary({ next_task: { id: "t2", title: "x", due_at: null }, open_tasks: 1 }),
      { currency: "ILS", timeZone: TZ, now: NOW },
    );
    expect(later.nextTask).toMatchObject({ overdue: false, dateText: null, moreCount: 0 });
    expect(later.lastTouch).toBeNull();
  });

  it("shows the next planned meeting as a next step too (RVW-1)", () => {
    const view = buildSummaryView(
      parseRecordSummary({ next_meeting: { id: "m1", title: "פגישת היכרות", starts_at: "2026-10-13T08:30:00Z" } }),
      { currency: "ILS", timeZone: TZ, now: NOW },
    );
    expect(view.nextTask).toBeNull();
    expect(view.nextMeeting).toMatchObject({ title: "פגישת היכרות", iso: "2026-10-13T08:30:00Z" });
    // 11:30 in Jerusalem
    expect(view.nextMeeting?.dateText).toMatch(/11:30/);
    expect(parseRecordSummary({ next_meeting: { id: "m1", title: "x" } }).nextMeeting).toBeNull();
  });

  describe("the next action: the task or the meeting that comes first", () => {
    const opts = { currency: "ILS", timeZone: TZ, now: NOW };
    const task = (due: string | null) => ({ id: "t1", title: "להתקשר", task_type: "call", due_at: due });
    const meeting = (start: string) => ({ id: "m1", title: "פגישת היכרות", starts_at: start });

    it("a meeting before the task's due time comes first", () => {
      const view = buildSummaryView(
        parseRecordSummary({ next_task: task("2026-10-14T08:00:00Z"), open_tasks: 3, next_meeting: meeting("2026-10-13T08:30:00Z") }),
        opts,
      );
      expect(view.nextAction).toMatchObject({ kind: "meeting", kindLabel: "פגישה", id: "m1", title: "פגישת היכרות", overdue: false });
      expect(view.nextAction?.dateText).toMatch(/11:30/);
      // all three open tasks are still waiting
      expect(view.otherOpenTasks).toBe(3);
    });

    it("a task due earlier comes first, overdue or not", () => {
      const soon = buildSummaryView(
        parseRecordSummary({ next_task: task("2026-10-12T09:00:00Z"), open_tasks: 2, next_meeting: meeting("2026-10-13T08:30:00Z") }),
        opts,
      );
      expect(soon.nextAction).toMatchObject({ kind: "task", kindLabel: "משימה", id: "t1", overdue: false });
      expect(soon.otherOpenTasks).toBe(1);
      const late = pickNextAction(parseRecordSummary({ next_task: task("2026-10-11T09:00:00Z"), next_meeting: meeting("2026-10-12T08:00:00Z") }), opts);
      expect(late).toMatchObject({ kind: "task", overdue: true });
    });

    it("an undated task comes after any meeting; on the same minute the meeting wins", () => {
      expect(pickNextAction(parseRecordSummary({ next_task: task(null), next_meeting: meeting("2027-01-01T08:00:00Z") }), opts)?.kind).toBe("meeting");
      expect(pickNextAction(parseRecordSummary({ next_task: task("2026-10-13T08:30:00Z"), next_meeting: meeting("2026-10-13T08:30:00Z") }), opts)?.kind).toBe(
        "meeting",
      );
      const alone = pickNextAction(parseRecordSummary({ next_task: task(null) }), opts);
      expect(alone).toMatchObject({ kind: "task", dateText: null, iso: null, overdue: false });
      expect(pickNextAction(parseRecordSummary({}), opts)).toBeNull();
      expect(buildSummaryView(parseRecordSummary({}), opts)).toMatchObject({ nextAction: null, otherOpenTasks: 0 });
    });

    it("links to its day in the calendar, everyone's items; an undated task to the tasks list", () => {
      const org = "00000000-0000-4000-8000-000000000001";
      // 23:30 UTC on the 12th is already the 13th in Jerusalem
      const evening = pickNextAction(parseRecordSummary({ next_meeting: meeting("2026-10-12T23:30:00Z") }), opts)!;
      expect(nextActionHref(org, evening, TZ)).toBe(`/o/${org}/calendar?view=day&date=2026-10-13&who=all`);
      const undated = pickNextAction(parseRecordSummary({ next_task: task(null) }), opts)!;
      expect(nextActionHref(org, undated, TZ)).toBe(`/o/${org}/tasks`);
    });

    it("counts the open tasks that are not shown", () => {
      expect(moreTasksText("task", 1)).toBe("ועוד משימה אחת");
      expect(moreTasksText("task", 4)).toBe("ועוד 4 משימות");
      expect(moreTasksText("meeting", 1)).toBe("ועוד משימה פתוחה אחת");
      expect(moreTasksText("meeting", 2)).toBe("ועוד 2 משימות פתוחות");
    });
  });
});
