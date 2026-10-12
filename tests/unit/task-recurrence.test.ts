import { describe, expect, it } from "vitest";

import { describeRecurrence, nextDate, nextTask, parseRecurrence, repeatFormSchema, repeatValues, type Recurrence } from "@/features/tasks/recurrence";

// TASK-04: mirrors app.recurrence_next_date() / app.spawn_recurring_task() (tests/db/53-recurring-tasks.test.ts)
describe("nextDate", () => {
  it("daily is the next day, across month and year ends", () => {
    expect(nextDate({ kind: "daily" }, "2030-01-31")).toBe("2030-02-01");
    expect(nextDate({ kind: "daily" }, "2030-12-31")).toBe("2031-01-01");
  });

  it("weekly is the next chosen weekday (0 = Sunday)", () => {
    // 1.1.2030 is a Tuesday
    expect(nextDate({ kind: "weekly", weekdays: [0, 3] }, "2030-01-01")).toBe("2030-01-02");
    expect(nextDate({ kind: "weekly", weekdays: [0, 3] }, "2030-01-02")).toBe("2030-01-06");
    expect(nextDate({ kind: "weekly", weekdays: [2] }, "2030-01-01")).toBe("2030-01-08");
  });

  it("monthly clamps to the month's last day and comes back to the chosen day", () => {
    expect(nextDate({ kind: "monthly", day: 31 }, "2031-01-31")).toBe("2031-02-28");
    expect(nextDate({ kind: "monthly", day: 31 }, "2031-02-28")).toBe("2031-03-31");
    expect(nextDate({ kind: "monthly", day: 30 }, "2032-01-30")).toBe("2032-02-29");
    expect(nextDate({ kind: "monthly", day: 15 }, "2030-01-10")).toBe("2030-01-15");
    expect(nextDate({ kind: "monthly", day: 15 }, "2030-12-15")).toBe("2031-01-15");
  });

  it("after completion adds the days", () => {
    expect(nextDate({ kind: "after_done", days: 3 }, "2030-02-27")).toBe("2030-03-02");
  });
});

describe("nextTask", () => {
  const now = new Date("2030-01-01T10:00:00Z");

  it("keeps 09:00 local across the clock changes in Jerusalem", () => {
    // summer time ends on 27.10.2030 and starts on 29.3.2030
    const autumn = nextTask({ kind: "daily" }, { dueAt: "2030-10-26T06:00:00Z", remindAt: "2030-10-26T05:45:00Z" }, now, "Asia/Jerusalem");
    expect(autumn).toEqual({ dueAt: "2030-10-27T07:00:00.000Z", remindAt: "2030-10-27T06:45:00.000Z", recurrence: { kind: "daily" } });
    const spring = nextTask({ kind: "daily" }, { dueAt: "2030-03-28T07:00:00Z", remindAt: null }, now, "Asia/Jerusalem");
    expect(spring?.dueAt).toBe("2030-03-29T06:00:00.000Z");
  });

  it("uses the given zone", () => {
    const next = nextTask({ kind: "daily" }, { dueAt: "2030-11-02T13:00:00Z", remindAt: null }, now, "America/New_York");
    expect(next?.dueAt).toBe("2030-11-03T14:00:00.000Z");
  });

  it("a late completion continues from today; after completion counts from today", () => {
    const late = nextTask({ kind: "daily" }, { dueAt: "2029-12-20T07:00:00Z", remindAt: null }, now, "Asia/Jerusalem");
    expect(late?.dueAt).toBe("2030-01-01T07:00:00.000Z");
    const after = nextTask({ kind: "after_done", days: 3 }, { dueAt: "2035-01-01T12:00:00Z", remindAt: null }, now, "Asia/Jerusalem");
    expect(after?.dueAt).toBe("2030-01-04T12:00:00.000Z");
    // no due date: today, 09:00
    expect(nextTask({ kind: "after_done", days: 1 }, { dueAt: null, remindAt: null }, now, "Asia/Jerusalem")?.dueAt).toBe("2030-01-02T07:00:00.000Z");
  });

  it("ends at the end date or after the count", () => {
    expect(nextTask({ kind: "daily", until: "2030-05-01" }, { dueAt: "2030-05-01T06:00:00Z", remindAt: null }, now)).toBeNull();
    expect(nextTask({ kind: "daily", until: "2030-05-02" }, { dueAt: "2030-05-01T06:00:00Z", remindAt: null }, now)?.recurrence).toEqual({ kind: "daily", until: "2030-05-02" });
    expect(nextTask({ kind: "daily", left: 2 }, { dueAt: "2030-05-01T06:00:00Z", remindAt: null }, now)?.recurrence).toEqual({ kind: "daily", left: 1 });
    expect(nextTask({ kind: "daily", left: 1 }, { dueAt: "2030-05-01T06:00:00Z", remindAt: null }, now)?.recurrence).toBeNull();
  });
});

describe("the stored rule", () => {
  it("accepts what the database accepts and nothing else", () => {
    expect(parseRecurrence({ kind: "weekly", weekdays: [0, 6] })).toEqual({ kind: "weekly", weekdays: [0, 6] });
    expect(parseRecurrence({ kind: "monthly", day: 1, until: "2031-02-28", left: 999 })).not.toBeNull();
    for (const bad of [null, "daily", { kind: "yearly" }, { kind: "weekly", weekdays: [] }, { kind: "weekly", weekdays: [7] }, { kind: "monthly", day: 32 }, { kind: "monthly", day: 1.5 }, { kind: "after_done", days: 0 }, { kind: "daily", until: "2030-02-30" }, { kind: "daily", left: 0 }, { kind: "daily", extra: 1 }]) {
      expect(parseRecurrence(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("reads as Hebrew", () => {
    expect(describeRecurrence({ kind: "daily" })).toBe("כל יום");
    expect(describeRecurrence({ kind: "weekly", weekdays: [3, 0] })).toBe("כל שבוע בימים א׳, ד׳");
    expect(describeRecurrence({ kind: "monthly", day: 15, until: "2031-02-03" })).toBe("כל חודש ב-15, עד 3.2.2031");
    expect(describeRecurrence({ kind: "after_done", days: 3, left: 2 })).toBe("3 ימים אחרי ההשלמה, עוד 2 פעמים");
  });
});

describe("the form", () => {
  const parse = (values: Record<string, string>) => repeatFormSchema.safeParse(values);

  it("builds the rule from the chosen kind only", () => {
    expect(parse({ repeat: "none", repeat_days: "x" }).data).toBeNull();
    expect(parse({}).data).toBeNull();
    expect(parse({ repeat: "weekly", repeat_weekdays: "3,0,3", repeat_day: "x" }).data).toEqual({ kind: "weekly", weekdays: [0, 3] });
    expect(parse({ repeat: "monthly", repeat_day: "31", repeat_end: "count", repeat_count: "5" }).data).toEqual({ kind: "monthly", day: 31, left: 5 });
    expect(parse({ repeat: "after_done", repeat_days: "7", repeat_end: "until", repeat_until: "2031-01-01" }).data).toEqual({ kind: "after_done", days: 7, until: "2031-01-01" });
  });

  it("says what is missing, on the right field", () => {
    const field = (values: Record<string, string>) => parse(values).error?.issues[0]?.path[0];
    expect(field({ repeat: "weekly", repeat_weekdays: "" })).toBe("repeat_weekdays");
    expect(field({ repeat: "monthly", repeat_day: "0" })).toBe("repeat_day");
    expect(field({ repeat: "after_done", repeat_days: "" })).toBe("repeat_days");
    expect(field({ repeat: "daily", repeat_end: "until", repeat_until: "2031-02-30" })).toBe("repeat_until");
    expect(field({ repeat: "daily", repeat_end: "count", repeat_count: "1000" })).toBe("repeat_count");
  });

  it("round-trips a saved rule through the form", () => {
    const rules: Recurrence[] = [{ kind: "daily" }, { kind: "weekly", weekdays: [1, 4] }, { kind: "monthly", day: 30, until: "2031-06-30" }, { kind: "after_done", days: 2, left: 3 }];
    for (const rule of rules) {
      const values = Object.fromEntries(Object.entries(repeatValues(rule)).map(([k, v]) => [k, v ?? ""]));
      expect(parse(values).data).toEqual(rule);
    }
  });
});
