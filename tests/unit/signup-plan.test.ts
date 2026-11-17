import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { availableSignupPlan, signupHrefWithPlan, signupHrefWithSource, signupPlanKey } from "@/features/landing/measure";
import { parseSignupOrigin, signupPlanText, signupSourceText } from "@/features/platform/signup-origin";

// WEB-02: the price card's plan travels /go/signup -> /signup -> the sign-up form -> the person's own Auth metadata.

describe("plan key shape", () => {
  it("takes a closed shape only, first value of a repeat", () => {
    expect(signupPlanKey("pro")).toBe("pro");
    expect(signupPlanKey(["basic", "pro"])).toBe("basic");
    for (const bad of ["", "PRO", "1pro", "pro-x", "pro plan", "a".repeat(41), null, undefined, 3, "pro?x=1"]) expect(signupPlanKey(bad)).toBeNull();
  });

  it("adds the plan to a sign-up link, keeping its source", () => {
    expect(signupHrefWithPlan("/go/signup?src=google", "basic")).toBe("/go/signup?src=google&plan=basic");
    expect(signupHrefWithPlan("/signup", "pro")).toBe("/signup?plan=pro");
    expect(signupHrefWithPlan("/go/signup?src=x&plan=old", "pro")).toBe("/go/signup?src=x&plan=pro");
    expect(signupHrefWithPlan("/signup", "Bad Key")).toBe("/signup");
  });

  it("/go/signup passes source and plan on to /signup", () => {
    expect(signupHrefWithSource("direct", "pro")).toBe("/signup?src=direct&plan=pro");
    expect(signupHrefWithSource(null, "pro")).toBe("/signup?plan=pro");
    expect(signupHrefWithSource("direct")).toBe("/signup?src=direct");
    expect(signupHrefWithSource(null)).toBe("/signup");
  });

  it("the sign-up page honours only an available plan, silently ignoring the rest", () => {
    const plans = [
      { key: "basic", name: "בסיסית", availability: "available" },
      { key: "business", name: "עסקית", availability: "coming_soon" },
    ];
    expect(availableSignupPlan(plans, "basic")).toEqual({ key: "basic", name: "בסיסית" });
    expect(availableSignupPlan(plans, "business")).toBeNull();
    expect(availableSignupPlan(plans, "free")).toBeNull();
    expect(availableSignupPlan(plans, "BASIC")).toBeNull();
    expect(availableSignupPlan(null, "basic")).toBeNull();
  });

  it("the route reads the plan and the sign-up action writes it only into the user's metadata", () => {
    const route = readFileSync("src/app/go/signup/route.ts", "utf8");
    expect(route).toMatch(/signupPlanKey\(url\.searchParams\.get\(SIGNUP_PLAN_PARAM\)\)/);
    const actions = readFileSync("src/features/auth/actions.ts", "utf8");
    expect(actions).toMatch(/signup_plan: signupPlan/);
    expect(actions).toMatch(/const signupPlan = invited \? null : signupPlanKey/);
    expect(actions).not.toMatch(/cookies\(\)/);
  });
});

describe("platform panel: sign-up origin", () => {
  it("reads strictly and words the source in Hebrew", () => {
    expect(parseSignupOrigin("facebook", "pro")).toEqual({ source: "facebook", planKey: "pro" });
    expect(parseSignupOrigin("<b>", "Pro!")).toEqual({ source: null, planKey: null });
    expect(signupSourceText(null)).toBe("לא נרשם");
    expect(signupSourceText("direct")).toBe("ישירות (בלי מקור)");
    expect(signupSourceText("other")).toBe("אחר");
    expect(signupSourceText("google")).toBe("google");
    expect(signupPlanText("pro", [{ key: "pro", name_he: "מקצועית" }])).toBe("מקצועית");
    expect(signupPlanText("gone", [])).toBe("gone");
    expect(signupPlanText(null, [])).toBeNull();
  });
});
