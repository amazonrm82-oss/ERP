import { describe, expect, it } from "vitest";

import { cellKey, copyPlan, managedTeams, defaultCopyTarget, goalColumns, goalView, peopleTotals, previousStart, rowKey, valuesByCell, type GoalValue } from "@/features/goals/grid";
import { goalCellArg, goalCopyArg, goalRowsArg } from "@/features/goals/schema";
import { validArg } from "@/lib/action-args";

// GOL-02: the goals grid
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const T = "00000000-0000-4000-8000-00000000000c";

describe("goals grid", () => {
  it("columns: twelve months, four quarters or the year", () => {
    const months = goalColumns("month", 2026);
    expect(months.map((c) => c.start)).toEqual(Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}-01`));
    expect(months[9].label).toBe("אוקטובר");
    expect(goalColumns("quarter", 2026).map((c) => [c.start, c.label])).toEqual([
      ["2026-01-01", "רבעון 1"],
      ["2026-04-01", "רבעון 2"],
      ["2026-07-01", "רבעון 3"],
      ["2026-10-01", "רבעון 4"],
    ]);
    expect(goalColumns("year", 2026)).toEqual([{ start: "2026-01-01", label: "2026", short: "2026" }]);
  });

  it("the period before, across the year too", () => {
    expect(previousStart("month", "2026-01-01")).toBe("2025-12-01");
    expect(previousStart("month", "2026-10-01")).toBe("2026-09-01");
    expect(previousStart("quarter", "2026-01-01")).toBe("2025-10-01");
    expect(previousStart("quarter", "2026-07-01")).toBe("2026-04-01");
    expect(previousStart("year", "2026-01-01")).toBe("2025-01-01");
  });

  it("the copy fills the current period when it is on screen", () => {
    expect(defaultCopyTarget(goalColumns("month", 2026), "month", "2026-10-13")).toBe("2026-10-01");
    expect(defaultCopyTarget(goalColumns("quarter", 2026), "quarter", "2026-11-30")).toBe("2026-10-01");
    expect(defaultCopyTarget(goalColumns("year", 2026), "year", "2026-03-01")).toBe("2026-01-01");
    expect(defaultCopyTarget(goalColumns("month", 2027), "month", "2026-10-13")).toBe("2027-01-01");
  });

  it("copying adds only empty cells of rows on the grid, with last period's targets", () => {
    const rows = [
      { scope: "org" as const, subjectId: null },
      { scope: "user" as const, subjectId: A },
      { scope: "team" as const, subjectId: T },
    ];
    const previous: GoalValue[] = [
      { scope: "org", subjectId: null, periodStart: "2026-09-01", target: 900 },
      { scope: "user", subjectId: A, periodStart: "2026-09-01", target: 100 },
      // B left the grid (suspended, removed): not copied
      { scope: "user", subjectId: B, periodStart: "2026-09-01", target: 200 },
      { scope: "team", subjectId: T, periodStart: "2026-09-01", target: 300 },
    ];
    // A already has a goal for October: it stays
    const existing: GoalValue[] = [...previous, { scope: "user", subjectId: A, periodStart: "2026-10-01", target: 150 }];
    expect(copyPlan(previous, existing, rows, "2026-10-01")).toEqual([
      { scope: "org", subjectId: null, periodStart: "2026-10-01", target: 900 },
      { scope: "team", subjectId: T, periodStart: "2026-10-01", target: 300 },
    ]);
    expect(copyPlan([], existing, rows, "2026-10-01")).toEqual([]);
  });

  it("cell keys, saved values and the people's totals", () => {
    const values: GoalValue[] = [
      { scope: "user", subjectId: A, periodStart: "2026-10-01", target: 100 },
      { scope: "user", subjectId: B, periodStart: "2026-10-01", target: 50 },
      { scope: "team", subjectId: T, periodStart: "2026-10-01", target: 1000 },
      { scope: "org", subjectId: null, periodStart: "2026-11-01", target: 7 },
    ];
    expect(rowKey({ scope: "org", subjectId: null })).toBe("org:-");
    expect(valuesByCell(values)[cellKey({ scope: "user", subjectId: A }, "2026-10-01")]).toBe(100);
    const totals = peopleTotals(values, goalColumns("month", 2026));
    expect(totals["2026-10-01"]).toBe(150);
    expect(totals["2026-11-01"]).toBeNull();
  });

  it("the view from the address falls back to this year's monthly revenue", () => {
    expect(goalView({}, "2026-10-13")).toEqual({ metric: "won_amount", period: "month", year: 2026 });
    expect(goalView({ metric: "meetings_held", period: "quarter", year: "2027" }, "2026-10-13")).toEqual({ metric: "meetings_held", period: "quarter", year: 2027 });
    expect(goalView({ metric: "collections", period: "week", year: "1999" }, "2026-10-13")).toEqual({ metric: "won_amount", period: "month", year: 2026 });
    expect(goalView({ year: "2026.5" }, "2026-10-13").year).toBe(2026);
  });

  it("action arguments are checked", () => {
    const cell = { scope: "user", subjectId: A, period: "month", periodStart: "2026-10-01", metric: "won_amount", value: "5000" };
    expect(validArg(goalCellArg, cell)).toBe(true);
    expect(validArg(goalCellArg, { ...cell, scope: "org", subjectId: null })).toBe(true);
    expect(validArg(goalCellArg, { ...cell, scope: "org" })).toBe(false);
    expect(validArg(goalCellArg, { ...cell, subjectId: "not-a-uuid" })).toBe(false);
    expect(validArg(goalCellArg, { ...cell, subjectId: null })).toBe(false);
    expect(validArg(goalCellArg, { ...cell, metric: "collections" })).toBe(false);
    expect(validArg(goalCellArg, { ...cell, periodStart: "2026-10-02" })).toBe(false);
    expect(validArg(goalCellArg, { ...cell, period: "quarter", periodStart: "2026-11-01" })).toBe(false);
    expect(validArg(goalCellArg, { ...cell, period: "quarter", periodStart: "2026-10-01" })).toBe(true);
    expect(validArg(goalCellArg, { ...cell, value: "1".repeat(41) })).toBe(false);
    expect(validArg(goalCellArg, { ...cell, value: 5 })).toBe(false);
    expect(validArg(goalCopyArg, { period: "year", periodStart: "2026-01-01", metric: "won_deals" })).toBe(true);
    expect(validArg(goalCopyArg, { period: "year", periodStart: "2026-02-01", metric: "won_deals" })).toBe(false);
    expect(validArg(goalRowsArg, [{ scope: "team", subjectId: T }, { scope: "org", subjectId: null }])).toBe(true);
    expect(validArg(goalRowsArg, [{ scope: "team", subjectId: null }])).toBe(false);
    expect(validArg(goalRowsArg, "x")).toBe(false);
  });

  it("a manager's teams include the teams below theirs, like app.manages_team", () => {
    const teams = [
      { id: "north", parent_team_id: null },
      { id: "north-west", parent_team_id: "north" },
      { id: "north-west-2", parent_team_id: "north-west" },
      { id: "south", parent_team_id: null },
    ];
    const members = [
      { team_id: "north", user_id: "boss", is_manager: true },
      { team_id: "south", user_id: "boss", is_manager: false },
      { team_id: "south", user_id: "other", is_manager: true },
    ];
    expect([...managedTeams("boss", teams, members)].sort()).toEqual(["north", "north-west", "north-west-2"]);
    expect([...managedTeams("other", teams, members)]).toEqual(["south"]);
    expect(managedTeams("nobody", teams, members).size).toBe(0);
  });
});
