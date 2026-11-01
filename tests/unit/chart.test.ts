import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { barPercent, chartMax, meterPercent, MIN_VISIBLE_PERCENT } from "@/components/ui/chart-logic";

// DSN-13: one chart style. The arithmetic of a bar, and that no chart is drawn by hand any more.
describe("chart arithmetic", () => {
  it("a comparison bar is a share of the largest value", () => {
    expect(barPercent(50, 200)).toBe(25);
    expect(barPercent(200, 200)).toBe(100);
    expect(barPercent(300, 200)).toBe(100);
  });

  it("a small positive value stays visible; zero, negative or not a number draws nothing", () => {
    expect(barPercent(1, 10_000)).toBe(MIN_VISIBLE_PERCENT);
    expect(meterPercent(1, 10_000)).toBe(MIN_VISIBLE_PERCENT);
    for (const [value, max] of [
      [0, 10],
      [-5, 10],
      [5, 0],
      [Number.NaN, 10],
      [5, Number.POSITIVE_INFINITY],
    ]) {
      expect(barPercent(value, max)).toBe(0);
      expect(meterPercent(value, max)).toBe(0);
    }
  });

  it("a meter is whole percent and never longer than full", () => {
    expect(meterPercent(1, 3)).toBe(33);
    expect(meterPercent(2, 3)).toBe(67);
    expect(meterPercent(12, 10)).toBe(100);
  });

  it("the scale is the largest positive number, other values ignored", () => {
    expect(chartMax([3, "x", null, 7, -20, Number.NaN])).toBe(7);
    expect(chartMax([])).toBe(0);
    expect(chartMax([-1, 0])).toBe(0);
  });
});

describe("charts use the shared module", () => {
  // the screens that drew their own bars before DSN-13; a new hand-drawn bar uses src/components/ui/chart.tsx instead
  const FILES = [
    "src/app/admin/page.tsx",
    "src/app/o/[orgId]/settings/plan/page.tsx",
    "src/features/goals/components/goal-progress-list.tsx",
    "src/features/data-quality/components/completeness-card.tsx",
    "src/features/imports/components/import-wizard.tsx",
    "src/features/setup/components/setup-checklist.tsx",
    "src/features/reports/components/report-body.tsx",
  ];

  it.each(FILES)("%s draws no bar by hand", (file) => {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
    expect(source).not.toMatch(/style=\{\{\s*width:/);
    expect(source).not.toMatch(/role="(meter|progressbar)"/);
    expect(source).toMatch(/from "@\/components\/ui\/chart"/);
  });

  it("the chart roles are defined in both themes", () => {
    const css = readFileSync(new URL("../../src/app/globals.css", import.meta.url), "utf8");
    for (const role of ["chart-track", "chart-bar", "chart-done", "chart-alert"]) {
      expect(css.match(new RegExp(`--color-${role}:`, "g"))?.length).toBe(2);
    }
  });
});
