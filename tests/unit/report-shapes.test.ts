import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { REPORTS } from "@/features/reports/definitions";
import { reportXlsxRows } from "@/features/reports/xlsx";
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

  it("RPT-01: revenue by product names free lines and billing, links products, and counts deals without lines apart", async () => {
    const view = await buildReport("00000000-0000-4000-8000-000000000099", "products", filters);
    const [section] = view.sections;
    expect(section.rows.map((r) => [r.product, r.billing, r.quantity, r.deals, r.amount])).toEqual([
      ["ייעוץ", "חד-פעמי", 2, 1, 60000],
      ["שורות בלי מוצר", "חודשי", 1, 1, 5000],
    ]);
    expect(section.rows[0]._href).toMatch(/\/products\//);
    expect(section.rows[1]._href).toBeNull();
    // one figure per billing type, one-time first; a monthly total is never added to one-time sales
    expect(view.kpis.map((k) => k.label)).toEqual(["מכירות חד-פעמיות", "חיוב חודשי", "מוצרים שנמכרו", "עסקאות בלי שורות"]);
    expect(view.kpis[1].hint).toContain("לחודש אחד");
    expect(view.kpis[3].hint).toContain("לא נספרו כאן");
    expect(section.note).toContain('לפני מע"מ');
    expect(section.note).not.toContain("שימו לב");
  });

  it("RPT-01: a period that mixes deals priced with and without VAT says so", async () => {
    const data = sample("report_revenue_by_product") as { totals: Record<string, number> };
    results.report_revenue_by_product = { ...data, totals: { ...data.totals, deals_with_vat: 2, deals_without_vat: 3 } };
    const view = await buildReport("00000000-0000-4000-8000-000000000099", "products", filters);
    expect(view.sections[0].note).toContain('שימו לב: בתקופה יש עסקאות שתמחרו כולל מע"מ (2) ועסקאות שתמחרו לפני מע"מ (3)');
  });

  it("RPT-01: recurring revenue by close month and owner, with the counting rule and the subscriptions line", async () => {
    const view = await buildReport("00000000-0000-4000-8000-000000000099", "recurring", filters);
    const [months, owners] = view.sections;
    expect(months.rows.map((r) => [r.deals, r.new_mrr, r.monthly_mrr, r.yearly_mrr])).toEqual([[3, 25000, 15000, 10000]]);
    expect(owners.rows.map((r) => [r.owner, r.deals, r.new_mrr])).toEqual([["נציג", 3, 25000]]);
    expect(view.kpis.map((k) => k.label)).toEqual(["הכנסה חוזרת חדשה לחודש", "מחיוב חודשי", "מחיוב שנתי, לחודש"]);
    expect(view.kpis[2].hint).toContain("לשנה");
    expect(months.note).toContain("חלקי 12");
    expect(months.note).toContain("מודול מנויים");
    expect(months.note).not.toContain("שימו לב");
  });

  it("RPT-01: recurring revenue warns about mixed VAT modes, deals without lines and deals without an amount", async () => {
    const data = sample("report_recurring_revenue") as { totals: Record<string, number> };
    results.report_recurring_revenue = { ...data, totals: { ...data.totals, deals: 6, deals_with_vat: 2, deals_without_vat: 3, deals_without_amount: 1 } };
    const note = (await buildReport("00000000-0000-4000-8000-000000000099", "recurring", filters)).sections[0].note ?? "";
    expect(note).toContain('שימו לב: בתקופה יש עסקאות שתומחרו כולל מע"מ (2) ועסקאות שתומחרו לפני מע"מ (3)');
    expect(note).toContain("1 מהעסקאות בלי שורות");
    expect(note).toContain("1 מהעסקאות נסגרו בלי סכום חוזר");
    results.report_recurring_revenue = { ...data, totals: { ...data.totals, deals: 2, deals_with_vat: 2, deals_without_vat: 0 } };
    const all = (await buildReport("00000000-0000-4000-8000-000000000099", "recurring", filters)).sections[0].note ?? "";
    expect(all).toContain('כל הסכומים כאן כוללים מע"מ');
  });

  it("DLI-06: revenue by category rolls subcategories up, names free lines, and keeps billing apart", async () => {
    const view = await buildReport("00000000-0000-4000-8000-000000000099", "categories", filters);
    const [tops, categories] = view.sections;
    expect(tops.rows.map((r) => [r.category, r.billing, r.amount])).toEqual([["שירותים", "חד-פעמי", 60000]]);
    expect(categories.rows.map((r) => [r.category, r.billing, r.products, r.amount])).toEqual([
      ["שירותים / ייעוץ", "חד-פעמי", 1, 60000],
      ["שורות בלי מוצר", "חודשי", 0, 5000],
    ]);
    expect(view.kpis.map((k) => k.label)).toEqual(["מכירות חד-פעמיות", "חיוב חודשי", "קטגוריות שנמכרו", "עסקאות בלי שורות"]);
    expect(categories.note).toContain("הקטגוריה היא זו שהמוצר נמצא בה היום");
  });

  it("DLI-06: gross profit per product with margin, one figure per billing, and nothing for someone who may not see costs", async () => {
    const view = await buildReport("00000000-0000-4000-8000-000000000099", "profit", filters);
    const [section] = view.sections;
    expect(section.rows.map((r) => [r.product, r.revenue, r.cost, r.profit, r.margin])).toEqual([["ייעוץ", 60000, 24000, 36000, 60]]);
    expect(section.rows[0]._href).toMatch(/\/products\//);
    expect(view.kpis[0].label).toBe("רווח גולמי, חד-פעמי");
    expect(view.kpis[0].value).toContain("60%");
    expect(view.kpis.at(-1)).toMatchObject({ label: "שורות בלי עלות", value: "1" });
    results.report_gross_profit = { allowed: false };
    const hidden = await buildReport("00000000-0000-4000-8000-000000000099", "profit", filters);
    expect(hidden).toEqual({ kpis: [], sections: [], note: "רק מי שמורשה לראות עלות רואה את הדוח הזה." });
  });

  it("BAL-03: debt aging with a hidden row shows no amount and says who sees it in full", async () => {
    results.report_debt_aging = { allowed: true, partial: true };
    const view = await buildReport("00000000-0000-4000-8000-000000000099", "debt_aging", filters);
    expect(view).toEqual({ kpis: [], sections: [], note: "חלק מהמסמכים או התשלומים של העסק מוסתרים ממך, ולכן הדוח לא מציג סכומים. הדוח המלא זמין לבעלים ומנהלי מערכת." });
    const full = await (async () => {
      results.report_debt_aging = sample("report_debt_aging");
      return buildReport("00000000-0000-4000-8000-000000000099", "debt_aging", filters);
    })();
    expect(full.sections.map((s) => s.title)).toEqual(["לפי ותק", "לפי לקוח"]);
    expect(full.sections[1].rows[0]).toMatchObject({ customer: "חייב", d1_30: 11700, total: 11700 });
  });

  it("COL-06: collection by month, method and rep; a partial view keeps its rows, says so once, and has no total, share or days", async () => {
    const full = await buildReport("00000000-0000-4000-8000-000000000099", "collection", filters);
    expect(full.sections.map((s) => s.title)).toEqual(["לפי חודש", "לפי אמצעי תשלום", "לפי נציג", "ימי גבייה"]);
    expect(full.sections[1].rows[0]).toMatchObject({ method: "העברה בנקאית", amount: 5000, payments: 1, percent: 100 });
    expect(full.kpis[0]).toMatchObject({ label: "נגבה בתקופה", hint: "תשלום אחד" });
    expect(full.note).toBeUndefined();
    expect(full.sections[3].note).toContain("נדרשים לפחות 5 מסמכים");
    // the debt aging link only for those who see balances; never exported
    const withLink = await buildReport("00000000-0000-4000-8000-000000000099", "collection", filters, { balances: true });
    expect(withLink.sections.at(-1)).toMatchObject({ title: "חוב לפי גיל", exported: false });
    expect(withLink.sections.at(-1)?.rows[0]._href).toMatch(/\/reports\/debt_aging$/);
    expect(reportXlsxRows("גבייה", null, withLink).some((row) => row.some((cell) => cell === "דוח גיול חובות"))).toBe(false);

    const data = sample("report_collection") as Record<string, unknown>;
    const nulls = { min_documents: 5, documents: null, average_days: null, median_days: null, with_due_date: null, average_days_late: null, late_documents: null };
    results.report_collection = { ...data, partial: true, totals: null, collection_days: nulls };
    const partial = await buildReport("00000000-0000-4000-8000-000000000099", "collection", filters);
    expect(partial.note).toBe("דוח חלקי: מוצגים רק התשלומים והמסמכים שיש לך גישה אליהם, ולכן אין סכום כולל וימי הגבייה מוצגים רק בדוח המלא.");
    expect(partial.sections.every((s) => !s.note?.includes("דוח חלקי"))).toBe(true);
    expect(partial.kpis.map((k) => k.value)).toEqual(["—", "—", "—"]);
    expect(partial.sections[0].rows[0]).toMatchObject({ amount: 5000 });
    expect(partial.sections[1].rows[0].percent).toBeNull();
    expect(partial.sections[3]).toMatchObject({ rows: [], empty: "ימי הגבייה מוצגים רק בדוח המלא." });
    results.report_collection = { allowed: false };
    expect((await buildReport("00000000-0000-4000-8000-000000000099", "collection", filters)).sections).toEqual([]);
  });

    it("DLI-06: only the gross profit report is about costs", () => {
    expect(REPORTS.filter((r) => r.costs).map((r) => r.key)).toEqual(["profit"]);
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
    expect(piped.sections[0].note).toContain("בכל תהליכי המכירה");

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

// CAL-11: the deals list stops at 200; the section title says so (screen, CSV and Excel)
describe("meetings report: the capped deals list", () => {
  it("says how many of how many deals are shown when the SQL cut the list", async () => {
    const data = sample("report_meetings") as { totals: { won_deals: number }; deals: unknown[] };
    let view = await buildReport("org", "meetings", filters);
    expect(view.sections[1].title).toBe("עסקאות שנסגרו אחרי פגישה");
    results.report_meetings = { ...data, totals: { ...data.totals, won_deals: 250 } };
    view = await buildReport("org", "meetings", filters);
    expect(view.sections[1].title).toBe(`עסקאות שנסגרו אחרי פגישה (מוצגות ${data.deals.length} האחרונות מתוך 250)`);
  });
});
