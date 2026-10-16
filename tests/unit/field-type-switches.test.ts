import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { BASELINE_FIELD_TYPES, FIELD_TYPE_SWITCHES } from "@/features/custom-fields/type-decisions";
import { FIELD_TYPES } from "@/features/custom-fields/types";

// FLD-06 condition: every place that switches on a custom field's type makes a choice for every type added after
// FLD-01. Adding a type to FIELD_TYPES fails here until each place in type-decisions.ts says "handled" or
// "excluded" for it; a file that starts switching on types fails here until it is listed.

const root = process.cwd();
const ADDED = FIELD_TYPES.filter((type) => !BASELINE_FIELD_TYPES.includes(type));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

// a file switches on field types when it names a type only a field can have, filters field_definitions by type, or
// keeps a per-type map
const SWITCH = /"(multi_select|long_text|rich_text|il_company_id)"|eq\("field_type"|Record<FieldType\b/;

describe("field type decisions (FLD-06)", () => {
  it("the baseline is part of FIELD_TYPES, and part A added rich_text, duration and status", () => {
    for (const type of BASELINE_FIELD_TYPES) expect(FIELD_TYPES).toContain(type);
    expect(ADDED).toEqual(["rich_text", "duration", "status"]);
  });

  it("every listed place decides for every added type, and nothing else", () => {
    for (const [place, entry] of Object.entries(FIELD_TYPE_SWITCHES)) {
      expect(Object.keys(entry.decisions).sort(), place).toEqual([...ADDED].sort());
      for (const decision of Object.values(entry.decisions)) expect(["handled", "excluded"], place).toContain(decision);
      if (Object.values(entry.decisions).includes("excluded")) expect(entry.note ?? entry.what, place).toBeTruthy();
    }
  });

  it("every source file that switches on field types is listed", () => {
    const listed = new Set(Object.keys(FIELD_TYPE_SWITCHES).filter((place) => place.startsWith("src/")));
    const found = sourceFiles(join(root, "src"))
      .filter((path) => !path.endsWith("type-decisions.ts") && !path.endsWith("database.types.ts"))
      .filter((path) => SWITCH.test(readFileSync(path, "utf8")))
      .map((path) => relative(root, path).split("\\").join("/"));
    const missing = found.filter((path) => !listed.has(path));
    expect(missing).toEqual([]);
    // and every listed file still exists
    for (const path of listed) expect(() => statSync(join(root, path)), path).not.toThrow();
  });

  it("the database accepts exactly FIELD_TYPES, and its value check handles every added type", () => {
    const dir = join(root, "supabase/migrations");
    const files = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
    const withConstraint = files.filter((name) => readFileSync(join(dir, name), "utf8").includes("field_definitions_field_type_check check"));
    const sql = readFileSync(join(dir, withConstraint[withConstraint.length - 1]), "utf8");
    const list = sql.slice(sql.indexOf("field_definitions_field_type_check check"));
    const types = [...list.slice(0, list.indexOf("));")).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(types).toEqual([...FIELD_TYPES]);
    const cvo = files.filter((name) => readFileSync(join(dir, name), "utf8").includes("create or replace function app.custom_value_ok"));
    const body = readFileSync(join(dir, cvo[cvo.length - 1]), "utf8");
    for (const type of ADDED) expect(body, type).toContain(`'${type}'`);
  });
});
