import { describe, expect, it } from "vitest";

import { EDGE_MAX_STEP, EDGE_ZONE, edgeStep, moveTexts, stepStage } from "@/features/deals/board-drag";

const stages = [
  { id: "a", name: "ליד" },
  { id: "b", name: "פגישה" },
  { id: "c", name: "הצעה" },
  { id: "d", name: "נסגר" },
];

describe("moving a deal with the keyboard (DEAL-10)", () => {
  it("goes forward with ArrowLeft in a right-to-left page, the first stage on the right", () => {
    expect(stepStage(stages, "b", "ArrowLeft", true)).toBe("c");
    expect(stepStage(stages, "b", "ArrowRight", true)).toBe("a");
  });

  it("goes forward with ArrowRight in a left-to-right page", () => {
    expect(stepStage(stages, "b", "ArrowRight", false)).toBe("c");
    expect(stepStage(stages, "b", "ArrowLeft", false)).toBe("a");
  });

  it("goes forward and back with the up and down arrows, and jumps with Home and End", () => {
    expect(stepStage(stages, "b", "ArrowDown", true)).toBe("c");
    expect(stepStage(stages, "b", "ArrowUp", true)).toBe("a");
    expect(stepStage(stages, "c", "Home", true)).toBe("a");
    expect(stepStage(stages, "a", "End", true)).toBe("d");
  });

  it("stops at the ends and ignores other keys", () => {
    expect(stepStage(stages, "a", "ArrowRight", true)).toBeNull();
    expect(stepStage(stages, "d", "ArrowLeft", true)).toBeNull();
    expect(stepStage(stages, "a", "Home", true)).toBeNull();
    expect(stepStage(stages, "b", "x", true)).toBeNull();
    expect(stepStage(stages, "missing", "ArrowLeft", true)).toBeNull();
    expect(stepStage([], "a", "ArrowLeft", true)).toBeNull();
  });

  it("announces each step in Hebrew", () => {
    expect(moveTexts.over("הצעה", 3, 4, false)).toBe("הצעה, שלב 3 מתוך 4.");
    expect(moveTexts.over("פגישה", 2, 4, true)).toContain("השלב הנוכחי");
    expect(moveTexts.lifted("אתר", "ליד")).toContain("Escape");
    expect(moveTexts.cancelled("אתר")).toContain("בוטלה");
  });
});

describe("scrolling by itself near an edge while a finger drags (DEAL-10)", () => {
  it("does nothing away from the edges", () => {
    expect(edgeStep(500, 0, 1000)).toBe(0);
    expect(edgeStep(EDGE_ZONE, 0, 1000)).toBe(0);
  });

  it("scrolls toward the near edge, faster the closer", () => {
    const near = edgeStep(5, 0, 1000);
    const less = edgeStep(EDGE_ZONE - 5, 0, 1000);
    expect(near).toBeLessThan(0);
    expect(less).toBeLessThan(0);
    expect(Math.abs(near)).toBeGreaterThan(Math.abs(less));
    expect(edgeStep(995, 0, 1000)).toBeGreaterThan(0);
  });

  it("is never faster than the maximum, also past the edge", () => {
    expect(edgeStep(-50, 0, 1000)).toBe(-EDGE_MAX_STEP);
    expect(edgeStep(1050, 0, 1000)).toBe(EDGE_MAX_STEP);
  });

  it("on a strip too narrow for two zones, scrolls only past its ends", () => {
    expect(edgeStep(50, 0, 100)).toBe(0);
    expect(edgeStep(-1, 0, 100)).toBe(-EDGE_MAX_STEP);
    expect(edgeStep(101, 0, 100)).toBe(EDGE_MAX_STEP);
  });
});
