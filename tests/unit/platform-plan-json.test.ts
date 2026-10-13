import { describe, expect, it } from "vitest";

import { parsePlanJson } from "@/features/platform/plan-json";
import { dbErrorMessage } from "@/lib/errors";

describe("plan and override JSON typed by platform staff", () => {
  it("accepts booleans for features and non-negative numbers or null for limits; empty = {}", () => {
    expect(parsePlanJson("", "features")).toEqual({ ok: true, value: {} });
    expect(parsePlanJson('{"goals": false, "remove_built_with": true}', "features")).toEqual({
      ok: true,
      value: { goals: false, remove_built_with: true },
    });
    expect(parsePlanJson('{"max_users": null, "max_products": 0, "storage_gb": 1.5}', "limits")).toEqual({
      ok: true,
      value: { max_users: null, max_products: 0, storage_gb: 1.5 },
    });
  });

  it("refuses a feature that is not true or false", () => {
    for (const raw of ['{"goals": "true"}', '{"goals": 1}', '{"goals": null}', '{"goals": {}}']) {
      const r = parsePlanJson(raw, "features");
      expect(r.ok, raw).toBe(false);
      expect(!r.ok && r.message).toContain("ערך דגל חייב להיות true או false");
      expect(!r.ok && r.message).toContain("goals");
    }
  });

  it("refuses a limit that is not a number or null", () => {
    for (const raw of ['{"max_products": "100"}', '{"max_products": true}', '{"max_products": -1}', '{"max_products": [1]}']) {
      const r = parsePlanJson(raw, "limits");
      expect(r.ok, raw).toBe(false);
      expect(!r.ok && r.message).toContain("ערך מגבלה");
    }
  });

  it("refuses what is not a JSON object", () => {
    for (const raw of ["[]", "5", "null", "{", '"x"']) {
      expect(parsePlanJson(raw, "limits").ok, raw).toBe(false);
      expect(parsePlanJson(raw, "features").ok, raw).toBe(false);
    }
  });

  it("the hidden-plan refusal has its own Hebrew message", () => {
    expect(dbErrorMessage({ code: "P0001", message: "this plan is no longer offered", hint: "plan:hidden" })).toBe("החבילה הזו לא זמינה יותר לבחירה.");
  });
});
