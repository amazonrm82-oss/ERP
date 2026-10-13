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

  it("the dashboard checks the summary too", async () => {
    const dashboard = await getDashboard("00000000-0000-4000-8000-000000000099");
    expect(dashboard.tiles[0].value).toBe("3");
    results.report_summary = withoutKey(sample("report_summary"), "won_amount");
    await expect(getDashboard("00000000-0000-4000-8000-000000000099")).rejects.toThrow(ReportShapeError);
  });
});
