import { describe, expect, it } from "vitest";

import {
  calendarDateText,
  countsDeals,
  goalDealsHref,
  goalPeriodOf,
  paceFromText,
  paceStartDay,
  periodEndLabel,
  periodLabel,
  progressFigures,
  reportGoalPeriod,
  requiredPerDayText,
  requiredPerDayValue,
  teamSubtree,
} from "@/features/goals/progress";

// GOL-03: percent, linear pace and what is needed per day. Owner, 13 October 2026: the pace shows
// only from a quarter of the period's calendar days (rounded up); before that, the amount needed per
// day and the date the pace will show. A reached goal or an ended period shows no pace.
const goal = (over: Partial<{ period: "month" | "quarter" | "year"; periodStart: string; target: number; actual: number; elapsed: number }> = {}) => ({
  period: "month" as const,
  periodStart: "2026-10-01",
  target: 100,
  actual: 40,
  elapsed: 0.25,
  ...over,
});

describe("progressFigures: when the pace shows", () => {
  it.each([
    // October: 31 days, a quarter = 8 days
    ["month", "2026-10-01", "2026-10-08", "2026-10-09"],
    // February: 28 days, a quarter = 7 days
    ["month", "2026-02-01", "2026-02-07", "2026-02-08"],
    // Q4: 92 days, a quarter = 23 days
    ["quarter", "2026-10-01", "2026-10-23", "2026-10-24"],
    // 2026: 365 days, a quarter = 92 days
    ["year", "2026-01-01", "2026-04-02", "2026-04-03"],
  ] as const)("%s from %s: early on %s, pace from %s", (period, periodStart, before, from) => {
    expect(paceStartDay(period, periodStart)).toBe(from);
    const early = progressFigures(goal({ period, periodStart }), before);
    expect(early).toMatchObject({ phase: "early", projected: null, projectedPercent: null, standing: null, paceFrom: from, percent: 40 });
    expect(early.requiredPerDay).toBeGreaterThan(0);
    const pace = progressFigures(goal({ period, periodStart }), from);
    expect(pace).toMatchObject({ phase: "pace", projected: 160, projectedPercent: 160, standing: "on_pace" });
    // the required-per-day line stays next to the pace
    expect(pace.requiredPerDay).toBeGreaterThan(0);
  });

  it("behind the pace", () => {
    expect(progressFigures(goal({ actual: 20, elapsed: 0.5 }), "2026-10-16")).toMatchObject({ phase: "pace", projected: 40, standing: "behind" });
  });

  it("needed per day: what is left over the days left, today included", () => {
    // 8 October: 24 days left (8..31)
    expect(progressFigures(goal({ target: 1_000_000, actual: 200_000 }), "2026-10-08").requiredPerDay).toBeCloseTo(800_000 / 24);
    // the last day: one day left
    expect(progressFigures(goal({ target: 10, actual: 7, elapsed: 0.99 }), "2026-10-31")).toMatchObject({ phase: "pace", requiredPerDay: 3 });
  });

  it("a reached goal shows neither pace nor need", () => {
    expect(progressFigures(goal({ actual: 100 }), "2026-10-05")).toEqual({
      phase: "reached",
      percent: 100,
      standing: "reached",
      projected: null,
      projectedPercent: null,
      requiredPerDay: null,
      paceFrom: "2026-10-09",
    });
    expect(progressFigures(goal({ actual: 130, elapsed: 1 }), "2026-11-20")).toMatchObject({ phase: "reached", percent: 130 });
  });

  it("an ended period (a past period in a report) shows the final percent only", () => {
    expect(progressFigures(goal({ actual: 70, elapsed: 1 }), "2026-11-01")).toMatchObject({
      phase: "over",
      percent: 70,
      projected: null,
      requiredPerDay: null,
      standing: null,
    });
  });

  it("a period that has not started", () => {
    expect(progressFigures(goal({ periodStart: "2026-11-01", actual: 0, elapsed: 0 }), "2026-10-20")).toMatchObject({ phase: "upcoming", requiredPerDay: null });
  });

  it("a target of 0 has no percent, pace or need", () => {
    expect(progressFigures(goal({ target: 0, actual: 5 }), "2026-10-20")).toMatchObject({
      phase: "none",
      percent: null,
      projected: null,
      requiredPerDay: null,
      standing: null,
    });
  });
});

describe("needed per day, as text", () => {
  it("counts under 10 have one decimal, from 10 whole numbers, rounded up", () => {
    expect(requiredPerDayText("won_deals", 36 / 24)).toBe("1.5 עסקאות");
    expect(requiredPerDayText("meetings_held", 1.23)).toBe("1.3 פגישות");
    expect(requiredPerDayText("won_deals", 1)).toBe("עסקה אחת");
    expect(requiredPerDayText("leads_handled", 360 / 24)).toBe("15 לידים");
    expect(requiredPerDayText("leads_handled", 12.2)).toBe("13 לידים");
    expect(requiredPerDayValue("won_deals", 36 / 24)).toBe(1.5);
    expect(requiredPerDayValue("leads_handled", 12.2)).toBe(13);
  });

  it("money in whole shekels, rounded up", () => {
    expect(requiredPerDayValue("won_amount", 800_000 / 24)).toBe(33_400);
    expect(requiredPerDayText("won_amount", 800_000 / 24)).toContain("334");
  });

  it("the line before the quarter day names the day the pace starts to show", () => {
    // October: the pace shows on 9 October itself
    const early = progressFigures(goal(), "2026-10-08");
    expect(paceFromText(early.paceFrom)).toBe(`התחזית תוצג החל מ־${calendarDateText("2026-10-09")}`);
  });

  it("the date the pace will show", () => {
    expect(calendarDateText("2026-10-09")).toContain("2026");
    expect(calendarDateText("2026-10-09")).toContain("9");
  });
});

describe("goal periods of a report", () => {
  it("whole months, quarters and years", () => {
    expect(goalPeriodOf("2026-10-01", "2026-10-31")).toEqual({ period: "month", periodStart: "2026-10-01" });
    expect(goalPeriodOf("2026-02-01", "2026-02-28")).toEqual({ period: "month", periodStart: "2026-02-01" });
    expect(goalPeriodOf("2026-10-01", "2026-12-31")).toEqual({ period: "quarter", periodStart: "2026-10-01" });
    expect(goalPeriodOf("2026-01-01", "2026-12-31")).toEqual({ period: "year", periodStart: "2026-01-01" });
  });

  it("other ranges have no goal period", () => {
    expect(goalPeriodOf("2026-10-02", "2026-10-31")).toBeNull();
    expect(goalPeriodOf("2026-10-01", "2026-10-30")).toBeNull();
    expect(goalPeriodOf("2026-11-01", "2027-01-31")).toBeNull();
    expect(goalPeriodOf("2026-02-01", "2026-12-31")).toBeNull();
  });

  it("this month and this year run up to today and stand for the whole period", () => {
    expect(reportGoalPeriod("this_month", "2026-10-01", "2026-10-13")).toEqual({ period: "month", periodStart: "2026-10-01" });
    expect(reportGoalPeriod("this_year", "2026-01-01", "2026-10-13")).toEqual({ period: "year", periodStart: "2026-01-01" });
    expect(reportGoalPeriod("last_month", "2026-09-01", "2026-09-30")).toEqual({ period: "month", periodStart: "2026-09-01" });
    expect(reportGoalPeriod("last_30", "2026-09-14", "2026-10-13")).toBeNull();
  });

  it("labels", () => {
    expect(periodLabel("quarter", "2026-10-01")).toBe("רבעון 4, 2026");
    expect(periodLabel("year", "2026-01-01")).toBe("שנת 2026");
    expect(periodLabel("month", "2026-10-01")).toContain("2026");
    expect(periodEndLabel("month")).toBe("לסוף החודש");
    expect(periodEndLabel("quarter")).toBe("לסוף הרבעון");
  });
});

describe("team goals count by the team on the record (option A)", () => {
  it("a team and the teams below it, 10 levels at most", () => {
    const teams = [
      { id: "a", parent_team_id: null },
      { id: "b", parent_team_id: "a" },
      { id: "c", parent_team_id: "b" },
      { id: "d", parent_team_id: null },
    ];
    expect(teamSubtree("a", teams).sort()).toEqual(["a", "b", "c"]);
    expect(teamSubtree("b", teams).sort()).toEqual(["b", "c"]);
    expect(teamSubtree("d", teams)).toEqual(["d"]);
    const chain = Array.from({ length: 15 }, (_, i) => ({ id: `t${i}`, parent_team_id: i === 0 ? null : `t${i - 1}` }));
    expect(teamSubtree("t0", chain)).toHaveLength(10);
  });

  it("only deal metrics link to the deals they count", () => {
    expect(countsDeals("won_amount")).toBe(true);
    expect(countsDeals("won_deals")).toBe(true);
    expect(countsDeals("leads_handled")).toBe(false);
    expect(goalDealsHref("o", "none", "month", "2026-10-01")).toBe("/o/o/reports/goals/deals?team=none&period=month&start=2026-10-01");
  });
});
