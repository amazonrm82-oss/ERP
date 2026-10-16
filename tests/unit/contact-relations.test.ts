import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { addRelationSchema, relationTypeSchema } from "@/features/contact-relations/schema";
import {
  CONTACT_RELATION_NAME_MAX,
  DEFAULT_CONTACT_RELATION_TYPES,
  parseRelationChoice,
  relationChoices,
  relationPhrase,
  type ContactRelationType,
} from "@/features/contact-relations/types";

const migration = () => {
  const dir = join(process.cwd(), "supabase/migrations");
  return readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith("_contact_relations.sql"))!), "utf8");
};

const PARENT = "00000000-0000-4000-8000-000000000001";
const SPOUSE = "00000000-0000-4000-8000-000000000002";
const HIDDEN = "00000000-0000-4000-8000-000000000003";
const types: ContactRelationType[] = [
  { id: SPOUSE, name: "בן/בת זוג של", reverseName: null, key: "spouse", isActive: true },
  { id: PARENT, name: "הורה של", reverseName: "ילד/ה של", key: "parent", isActive: true },
  { id: HIDDEN, name: "שכן/ה של", reverseName: null, key: null, isActive: false },
];

// CON-06: relation types and the phrases of each side
describe("relations between contacts (CON-06)", () => {
  it("the defaults are the database's seed, in order", () => {
    const seed = /from \(values ([\s\S]*?)\) as d\(name, reverse_name, key, pos\)/.exec(migration())?.[1] ?? "";
    const rows = [...seed.matchAll(/\('([^']+)', (null|'[^']+'), '([a-z]+)', (\d+)\)/g)].map((m) => ({
      key: m[3],
      name: m[1],
      reverseName: m[2] === "null" ? null : m[2].slice(1, -1),
    }));
    expect(rows).toEqual(DEFAULT_CONTACT_RELATION_TYPES.map((t) => ({ key: t.key, name: t.name, reverseName: t.reverseName })));
  });

  it("the name limit is the database's", () => {
    expect(migration()).toContain(`char_length(name) between 1 and ${CONTACT_RELATION_NAME_MAX}`);
  });

  it("each side reads its own phrase; no reverse name reads the same both ways", () => {
    expect(relationPhrase(types[1], "out")).toBe("הורה של");
    expect(relationPhrase(types[1], "in")).toBe("ילד/ה של");
    expect(relationPhrase(types[0], "in")).toBe("בן/בת זוג של");
  });

  it("the card offers each active type in its direction, and the other way when it has a reverse name", () => {
    expect(relationChoices(types)).toEqual([
      { value: `${SPOUSE}:out`, label: "בן/בת זוג של" },
      { value: `${PARENT}:out`, label: "הורה של" },
      { value: `${PARENT}:in`, label: "ילד/ה של" },
    ]);
    expect(parseRelationChoice(`${PARENT}:in`)).toEqual({ typeId: PARENT, side: "in" });
    for (const bad of ["", `${PARENT}:up`, "x:out", null, 3]) expect(parseRelationChoice(bad)).toBeNull();
  });

  it("forms: a choice and a contact are required; a reverse name is optional", () => {
    const other = "00000000-0000-4000-8000-000000000009";
    expect(addRelationSchema.parse({ choice: `${PARENT}:out`, other_id: other })).toEqual({ choice: { typeId: PARENT, side: "out" }, other_id: other });
    expect(addRelationSchema.safeParse({ choice: "", other_id: other }).success).toBe(false);
    expect(addRelationSchema.safeParse({ choice: `${PARENT}:out`, other_id: "" }).success).toBe(false);
    expect(relationTypeSchema.parse({ name: " חבר/ה של ", reverse_name: "" })).toEqual({ name: "חבר/ה של", reverse_name: null });
    expect(relationTypeSchema.safeParse({ name: "x".repeat(CONTACT_RELATION_NAME_MAX + 1), reverse_name: "" }).success).toBe(false);
  });
});
