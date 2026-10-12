import { describe, expect, it } from "vitest";

import { LONG_PRESS_MS, LONG_PRESS_SLOP, pressDistance, pressOutcome } from "@/features/calendar/long-press";

describe("long press on a touch screen (CAL-02)", () => {
  it("waits while the finger rests, then lifts the item", () => {
    expect(pressOutcome(0, 0)).toBe("wait");
    expect(pressOutcome(3, LONG_PRESS_MS - 1)).toBe("wait");
    expect(pressOutcome(0, LONG_PRESS_MS)).toBe("lift");
    expect(pressOutcome(LONG_PRESS_SLOP, LONG_PRESS_MS + 200)).toBe("lift");
  });

  it("cancels when the finger moves past the slop first, so the page scrolls", () => {
    expect(pressOutcome(LONG_PRESS_SLOP + 0.5, 10)).toBe("cancel");
    // a long, slow swipe is still a scroll
    expect(pressOutcome(40, LONG_PRESS_MS * 3)).toBe("cancel");
    expect(pressOutcome(Number.NaN, LONG_PRESS_MS)).toBe("cancel");
  });

  it("measures the distance in any direction", () => {
    expect(pressDistance({ x: 10, y: 10 }, { x: 13, y: 14 })).toBe(5);
    expect(pressDistance({ x: 10, y: 10 }, { x: 7, y: 6 })).toBe(5);
  });

  it("uses a press long enough to tell from a tap and a slop small enough to keep scrolling", () => {
    expect(LONG_PRESS_MS).toBeGreaterThanOrEqual(350);
    expect(LONG_PRESS_MS).toBeLessThanOrEqual(600);
    expect(LONG_PRESS_SLOP).toBeLessThanOrEqual(10);
  });
});
