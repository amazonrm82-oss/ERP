import { describe, expect, it } from "vitest";

import { agoText, buildSummaryView, dealLine, formatAmount, parseRecordSummary } from "@/features/record-summary/summary";

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
});
