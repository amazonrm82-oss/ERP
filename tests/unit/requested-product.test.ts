import { describe, expect, it } from "vitest";

import { catalogFor } from "@/features/list-columns/columns";
import { REQUESTED_PRODUCT_FIELD, requestedProductFromForm, requestedProductNote } from "@/features/requested-product/schema";

const form = (entries: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
};

// LEAD-04: the requested product field on lead forms
describe("requested product (LEAD-04)", () => {
  it("a form without the field leaves the stored product alone", () => {
    expect(requestedProductFromForm(form({ full_name: "דנה" }))).toEqual({ ok: true, patch: {} });
  });

  it("an empty field clears it, an id sets it, anything else is refused", () => {
    expect(requestedProductFromForm(form({ [REQUESTED_PRODUCT_FIELD]: "" }))).toEqual({ ok: true, patch: { requested_product_id: null } });
    const id = "3f2b8c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b";
    expect(requestedProductFromForm(form({ [REQUESTED_PRODUCT_FIELD]: id }))).toEqual({ ok: true, patch: { requested_product_id: id } });
    expect(requestedProductFromForm(form({ [REQUESTED_PRODUCT_FIELD]: "not-an-id" })).ok).toBe(false);
  });

  it("says why a stored product can no longer be picked", () => {
    expect(requestedProductNote({ isActive: true, archivedAt: null })).toBeNull();
    expect(requestedProductNote({ isActive: false, archivedAt: null })).toBe("לא פעיל");
    expect(requestedProductNote({ isActive: false, archivedAt: "2026-10-13T00:00:00Z" })).toBe("בארכיון");
  });

  it("the lead list offers the column only with the product catalog", () => {
    expect(catalogFor("lead", [], { products: true }).map((column) => column.key)).toContain("product");
    expect(catalogFor("lead", []).map((column) => column.key)).not.toContain("product");
    expect(catalogFor("lead", [], { products: false }).map((column) => column.key)).not.toContain("product");
    // other lists never had it
    expect(catalogFor("contact", [], { products: true }).map((column) => column.key)).not.toContain("product");
  });
});
