import { describe, expect, it } from "vitest";

import { PLAN_CAPABILITIES, planCapabilities } from "@/features/plans/capabilities";

describe("plan capabilities", () => {
  it("lists core CRM data on every plan, with or without flags", () => {
    expect(planCapabilities({}).map((item) => item.feature)).toContain("billing_details");
    expect(planCapabilities(null).map((item) => item.feature)).toContain("billing_details");
  });

  it("lists a flagged capability only when the plan holds its flag", () => {
    expect(planCapabilities({ products: true }).map((item) => item.feature)).toContain("products");
    expect(planCapabilities({ products: false }).map((item) => item.feature)).not.toContain("products");
  });

  it("names each capability once", () => {
    const keys = PLAN_CAPABILITIES.map((item) => item.feature);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
