import { describe, expect, it } from "vitest";

import { setupDetailsSchema, setupIndustrySchema, setupStepArg } from "@/features/setup/schema";
import { alreadyPast, isSetupStep, progressWrite, SETUP_STEP_COUNT, stepAfter, stepToShow, WRITABLE_ORG_STATUSES } from "@/features/setup/steps";
import { paths } from "@/lib/paths";

// USR-03: the setup wizard. Four steps, each can be skipped, progress kept per organization.
describe("setup wizard steps", () => {
  it("has four steps", () => {
    expect(SETUP_STEP_COUNT).toBe(4);
    expect([0, 1, 4, 5, 1.5, "1", null].map(isSetupStep)).toEqual([false, true, true, false, false, false, false]);
  });

  it("progress moves forward only, and leaving the last step finishes the wizard", () => {
    // steps 1 to 3 write the next step, only where the stored one is below it
    expect(progressWrite(1)).toEqual({ setTo: 2, onlyBelow: true });
    expect(progressWrite(3)).toEqual({ setTo: 4, onlyBelow: true });
    // the last step finishes, whatever was stored
    expect(progressWrite(4)).toEqual({ setTo: null, onlyBelow: false });
  });

  it("a conditional write that touched nothing is fine when progress was already there or further", () => {
    // an earlier step opened again and saved: progress stays at 4
    expect(alreadyPast(4, 2)).toBe(true);
    expect(alreadyPast(2, 2)).toBe(true);
    // a finished wizard stays finished
    expect(alreadyPast(null, 2)).toBe(true);
    // still below: the write was refused (not permitted)
    expect(alreadyPast(1, 2)).toBe(false);
  });

  it("only a writable business changes (as canWrite)", () => {
    expect([...WRITABLE_ORG_STATUSES].sort()).toEqual(["active", "past_due", "trial"]);
  });

  it("each step leads to the next one, the last one back to the app", () => {
    expect(stepAfter(1)).toBe(2);
    expect(stepAfter(3)).toBe(4);
    expect(stepAfter(4)).toBeNull();
  });

  it("a visit shows the step asked for, else where the business stopped", () => {
    expect(stepToShow(3, undefined)).toBe(3);
    expect(stepToShow(3, "1")).toBe(1);
    expect(stepToShow(null, "2")).toBe(2);
    expect(stepToShow(null, undefined)).toBeNull();
    for (const bad of ["0", "5", "x", "12", "", ["1", "2"]]) {
      expect(stepToShow(2, bad)).toBe(2);
    }
  });

  it("builds the wizard address", () => {
    expect(paths.setup("o1")).toBe("/o/o1/setup");
    expect(paths.setup("o1", 3)).toBe("/o/o1/setup?step=3");
  });
});

describe("setup wizard forms use the business details rules", () => {
  it("step 1 needs a name and a visibility, and ignores the industry", () => {
    expect(setupDetailsSchema.safeParse({ name: "", record_visibility: "org" }).success).toBe(false);
    expect(setupDetailsSchema.safeParse({ name: "עסק", record_visibility: "everyone" }).success).toBe(false);
    const parsed = setupDetailsSchema.safeParse({ name: "עסק", team_size: "2-5", phone: "", record_visibility: "team", industry: "x" });
    expect(parsed.success).toBe(true);
    expect(parsed.data && "industry" in parsed.data).toBe(false);
  });

  it("step 2 takes an industry from the list, or none", () => {
    expect(setupIndustrySchema.safeParse({ industry: "real_estate" }).success).toBe(true);
    expect(setupIndustrySchema.safeParse({ industry: "" }).success).toBe(true);
    expect(setupIndustrySchema.safeParse({ industry: "mining" }).success).toBe(false);
  });

  it("a step argument is 1 to 4", () => {
    expect([1, 4].every((s) => setupStepArg.safeParse(s).success)).toBe(true);
    expect([0, 5, 2.5, "2"].some((s) => setupStepArg.safeParse(s).success)).toBe(false);
  });
});
