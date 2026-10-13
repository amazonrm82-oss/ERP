import { describe, expect, it } from "vitest";

import { fromDbRule, toDbRule } from "@/features/automations/convert";
import { describeRule } from "@/features/automations/describe";
import type { Lookups } from "@/features/automations/queries";
import { ruleSchema } from "@/features/automations/schema";
import { addBusinessDays, BusinessDaysError, parseBusinessDays } from "@/features/calendar-days/business-days";
import { DEFAULT_CALENDAR_SETTINGS, holidaysOn, type CalendarSettings } from "@/features/calendar-days/holidays";

// HEB-03: "in N business days".
const NO_REST: CalendarSettings = { restWeekdays: [], holidaysRest: false, holidayEvesRest: false, restOccasions: [] };

describe("addBusinessDays", () => {
  it("Fri+Sat rest: Thursday + 1 business day is Sunday", () => {
    expect(addBusinessDays(DEFAULT_CALENDAR_SETTINGS, "2026-10-15", 1)).toBe("2026-10-18");
    expect(addBusinessDays(DEFAULT_CALENDAR_SETTINGS, "2026-10-15", 2)).toBe("2026-10-19");
    // from a rest day: the first working day after it counts as one
    expect(addBusinessDays(DEFAULT_CALENDAR_SETTINGS, "2026-10-16", 1)).toBe("2026-10-18");
  });

  it("n = 0 is the day itself when it is a working day, else the next working day", () => {
    expect(addBusinessDays(DEFAULT_CALENDAR_SETTINGS, "2026-10-15", 0)).toBe("2026-10-15");
    expect(addBusinessDays(DEFAULT_CALENDAR_SETTINGS, "2026-10-16", 0)).toBe("2026-10-18");
  });

  it("skips a holiday the business closes on, and counts it when it works then", () => {
    // Yom Kippur 5787 is Monday 21 September 2026
    expect(holidaysOn("2026-09-21").map((h) => h.key)).toContain("yom_kippur");
    expect(addBusinessDays(DEFAULT_CALENDAR_SETTINGS, "2026-09-20", 1)).toBe("2026-09-22");
    expect(addBusinessDays({ ...DEFAULT_CALENDAR_SETTINGS, holidaysRest: false }, "2026-09-20", 1)).toBe("2026-09-21");
  });

  it("a business without rest days counts calendar days", () => {
    for (const n of [0, 1, 3, 10, 60]) {
      const from = new Date(Date.UTC(2026, 9, 15 + n));
      expect(addBusinessDays(NO_REST, "2026-10-15", n)).toBe(from.toISOString().slice(0, 10));
    }
  });

  it("refuses a negative, fractional or too large number and a bad date", () => {
    expect(() => addBusinessDays(DEFAULT_CALENDAR_SETTINGS, "2026-10-15", -1)).toThrow(BusinessDaysError);
    expect(() => addBusinessDays(DEFAULT_CALENDAR_SETTINGS, "2026-10-15", 1.5)).toThrow(BusinessDaysError);
    expect(() => addBusinessDays(DEFAULT_CALENDAR_SETTINGS, "2026-10-15", 1001)).toThrow(BusinessDaysError);
    expect(() => addBusinessDays(DEFAULT_CALENDAR_SETTINGS, "15.10.2026", 1)).toThrow(BusinessDaysError);
  });

  it("the free number is a whole 1..60", () => {
    expect(parseBusinessDays("7")).toBe(7);
    expect(parseBusinessDays(" 60 ")).toBe(60);
    for (const bad of ["", "0", "61", "2.5", "-3", "abc", "1e1"]) expect(parseBusinessDays(bad)).toBeNull();
  });
});

const lookups: Lookups = { statuses: [], sources: [], tags: [], pipelines: [], members: [], teams: [], reasons: [] };
const rule = (action: Record<string, unknown>) => ({ name: "בדיקה", trigger: "lead:created", conditions: [], actions: [action] });
const task = (extra: Record<string, unknown>) => ({ type: "create_task", title: "להתקשר", assign: "owner", task_type: "call", ...extra });

describe("automation create_task due in business days", () => {
  it("toDbRule writes due_in_business_days, and only it", () => {
    const parsed = ruleSchema.parse(rule(task({ due_unit: "business_days", due_amount: "3" })));
    const db = toDbRule(parsed, lookups);
    expect(typeof db).toBe("object");
    if (typeof db === "string") return;
    expect(db.actions[0]).toEqual({ type: "create_task", title: "להתקשר", task_type: "call", assign: "owner", due_in_business_days: 3 });
  });

  it("refuses more than 60 business days", () => {
    expect(ruleSchema.safeParse(rule(task({ due_unit: "business_days", due_amount: "61" }))).success).toBe(false);
    expect(ruleSchema.safeParse(rule(task({ due_unit: "business_days", due_amount: "60" }))).success).toBe(true);
    expect(ruleSchema.safeParse(rule(task({ due_unit: "business_days", due_amount: "0" }))).success).toBe(true);
  });

  it("calendar days stay the default and are unchanged", () => {
    const db = toDbRule(ruleSchema.parse(rule(task({ due_unit: "days", due_amount: "3" }))), lookups);
    if (typeof db === "string") throw new Error(db);
    expect(db.actions[0]).toMatchObject({ due_in_days: 3 });
    expect(db.actions[0]).not.toHaveProperty("due_in_business_days");
  });

  it("a saved rule comes back to the builder and is described in Hebrew", () => {
    const actions = [{ type: "create_task", title: "להתקשר", task_type: "call", assign: "owner", due_in_business_days: 5 }];
    const back = fromDbRule({ name: "x", entity: "lead", triggerType: "created", triggerConfig: {}, conditions: [], actions });
    expect(back?.actions[0]).toMatchObject({ due_unit: "business_days", due_amount: "5" });
    const text = describeRule({ entity: "lead", triggerType: "created", triggerConfig: {}, conditions: [], actions }, lookups);
    expect(text.actions[0]).toContain("בעוד 5 ימי עסקים");
  });

  it("n = 0 reads as the next working day; a stored null is not a business-day rule", () => {
    const rule = (extra: Record<string, unknown>) => ({
      entity: "lead",
      triggerType: "created",
      triggerConfig: {},
      conditions: [],
      actions: [{ type: "create_task", title: "להתקשר", task_type: "call", assign: "owner", ...extra }],
    });
    expect(describeRule(rule({ due_in_business_days: 0 }), lookups).actions[0]).toContain("ביום העבודה הקרוב");
    const stored = describeRule(rule({ due_in_business_days: null }), lookups).actions[0];
    expect(stored).not.toContain("null");
    expect(stored).not.toContain("ימי עסקים");
    const back = fromDbRule({ name: "x", ...rule({ due_in_business_days: null }) });
    expect(back?.actions[0]).toMatchObject({ due_unit: "none" });
  });
});
