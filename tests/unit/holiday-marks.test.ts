import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HolidayLegend, HolidayMarks } from "@/features/calendar-days/components/holiday-marks";
import { holidaysOn } from "@/features/calendar-days/holidays";

const text = (html: string) => html.replace(/<[^>]*>/g, "");

describe("holiday marks (CAL-03)", () => {
  it("Yom HaZikaron shows in sight as a shortened working day, with its memorial mark", () => {
    const html = renderToStaticMarkup(createElement(HolidayMarks, { holidays: holidaysOn("2026-04-21") }));
    expect(text(html)).toBe("יום הזיכרון · יום עבודה מקוצר (יום זיכרון)");
    expect(html).toContain('title="יום עבודה מקוצר: יום הזיכרון (יום זיכרון)"');
    expect(html).toContain("bg-warning-soft text-warning");
    expect(html).toContain('<span aria-hidden="true"> · </span>');
    expect(html).not.toContain("ערב חג");
  });

  it("an eve keeps its screen-reader kind and no visible suffix", () => {
    const html = renderToStaticMarkup(createElement(HolidayMarks, { holidays: holidaysOn("2026-09-20") }));
    expect(text(html)).toBe("ערב חג: ערב יום כיפור");
  });

  it("the legend has one entry per colour: eves and shortened days together", () => {
    const html = renderToStaticMarkup(createElement(HolidayLegend));
    expect(text(html)).toBe("חגערב חג או יום עבודה מקוצרמועד");
  });
});
