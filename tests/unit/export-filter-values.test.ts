import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { appliedFilter, filterFields } from "@/features/list-filters/server";
import type { FilterTree } from "@/features/list-filters/model";

// RVW-4: the list export logs only the conditions the list applied, and the database keeps a
// value of a plain choice field only when it is one of the values listed in app.export_choice_values().

const USER = "11111111-1111-4111-8111-111111111111";
const STATUS = "33333333-3333-4333-8333-333333333333";
const ctx = { userId: USER, now: new Date("2026-07-15T07:00:00Z") };
const lookups = { statuses: [{ value: STATUS, label: "חדש" }], sources: [], members: [], tags: [], fields: [] };

describe("appliedFilter", () => {
  const leadFields = filterFields("lead", lookups);

  it("keeps only the conditions the query uses, and drops groups left empty", () => {
    const tree = {
      match: "all",
      groups: [
        {
          match: "any",
          conditions: [
            { field: "status", op: "is", value: STATUS },
            { field: "status", op: "is", value: "johnsmith" },
            { field: "created", op: "last_days", value: "password_123" },
            { field: "name", op: "gt", value: "0501234567" },
            { field: "nope", op: "contains", value: "x" },
          ],
        },
        { match: "all", conditions: [{ field: "created", op: "before", value: "not a date" }] },
        { match: "all", conditions: [{ field: "created", op: "last_days", value: "7" }] },
      ],
    } as FilterTree;
    expect(appliedFilter(tree, leadFields, ctx)).toEqual({
      match: "all",
      groups: [
        { match: "any", conditions: [{ field: "status", op: "is", value: STATUS }] },
        { match: "all", conditions: [{ field: "created", op: "last_days", value: "7" }] },
      ],
    });
  });

  it("is null when no condition fits", () => {
    const tree = { match: "any", groups: [{ match: "all", conditions: [{ field: "phone", op: "gt", value: "0501234567" }] }] } as FilterTree;
    expect(appliedFilter(tree, leadFields, ctx)).toBeNull();
  });
});

describe("the database's list of plain choice values", () => {
  // the latest migration that (re)defines the function (0088, then CON-10's contact_preferences)
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  const sql = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => readFileSync(new URL(name, dir), "utf8"))
    .filter((text) => text.includes("create or replace function app.export_choice_values()"))
    .at(-1) ?? "";
  const listed = new Set(
    [...(/create or replace function app\.export_choice_values\(\)[\s\S]*?array\[([\s\S]*?)\];/.exec(sql)?.[1] ?? "").matchAll(/'([^']*)'/g)].map((m) => m[1]),
  );

  it("holds every option of every built-in plain choice field", () => {
    expect(listed.size).toBeGreaterThan(0);
    for (const object of ["lead", "contact", "company", "deal", "task", "product", "quote"] as const) {
      for (const field of filterFields(object, lookups)) {
        if (!("plain" in field) || !field.plain) continue;
        for (const option of field.options ?? []) {
          expect(listed.has(option.value), `${object}.${field.key}: ${option.value}`).toBe(true);
        }
      }
    }
  });
});
