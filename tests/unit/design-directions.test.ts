import { describe, expect, it } from "vitest";

import { contrast, DIRECTIONS, textPairs } from "@/features/design-preview/directions";

describe("design directions (DSN-02)", () => {
  it("contrast is computed as WCAG defines it", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrast("#ffffff", "#ffffff")).toBe(1);
  });

  // a direction that fails 4.5:1 is not shown for choosing (chapter 23.1)
  it.each(DIRECTIONS.map((d) => [d.name, d] as const))("%s: every text pair meets 4.5:1", (_name, direction) => {
    const failing = textPairs(direction).filter((p) => p.ratio < 4.5);
    expect(failing).toEqual([]);
  });

  it("control borders stand out from white (3:1, WCAG 1.4.11)", () => {
    for (const d of DIRECTIONS) expect(contrast(d.colors.lineControl, d.colors.surface)).toBeGreaterThanOrEqual(3);
  });
});
