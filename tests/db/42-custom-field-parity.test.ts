import { afterAll, describe, expect, it } from "vitest";

import { parseCustomFields } from "@/features/custom-fields/values";
import type { FieldDefinition, FieldType } from "@/features/custom-fields/types";

import { asAdmin, closePool } from "./helpers";

afterAll(closePool);

// The app (src/features/custom-fields/values.ts) and the database
// (app.custom_value_ok, migration 0026) check custom field values separately.
// Whatever the app accepts and stores, the database must accept too, or a
// valid-looking form fails with "custom_field:invalid" (FXC-01).
const OPTIONS = ["קטן", "גדול"];
const CASES: Array<[FieldType, string]> = [
  ["text", "שלום"],
  ["text", "x".repeat(500)],
  ["text", "x".repeat(501)],
  ["long_text", "x".repeat(5000)],
  ["long_text", "x".repeat(5001)],
  ["number", "1,250.5"],
  ["number", "-3"],
  ["number", "abc"],
  ["select", "גדול"],
  ["select", "בינוני"],
  ["date", "2026-02-28"],
  ["date", "2026-02-30"],
  ["date", "2028-02-29"],
  ["date", "28/02/2026"],
  ["email", "Dana@Example.co.il"],
  ["email", "dana@example"],
  ["phone", "+972 (52) 123-4567"],
  ["phone", "052-1234567*1"],
  ["phone", "טלפון"],
  ["url", "example.co.il/page"],
  ["url", "https://example.com"],
  ["url", "localhost"],
  ["checkbox", "on"],
  ["checkbox", ""],
];

describe("custom field values: the app and the database agree", () => {
  it.each(CASES)("%s %s", async (type, input) => {
    const field: FieldDefinition = { id: "f", key: "f", label: "f", type, options: OPTIONS, isRequired: false, isActive: true, helpText: null };
    const form = new FormData();
    form.set("cf_f", input);
    const { values, errors } = parseCustomFields([field], form);
    const appAccepts = Object.keys(errors).length === 0;
    if (!appAccepts) {
      // the app refused it, so it never reaches the database
      return;
    }
    const stored = values.f ?? null;
    const dbAccepts = await asAdmin(
      async (q) =>
        (await q<{ ok: boolean }>("select app.custom_value_ok($1, $2::jsonb, $3::jsonb) as ok", [type, JSON.stringify(OPTIONS), JSON.stringify(stored)])).rows[0].ok,
    );
    expect(dbAccepts, `stored ${JSON.stringify(stored)}`).toBe(true);
  });

  it("the cases cover values the app refuses as well as ones it accepts", () => {
    const outcomes = CASES.map(([type, input]) => {
      const form = new FormData();
      form.set("cf_f", input);
      const field: FieldDefinition = { id: "f", key: "f", label: "f", type, options: OPTIONS, isRequired: false, isActive: true, helpText: null };
      return Object.keys(parseCustomFields([field], form).errors).length === 0;
    });
    expect(outcomes).toContain(true);
    expect(outcomes).toContain(false);
  });
});
