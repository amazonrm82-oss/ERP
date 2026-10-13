import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { REPORTS } from "@/features/reports/definitions";
import { REPORT_FUNCTIONS, REPORT_SHAPE_MESSAGE, ReportShapeError, keyPaths, parseReportData, withReportShape, type ReportFunction } from "@/features/reports/schemas";

// FXC-12: every report result is checked against a schema before it is shaped. The samples in
// fixtures/reports/ are real results of the SQL functions (written by the database test
// 89-report-shapes, which also fails when the SQL's keys stop matching them).

const FIXTURES = path.resolve(__dirname, "fixtures/reports");
const sample = (name: ReportFunction): unknown => JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));

let results: Partial<Record<ReportFunction, unknown>> = {};

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (name: ReportFunction) => ({ data: results[name], error: null }),
    from: () => ({ select: () => ({ eq: async () => ({ data: [], error: null }) }) }),
  }),
}));
vi.mock("@/features/shell/queries", () => ({
  getUserNames: async (ids: (string | null)[]) => new Map(ids.filter((id): id is string => !!id).map((id) => [id, "נציג"])),
}));

const { buildReport } = await import("@/features/reports/build");
const { getDashboard } = await import("@/features/reports/dashboard");

const filters = {
  period: { key: "this_month", from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z", fromDate: "2026-10-01", toDate: "2026-10-31" },
  ownerId: null,
  pipelineId: null,
} as unknown as Parameters<typeof buildReport>[2];

beforeEach(() => {
  results = Object.fromEntries(REPORT_FUNCTIONS.map((name) => [name, sample(name)]));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

/** Drops the first key named `key` anywhere in the value (a renamed or removed SQL column). */
function withoutKey(value: unknown, key: string): unknown {
  let done = false;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(v)) {
        if (!done && k === key) {
          done = true;
          continue;
        }
        out[k] = walk(child);
      }
      return out;
    }
    return v;
  };
  return walk(value);
}

describe("report schemas (FXC-12)", () => {
  it("every report function the app knows has a schema and a sample", () => {
    const types = readFileSync(path.resolve(__dirname, "../../src/lib/database.types.ts"), "utf8");
    const declared = [...new Set([...types.matchAll(/^\s+(report_[a-z_]+): \{/gm)].map((m) => m[1]))].sort();
    expect([...REPORT_FUNCTIONS].sort()).toEqual(declared);
  });

  it.each(REPORT_FUNCTIONS.map((name) => [name]))("%s: the saved sample passes its schema", (name) => {
    expect(() => parseReportData(name, sample(name))).not.toThrow();
  });

  it.each(REPORT_FUNCTIONS.map((name) => [name]))("%s: every key of the sample is required", (name) => {
    const data = sample(name);
    // each leaf key, removed on its own, must fail the schema: a renamed SQL key cannot read as zero
    const keys = new Set(keyPaths(data).map((p) => p.split(".").pop()!.replace("[]", "")));
    for (const key of keys) {
      expect(() => parseReportData(name, withoutKey(data, key)), `${name} without ${key}`).toThrow(ReportShapeError);
    }
  });

  it("a wrong type or a missing result fails with the Hebrew message and paths only in the details", () => {
    const funnel = sample("report_funnel") as { leads: Record<string, unknown> };
    funnel.leads.created = "שלוש";
    try {
      parseReportData("report_funnel", funnel);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ReportShapeError);
      expect((error as ReportShapeError).message).toBe(REPORT_SHAPE_MESSAGE);
      expect((error as ReportShapeError).details).toContain("leads.created");
      expect((error as ReportShapeError).details).not.toContain("שלוש");
    }
    expect(() => parseReportData("report_summary", null)).toThrow(ReportShapeError);
    expect(() => parseReportData("report_forecast", {})).toThrow(ReportShapeError);
  });

  it("extra keys pass the schema (the database test catches them against the sample)", () => {
    const summary = { ...(sample("report_summary") as object), something_new: 1 };
    expect(() => parseReportData("report_summary", summary)).not.toThrow();
  });
});

describe("report shaping from the saved samples", () => {
  it.each(REPORTS.map((r) => [r.key]))("%s shapes into numbers, not NaN", async (key) => {
    const view = await buildReport("00000000-0000-4000-8000-000000000099", key, filters);
    expect(view.sections.length).toBeGreaterThan(0);
    expect(view.sections[0].rows.length).toBeGreaterThan(0);
    for (const kpi of view.kpis) {
      expect(kpi.value, kpi.label).not.toMatch(/NaN|undefined|Infinity/);
    }
    for (const section of view.sections) {
      for (const row of section.rows) {
        for (const column of section.columns) {
          const value = row[column.key];
          if (column.kind !== "text") {
            expect(value === null || (typeof value === "number" && Number.isFinite(value)), `${section.title}.${column.key}`).toBe(true);
          }
        }
      }
    }
  });

  it("known numbers of the samples come through", async () => {
    const reps = await buildReport("00000000-0000-4000-8000-000000000099", "reps", filters);
    expect(reps.sections[0].rows.map((r) => r.won_amount)).toEqual([100000, 0]);
    const funnel = await buildReport("00000000-0000-4000-8000-000000000099", "funnel", filters);
    expect(funnel.sections[0].rows.map((r) => r.count)).toEqual([3, 2, 1, 1]);
  });

  it("a sample with a renamed key stops the report instead of showing zeros", async () => {
    results.report_rep_performance = (sample("report_rep_performance") as Record<string, unknown>[]).map(({ won_amount, ...rest }) => ({
      ...rest,
      amount_won: won_amount,
    }));
    await expect(buildReport("00000000-0000-4000-8000-000000000099", "reps", filters)).rejects.toThrow(ReportShapeError);
    const outcome = await withReportShape(() => buildReport("00000000-0000-4000-8000-000000000099", "reps", filters));
    expect(outcome).toEqual({ ok: false, message: REPORT_SHAPE_MESSAGE });
    await expect(withReportShape(async () => Promise.reject(new Error("other")))).rejects.toThrow("other");
  });

  it("lost deals with no stage history come last, named, sorted even when the SQL order is not", async () => {
    const lost = sample("report_lost_reasons") as { by_stage: unknown[] };
    results.report_lost_reasons = { ...lost, by_stage: [...lost.by_stage].reverse() };
    const view = await buildReport("00000000-0000-4000-8000-000000000099", "lost", filters);
    const stages = view.sections[1].rows.map((r) => r.stage);
    expect(stages[stages.length - 1]).toBe("לא נרשם מעבר שלב");
    expect(stages[0]).toBe("פנייה ראשונית");
  });

  it("stuck deals: the old shape (idle, no stuck or postponed) is refused", () => {
    const rows = sample("report_stuck_deals") as Record<string, unknown>[];
    const old = rows.map(({ stuck, postponed, ...rest }) => ({ ...rest, idle: stuck || postponed }));
    expect(() => parseReportData("report_stuck_deals", old)).toThrow(ReportShapeError);
  });

  it("GOL-03: the rep report adds a goal table per metric for people's goals; the business's goal stays on the dashboard", async () => {
    const row = (sample("report_goal_progress") as Record<string, unknown>[])[0];
    results.report_goal_progress = [
      row,
      { ...row, goal_id: "00000000-0000-4000-8000-000000000098", scope: "user", user_id: "00000000-0000-4000-8000-000000000001", target: 200000, actual: 50000, elapsed: 0.5 },
    ];
    // 16 October 2026 (Asia/Jerusalem, the default zone): past the quarter day (9 October), 16 days left
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-16T09:00:00Z"));
      const reps = await buildReport("00000000-0000-4000-8000-000000000099", "reps", filters);
      const goals = reps.sections.filter((s) => s.title.startsWith("עמידה ביעד"));
      expect(goals).toHaveLength(1);
      // needed: (200,000 - 50,000) / 16 = 9,375 agorot, rounded up to whole shekels
      expect(goals[0].rows).toEqual([
        { owner: "נציג", actual: 50000, target: 200000, percent: 25, projected: 100000, projected_percent: 50, required_per_day: 9400 },
      ]);
      // 5 October: before the quarter day, no pace, and the date it will show
      vi.setSystemTime(new Date("2026-10-05T09:00:00Z"));
      const early = (await buildReport("00000000-0000-4000-8000-000000000099", "reps", filters)).sections[1];
      expect(early.rows[0]).toMatchObject({ projected: null, projected_percent: null, required_per_day: 5600 });
      expect(early.note).toContain("התחזית תוצג החל מ־");
    } finally {
      vi.useRealTimers();
    }
    const dashboard = await getDashboard("00000000-0000-4000-8000-000000000099");
    expect(dashboard.goals.map((g) => g.scope)).toEqual(["org"]);
    // a range that is not a whole period has no goal table
    const custom = { ...filters, period: { ...filters.period, key: "last_30", fromDate: "2026-09-14", toDate: "2026-10-13" } } as typeof filters;
    const view = await buildReport("00000000-0000-4000-8000-000000000099", "reps", custom);
    expect(view.sections).toHaveLength(1);
    expect(view.sections[0].note).toContain("חודש, רבעון או שנה");
  });

  it("GOL-04: the forecast keeps overdue deals in a line of their own, marks them, and compares months with the goal", async () => {
    const view = await buildReport("00000000-0000-4000-8000-000000000099", "forecast", filters);
    const months = view.sections[0];
    // sample: one overdue deal, this month with a goal of 5,000 and 1,000 already won, next month with none
    expect(months.rows.map((r) => r.month)).toEqual(["תאריך הסגירה עבר", expect.stringContaining("אוקטובר"), expect.stringContaining("נובמבר")]);
    expect(months.rows[0]).toMatchObject({ deals: 1, weighted: 3000, goal: null, goal_percent: null });
    expect(months.rows[1]).toMatchObject({ forecast: 100000, goal: 500000, goal_percent: 20 });
    expect(months.rows[2]).toMatchObject({ goal: null, goal_percent: null });
    expect(view.kpis[0].hint).toContain("20%");
    const overdue = view.sections.find((s) => s.title === "עסקאות שתאריך הסגירה שלהן עבר");
    expect(overdue?.rows).toHaveLength(1);
    expect(overdue?.rows[0].expected).toContain("(עבר)");
    expect(overdue?.rows[0]._href).toContain("/deals/");
    expect(view.sections.map((s) => s.title)).toEqual(
      expect.arrayContaining(["לפי חבר צוות", "לפי שלב"]),
    );
  });

  it("GOL-04: no goal comparison when the view is not whole or a pipeline is picked; the overdue line links to the list", async () => {
    const id = "00000000-0000-4000-8000-000000000099";
    const whole = await buildReport(id, "forecast", filters);
    expect(whole.sections[0].rows[0]._href).toBe("#overdue-deals");
    expect(whole.sections[0].columns.map((c) => c.key)).toContain("goal");
    // sample: 30.00 ₪ weighted in overdue deals
    expect(whole.kpis[0].hint).toContain("בעסקאות שתאריך הסגירה שלהן עבר");
    expect(whole.overdueTotal).toBe(1);
    expect(whole.overdueDeals?.[0]).toMatchObject({ name: "עסקה באיחור", expected: "2026-09-23" });

    results.report_goal_forecast = { ...(sample("report_goal_forecast") as object), complete: false };
    const partial = await buildReport(id, "forecast", filters);
    expect(partial.sections[0].columns.map((c) => c.key)).not.toContain("goal");
    expect(partial.kpis[0].hint).not.toContain("מיעד");

    results.report_goal_forecast = sample("report_goal_forecast");
    const piped = await buildReport(id, "forecast", { ...filters, pipelineId: "00000000-0000-4000-8000-000000000006" });
    expect(piped.sections[0].columns.map((c) => c.key)).not.toContain("goal_percent");
    expect(piped.sections[0].note).toContain("בכל הפייפליינים");

    // nothing overdue: no "ועוד" line
    const none = sample("report_goal_forecast") as Record<string, unknown>;
    results.report_goal_forecast = { ...none, overdue: { deals: 0, amount: 0, weighted: 0 }, overdue_deals: [] };
    const clean = await buildReport(id, "forecast", filters);
    expect(clean.kpis[0].hint).not.toContain("ועוד");
    expect(clean.sections[0].rows[0].month).not.toBe("תאריך הסגירה עבר");
  });

  it("the dashboard checks the summary too", async () => {
    const dashboard = await getDashboard("00000000-0000-4000-8000-000000000099");
    expect(dashboard.tiles[0].value).toBe("3");
    results.report_summary = withoutKey(sample("report_summary"), "won_amount");
    await expect(getDashboard("00000000-0000-4000-8000-000000000099")).rejects.toThrow(ReportShapeError);
  });
});
