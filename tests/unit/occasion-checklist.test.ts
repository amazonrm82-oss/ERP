import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { occasionBoxes, OccasionChecklist } from "@/features/calendar-days/components/occasion-checklist";
import { OCCASION_KEYS, OCCASIONS, type OccasionKey } from "@/features/calendar-days/holidays";
import { calendarSettingsFromForm, calendarSettingsSchema } from "@/features/calendar-days/schema";

const HOLIDAYS = OCCASIONS.filter((o) => o.kind === "rest").map((o) => o.key);
const EVES = OCCASIONS.filter((o) => o.kind === "erev").map((o) => o.key);

const render = (holidaysRest: boolean, holidayEvesRest: boolean, initial: OccasionKey[]) =>
  renderToStaticMarkup(createElement(OccasionChecklist, { holidaysRest, holidayEvesRest, initial }));

/** The <input> tags of the markup, keyed by value (the hidden ones separately). */
function inputs(html: string) {
  const tags = html.match(/<input[^>]*>/g) ?? [];
  const value = (tag: string) => tag.match(/value="([^"]*)"/)?.[1] ?? "";
  const boxes = tags.filter((t) => t.includes('type="checkbox"'));
  const hidden = tags.filter((t) => t.includes('type="hidden"')).map(value);
  return { boxes, hidden, value };
}

describe("the occasion checklist (CAL-03: any occasion, holidays included)", () => {
  it("lists every occasion of the list, holidays and eves included", () => {
    expect(occasionBoxes(false, false, new Set()).map((b) => b.key)).toEqual([...OCCASION_KEYS]);
    expect(inputs(render(false, false, [])).boxes).toHaveLength(OCCASIONS.length);
  });

  it("everything off by default: no switch, nothing chosen", () => {
    const boxes = occasionBoxes(false, false, new Set());
    expect(boxes.filter((b) => b.checked || b.disabled)).toEqual([]);
    const html = render(false, false, []);
    expect(html).not.toMatch(/ checked=""| disabled=""/);
  });

  it("while holidays are rest days, the holidays show checked and locked, with a note; the rest stay free", () => {
    const boxes = occasionBoxes(true, false, new Set());
    for (const box of boxes) {
      const holiday = (HOLIDAYS as string[]).includes(box.key);
      expect([box.key, box.checked, box.disabled], box.key).toEqual([box.key, holiday, holiday]);
      expect(box.note).toBe(holiday ? "סגור לפי החגים למעלה" : null);
    }
    const { boxes: tags } = inputs(render(true, false, []));
    const locked = tags.filter((t) => t.includes(' disabled=""'));
    expect(locked).toHaveLength(HOLIDAYS.length);
    // a locked box is not sent itself (it has no name)
    for (const tag of locked) expect(tag).not.toMatch(/name=/);
    expect(render(true, false, [])).toContain("סגור לפי החגים למעלה");
  });

  it("eves lock the same way under their own switch", () => {
    const boxes = occasionBoxes(false, true, new Set());
    expect(boxes.filter((b) => b.disabled).map((b) => b.key)).toEqual(EVES);
  });

  it("Yom HaZikaron is not an eve: never locked by the eves switch, picked on its own (CAL-03)", () => {
    expect(EVES).not.toContain("yom_hazikaron");
    for (const [holidaysRest, evesRest] of [
      [true, true],
      [false, true],
    ] as const) {
      const box = occasionBoxes(holidaysRest, evesRest, new Set()).find((b) => b.key === "yom_hazikaron");
      expect(box).toEqual({ key: "yom_hazikaron", name: "יום הזיכרון", checked: false, disabled: false, note: null });
    }
    const { boxes, value } = inputs(render(true, true, ["yom_hazikaron"]));
    const box = boxes.find((t) => value(t) === "yom_hazikaron") ?? "";
    expect(box).toContain(' checked=""');
    expect(box).toContain('name="rest_occasions"');
    expect(box).not.toContain(' disabled=""');
  });

  it("with the switch off, each holiday is picked on its own and sent", () => {
    const boxes = occasionBoxes(false, false, new Set<OccasionKey>(["yom_kippur", "rosh_hashana"]));
    expect(boxes.filter((b) => b.checked).map((b) => b.key)).toEqual(["rosh_hashana", "yom_kippur"]);
    expect(boxes.some((b) => b.disabled)).toBe(false);
    const { boxes: tags, value } = inputs(render(false, false, ["yom_kippur", "rosh_hashana"]));
    const sent = tags.filter((t) => t.includes('name="rest_occasions"') && t.includes(' checked=""')).map(value);
    expect(sent).toEqual(["rosh_hashana", "yom_kippur"]);
  });

  it("a holiday picked on its own is kept (as a hidden field) while the switch locks it", () => {
    const { hidden } = inputs(render(true, false, ["yom_kippur", "purim"]));
    expect(hidden).toEqual(["yom_kippur"]);
    const { boxes, value } = inputs(render(true, false, ["yom_kippur", "purim"]));
    const purim = boxes.find((t) => value(t) === "purim") ?? "";
    expect(purim).toContain(' checked=""');
    expect(purim).toContain('name="rest_occasions"');
  });

  it("saving keeps holiday keys", () => {
    const data = new FormData();
    for (const key of ["yom_kippur", "purim", "rosh_hashana"]) data.append("rest_occasions", key);
    const parsed = calendarSettingsSchema.safeParse(calendarSettingsFromForm(data));
    expect(parsed.success && parsed.data.rest_occasions).toEqual(["rosh_hashana", "yom_kippur", "purim"]);
  });

  it("one column on a phone, more only from sm; rows may shrink", () => {
    const html = render(true, true, []);
    expect(html).toMatch(/^<div class="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">/);
    expect((html.match(/min-w-0/g) ?? []).length).toBeGreaterThanOrEqual(OCCASIONS.length);
  });
});
