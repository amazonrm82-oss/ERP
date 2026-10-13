import { describe, expect, it } from "vitest";

import {
  completenessCatalog,
  completenessFieldsSchema,
  completenessLabel,
  COMPLETENESS_BUILT_IN,
  COMPLETENESS_DEFAULTS,
  COMPLETENESS_TYPES,
  editFocusParam,
  formFieldFor,
  missingText,
  pickedKeys,
} from "@/features/data-quality/completeness";
import { catalogFor } from "@/features/list-columns/columns";

// DQL-01: the names and keys of the important fields (the score is computed in the database).
describe("record completeness catalog", () => {
  it("defaults are built-in keys and pass the database's shape check", () => {
    for (const type of COMPLETENESS_TYPES) {
      const keys = COMPLETENESS_BUILT_IN[type].map((f) => f.key);
      expect(COMPLETENESS_DEFAULTS[type].every((k) => keys.includes(k)), type).toBe(true);
      expect(completenessFieldsSchema.safeParse(keys).success, type).toBe(true);
      expect(new Set(keys).size, type).toBe(keys.length);
    }
    // spec 22.9
    expect(COMPLETENESS_DEFAULTS.lead).toEqual(["contact", "source_id", "owner_id"]);
  });

  it("adds custom fields as cf:<key> and keeps catalog order when saving", () => {
    const catalog = completenessCatalog("lead", [{ key: "budget", label: "תקציב" }]);
    expect(catalog.at(-1)).toEqual({ key: "cf:budget", label: "תקציב" });
    // unknown keys are dropped; order follows the catalog, not the form
    expect(pickedKeys(catalog, ["cf:budget", "owner_id", "nope", "contact"])).toEqual(["contact", "owner_id", "cf:budget"]);
    expect(completenessLabel(catalog, "cf:gone")).toBeNull();
    expect(completenessLabel(catalog, "source_id")).toBe("מקור");
  });

  it("refuses a list the database would refuse", () => {
    expect(completenessFieldsSchema.safeParse(["phone", "phone"]).success).toBe(false);
    expect(completenessFieldsSchema.safeParse(["Phone"]).success).toBe(false);
    expect(completenessFieldsSchema.safeParse(Array.from({ length: 41 }, (_, i) => `k${i}`)).success).toBe(false);
    expect(completenessFieldsSchema.safeParse([]).success).toBe(true);
  });

  it("maps a missing key to the input that fills it", () => {
    expect(formFieldFor("lead", "contact")).toBe("phone");
    expect(formFieldFor("lead", "owner_id")).toBeNull();
    expect(formFieldFor("contact", "email")).toBe("emails");
    expect(formFieldFor("deal", "amount_agorot")).toBe("amount");
    expect(formFieldFor("company", "cf:size_band")).toBe("cf_size_band");
    expect(formFieldFor("lead", "unknown")).toBeNull();
  });

  it("reads the edit parameter safely", () => {
    expect(editFocusParam("phone")).toBe("phone");
    expect(editFocusParam(["cf_budget", "x"])).toBe("cf_budget");
    expect(editFocusParam('phone"]')).toBeNull();
    expect(editFocusParam(undefined)).toBeNull();
  });

  it("the leads and contacts lists offer the column", () => {
    expect(catalogFor("lead", []).some((c) => c.key === "completeness")).toBe(true);
    expect(catalogFor("contact", []).some((c) => c.key === "completeness")).toBe(true);
    expect(missingText([])).toBe("הכול מלא");
    expect(missingText(["טלפון", "מקור"])).toBe("חסר: טלפון, מקור");
  });
});
