import { describe, expect, it } from "vitest";

import {
  CARD_LAYOUT_BUILT_IN,
  CARD_LAYOUT_TYPES,
  cleanLayout,
  defaultLayout,
  layoutProblem,
  layoutSchema,
  MORE_FIELDS_TITLE,
  parseLayout,
  resolveLayout,
  splitColumns,
  TITLE_EDGE_SPACE,
  unsavedLayout,
} from "@/features/card-layout/layout";

// FLD-08: the card layout rules that run in the app (the database mirror is tests/db/99-card-layouts.test.ts)
describe("card layout (FLD-08)", () => {
  it("the default layout is one group with every built-in field, then the custom fields, and passes the rules", () => {
    for (const type of CARD_LAYOUT_TYPES) {
      const layout = defaultLayout(type, [{ key: "budget_x" }, { key: "size" }]);
      expect(layout).toHaveLength(1);
      expect(layout[0].fields).toEqual([...CARD_LAYOUT_BUILT_IN[type].map((f) => f.key), "cf:budget_x", "cf:size"]);
      expect(layoutSchema(type).safeParse(layout).success, type).toBe(true);
    }
  });

  it("the default layout keeps at most 60 fields; the rest show in the final group", () => {
    const many = Array.from({ length: 70 }, (_, i) => ({ key: `f${i}` }));
    const layout = defaultLayout("deal", many);
    expect(layout[0].fields).toHaveLength(60);
    const known = [...CARD_LAYOUT_BUILT_IN.deal.map((f) => f.key), ...many.map((d) => `cf:${d.key}`)];
    const resolved = resolveLayout(layout, known);
    // a saved layout keeps the cap: the rest show in the final group
    expect(resolved.map((g) => g.fields.length)).toEqual([60, 23]);
    expect(resolved[1].title).toBe(MORE_FIELDS_TITLE);
  });

  it("with no saved layout the card is today's card: one group with every field, no cap", () => {
    const known = [...CARD_LAYOUT_BUILT_IN.lead.map((f) => f.key), ...Array.from({ length: 500 }, (_, i) => `cf:f${i}`)];
    const groups = unsavedLayout(known);
    expect(groups).toHaveLength(1);
    expect(groups[0].fields).toEqual(known);
  });

  it("a title may not start or end with any white space that trim() removes, and nothing else", () => {
    for (let code = 0; code <= 0xffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const ch = String.fromCharCode(code);
      const trimmed = (ch + "א").trim() !== ch + "א";
      expect(TITLE_EDGE_SPACE.test(ch + "א"), code.toString(16)).toBe(trimmed);
      expect(TITLE_EDGE_SPACE.test("א" + ch), code.toString(16)).toBe(trimmed);
    }
    expect(TITLE_EDGE_SPACE.test("א ב")).toBe(false);
  });

  it("a field placed in no group shows in the final group; unknown keys and empty groups are skipped", () => {
    const resolved = resolveLayout(
      [
        { title: "קשר", columns: 2, fields: ["phone", "cf:gone", "email"] },
        { title: "ריקה", columns: 1, fields: ["cf:gone"] },
      ],
      ["full_name", "phone", "email", "cf:size"],
    );
    expect(resolved).toEqual([
      { title: "קשר", columns: 2, fields: ["phone", "email"] },
      { title: MORE_FIELDS_TITLE, columns: 1, fields: ["full_name", "cf:size"] },
    ]);
  });

  it("a field hidden on this record (not in the known list) is never added back", () => {
    expect(resolveLayout([{ title: "א", columns: 1, fields: ["lost_reason", "owner_id"] }], ["owner_id"])).toEqual([
      { title: "א", columns: 1, fields: ["owner_id"] },
    ]);
  });

  it("splits two columns with the extra item in the first", () => {
    expect(splitColumns([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
    expect(splitColumns([1, 2, 3], 1)).toEqual([[1, 2, 3]]);
    expect(splitColumns([1], 2)).toEqual([[1]]);
  });

  it("cleaning trims titles and drops unknown and repeated keys", () => {
    expect(
      cleanLayout(
        [
          { title: "  קשר ", columns: 2, fields: ["phone", "phone", "cf:x"] },
          { title: "ב", columns: 1, fields: ["phone", "email"] },
        ],
        ["phone", "email"],
      ),
    ).toEqual([
      { title: "קשר", columns: 2, fields: ["phone"] },
      { title: "ב", columns: 1, fields: ["email"] },
    ]);
  });

  it("the shape rules match the database limits", () => {
    const schema = layoutSchema("lead");
    const ok = { title: "א", columns: 1, fields: [] };
    expect(schema.safeParse([ok]).success).toBe(true);
    expect(schema.safeParse(Array.from({ length: 21 }, () => ok)).success).toBe(false);
    expect(schema.safeParse([{ ...ok, title: "" }]).success).toBe(false);
    expect(schema.safeParse([{ ...ok, title: " א" }]).success).toBe(false);
    expect(schema.safeParse([{ ...ok, title: "א".repeat(60) }]).success).toBe(true);
    expect(schema.safeParse([{ ...ok, title: "א".repeat(61) }]).success).toBe(false);
    expect(schema.safeParse([{ ...ok, columns: 3 }]).success).toBe(false);
    expect(schema.safeParse([{ ...ok, extra: 1 }]).success).toBe(false);
    expect(schema.safeParse([{ ...ok, fields: ["phone", "phone"] }]).success).toBe(false);
    expect(schema.safeParse([{ ...ok, fields: ["amount"] }]).success).toBe(false);
    expect(schema.safeParse([{ ...ok, fields: ["cf:Bad"] }]).success).toBe(false);
    expect(schema.safeParse([{ ...ok, fields: Array.from({ length: 61 }, (_, i) => `cf:k${i}`) }]).success).toBe(false);
    expect(parseLayout("lead", "nonsense")).toBeNull();
  });

  it("explains in Hebrew what the database would refuse", () => {
    expect(layoutProblem([{ title: "א", columns: 1, fields: [] }])).toBeNull();
    expect(layoutProblem([{ title: "  ", columns: 1, fields: [] }])).toBe("לכל קבוצה צריך כותרת.");
    expect(layoutProblem([{ title: "א", columns: 1, fields: Array.from({ length: 61 }, (_, i) => `cf:k${i}`) }])).toContain("60");
  });
});
