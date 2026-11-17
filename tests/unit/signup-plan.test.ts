import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { availableSignupPlan, signupHrefWithPlan, signupHrefWithSource, signupPlanKey } from "@/features/landing/measure";
import { oauthCallbackPath, oauthSignupCountedSource, oauthSignupMetadata } from "@/features/auth/oauth-signup";
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
    expect(availableSignupPlan(plans, "basic")).toEqual({ key: "basic", name: "בסיסית", free: false });
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

describe("zero-price plan on the sign-up page (WEB-02, (402) ב)", () => {
  it("is free only when both prices are zero", () => {
    const plans = [
      { key: "free", name: "חינם", availability: "available", priceMonthlyAgorot: 0, priceAnnualAgorot: 0 },
      { key: "half", name: "חצי", availability: "available", priceMonthlyAgorot: 0, priceAnnualAgorot: 900 },
      { key: "basic", name: "בסיסית", availability: "available", priceMonthlyAgorot: 6900, priceAnnualAgorot: 5900 },
    ];
    expect(availableSignupPlan(plans, "free")).toEqual({ key: "free", name: "חינם", free: true });
    expect(availableSignupPlan(plans, "half")?.free).toBe(false);
    expect(availableSignupPlan(plans, "basic")?.free).toBe(false);
  });
});

describe("Google sign-up carries the plan and the source (WEB-02, (403) ב)", () => {
  it("builds the callback query: next as before, a well-formed source and plan, never for an invitation", () => {
    expect(oauthCallbackPath("/")).toBe("/auth/callback");
    expect(oauthCallbackPath("/o/x")).toBe("/auth/callback?next=%2Fo%2Fx");
    expect(oauthCallbackPath("/", "facebook", "basic")).toBe("/auth/callback?src=facebook&plan=basic");
    expect(oauthCallbackPath("/", "Not Folded", "Bad Key")).toBe("/auth/callback");
    expect(oauthCallbackPath("/", null, "pro")).toBe("/auth/callback?plan=pro");
    expect(oauthCallbackPath("/invite/abc", "facebook", "basic")).toBe("/auth/callback?next=%2Finvite%2Fabc");
    // the callback reads next back exactly
    const url = new URL(`https://x.test${oauthCallbackPath("/o/a b?c=1", "direct", "pro")}`);
    expect(url.searchParams.get("next")).toBe("/o/a b?c=1");
    expect(url.searchParams.get("src")).toBe("direct");
    expect(url.searchParams.get("plan")).toBe("pro");
  });

  const now = new Date("2026-11-17T12:00:00Z");
  const fresh = { created_at: "2026-11-17T11:59:50Z", identities: [{ provider: "google" }], user_metadata: { full_name: "x" } };
  const params = { next: "/", source: "facebook", plan: "basic" };

  it("writes the metadata only for a brand-new account", () => {
    expect(oauthSignupMetadata(params, fresh, now)).toEqual({ signup_plan: "basic", signup_source: "facebook" });
    expect(oauthSignupMetadata(params, { ...fresh, created_at: "2026-11-01T00:00:00Z" }, now)).toBeNull();
    expect(oauthSignupMetadata(params, { ...fresh, identities: [] }, now)).toBeNull();
    expect(oauthSignupMetadata(params, null, now)).toBeNull();
  });

  it("never for an invitation, never a malformed value, never over a value already set", () => {
    expect(oauthSignupMetadata({ ...params, next: "/invite/abc" }, fresh, now)).toBeNull();
    expect(oauthSignupMetadata({ next: "/", source: "Bad Source", plan: "PRO" }, fresh, now)).toBeNull();
    expect(oauthSignupMetadata({ next: "/", source: null, plan: null }, fresh, now)).toBeNull();
    expect(oauthSignupMetadata(params, { ...fresh, user_metadata: { signup_plan: "pro" } }, now)).toEqual({ signup_source: "facebook" });
    expect(oauthSignupMetadata(params, { ...fresh, user_metadata: { signup_plan: "pro", signup_source: "x" } }, now)).toBeNull();
  });

  it("counts a Google sign-up as an LND-14 signup only for a new account with a source, never an invitation ((405) א)", () => {
    expect(oauthSignupCountedSource({ next: "/", source: "facebook" }, fresh, now)).toBe("facebook");
    expect(oauthSignupCountedSource({ next: "/", source: "direct" }, fresh, now)).toBe("direct");
    expect(oauthSignupCountedSource({ next: "/", source: null }, fresh, now)).toBeNull();
    expect(oauthSignupCountedSource({ next: "/", source: "Bad Source" }, fresh, now)).toBeNull();
    expect(oauthSignupCountedSource({ next: "/invite/abc", source: "facebook" }, fresh, now)).toBeNull();
    expect(oauthSignupCountedSource({ next: "/", source: "facebook" }, { ...fresh, created_at: "2026-11-01T00:00:00Z" }, now)).toBeNull();
    expect(oauthSignupCountedSource({ next: "/", source: "facebook" }, null, now)).toBeNull();
    const route = readFileSync("src/app/auth/callback/route.ts", "utf8");
    expect(route).toMatch(/if \(countedSource\) await recordLandingEvent\("signup", countedSource, request\.headers\)/);
  });

  it("the callback writes with the person's own session and never a cookie; the button passes the query", () => {
    const route = readFileSync("src/app/auth/callback/route.ts", "utf8");
    expect(route).toMatch(/oauthSignupMetadata\(/);
    expect(route).toMatch(/supabase\.auth\.updateUser\(\{ data: signupMeta \}\)/);
    expect(route).not.toMatch(/cookies\(\)|service/);
    const button = readFileSync("src/features/auth/components/google-button.tsx", "utf8");
    expect(button).toMatch(/oauthCallbackPath\(next, landingSource, signupPlan\)/);
  });
});
