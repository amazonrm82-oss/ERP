import { describe, expect, it } from "vitest";

import { PLAN_CAPABILITIES, planCapabilities } from "@/features/plans/capabilities";

describe("plan capabilities", () => {
  it("lists core CRM data on every plan, with or without flags", () => {
    expect(planCapabilities({}).map((item) => item.feature)).toContain("billing_details");
    expect(planCapabilities(null).map((item) => item.feature)).toContain("billing_details");
    // CON-05 (owner, 15 October 2026): core
    expect(planCapabilities({}).map((item) => item.feature)).toContain("contact_companies");
    // CON-06 (owner, 15 October 2026): core
    expect(planCapabilities({}).map((item) => item.feature)).toContain("contact_relations");
  });

  it("lists a flagged capability only when the plan holds its flag", () => {
    expect(planCapabilities({ products: true }).map((item) => item.feature)).toContain("products");
    expect(planCapabilities({ products: false }).map((item) => item.feature)).not.toContain("products");
  });

  it("lists line discounts under their own flag (DSC-01)", () => {
    expect(planCapabilities({ discounts: true }).map((item) => item.feature)).toContain("discounts");
    expect(planCapabilities({ discounts: false }).map((item) => item.feature)).not.toContain("discounts");
    expect(PLAN_CAPABILITIES.find((item) => item.feature === "discounts")?.built).toBe(true);
  });

  it("marks the merged money modules as built (RVW-43)", () => {
    for (const key of ["quotes", "orders", "documents", "payments", "collection"]) {
      expect(PLAN_CAPABILITIES.find((item) => item.feature === key)?.built, key).toBe(true);
    }
  });

  it("names each capability once", () => {
    const keys = PLAN_CAPABILITIES.map((item) => item.feature);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
