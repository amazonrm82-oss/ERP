import { describe, expect, it } from "vitest";

import { filterFields, filterToPostgrest } from "@/features/list-filters/server";
import type { FilterTree } from "@/features/list-filters/model";
import { typeChoices, typeIdFromForm, type RecordType } from "@/features/record-type-options/schema";

// CON-02
const SUPPLIER = "55555555-5555-4555-8555-555555555555";
const OLD = "66666666-6666-4666-8666-666666666666";
const types: RecordType[] = [
  { id: SUPPLIER, name: "ספק", position: 0, isActive: true },
  { id: OLD, name: "ישן", position: 1, isActive: false },
];

describe("contact and company types", () => {
  it("the form offers active types, and keeps a hidden one the record already has", () => {
    expect(typeChoices(types, null).map((c) => c.label)).toEqual(["ספק"]);
    expect(typeChoices(types, OLD).map((c) => c.label)).toEqual(["ספק", "ישן (מוסתר)"]);
    expect(typeChoices([], null)).toEqual([]);
  });

  it("a form without the field leaves the type alone; an empty choice clears it", () => {
    expect(typeIdFromForm(new FormData())).toEqual({ ok: true, patch: {} });
    const empty = new FormData();
    empty.set("type_id", "");
    expect(typeIdFromForm(empty)).toEqual({ ok: true, patch: { type_id: null } });
    const picked = new FormData();
    picked.set("type_id", SUPPLIER);
    expect(typeIdFromForm(picked)).toEqual({ ok: true, patch: { type_id: SUPPLIER } });
    const bad = new FormData();
    bad.set("type_id", "ספק");
    expect(typeIdFromForm(bad).ok).toBe(false);
  });

  it("the contacts and companies lists filter by type id, only ids from the list", () => {
    for (const object of ["contact", "company"] as const) {
      const fields = filterFields(object, { members: [], tags: [], fields: [], types: [{ value: SUPPLIER, label: "ספק" }] });
      const one = (value: string, op = "is") =>
        filterToPostgrest({ match: "all", groups: [{ match: "all", conditions: [{ field: "type", op, value }] }] } as FilterTree, fields, {
          userId: SUPPLIER,
          now: new Date(),
        }).logic;
      expect(one(SUPPLIER)).toBe(`and(and(type_id.eq.${SUPPLIER}))`);
      expect(one(SUPPLIER, "is_not")).toBe(`and(and(or(type_id.is.null,type_id.neq.${SUPPLIER})))`);
      expect(one(OLD)).toBeNull();
    }
  });
});
