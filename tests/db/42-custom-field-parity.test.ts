import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseCustomFields } from "@/features/custom-fields/values";
import type { FieldDefinition, FieldType } from "@/features/custom-fields/types";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

// The app (src/features/custom-fields/values.ts) and the database
// (app.custom_value_ok, migration 0026) check custom field values separately.
// Whatever the app accepts and stores, the database must accept too, or a
// valid-looking form fails with "custom_field:invalid" (FXC-01).
const OPTIONS = ["קטן", "גדול"];
const MEMBER = "11111111-1111-4111-8111-111111111111";
const CHOICES = [{ value: MEMBER, label: "דנה" }];
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
  // FLD-01
  ["currency", "1,250.50"],
  ["currency", "-5"],
  ["percent", "12.5%"],
  ["rating", "5"],
  ["rating", "0"],
  ["rating", "6"],
  ["rating", "2.5"],
  ["rating", "3"],
  ["multi_select", "גדול, קטן"],
  ["multi_select", "ענק"],
  ["datetime", "2026-07-01T14:30"],
  ["datetime", "2026-07-01 14:30"],
  ["user", MEMBER],
  ["user", "33333333-3333-4333-8333-333333333333"],
  ["il_id", "123456782"],
  ["il_id", "123456789"],
  ["il_company_id", "51-428562-6"],
];

describe("custom field values: the app and the database agree", () => {
  it.each(CASES)("%s %s", async (type, input) => {
    const field: FieldDefinition = { id: "f", key: "f", label: "f", type, options: OPTIONS, choices: CHOICES, isRequired: false, isActive: true, helpText: null };
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
      const field: FieldDefinition = { id: "f", key: "f", label: "f", type, options: OPTIONS, choices: CHOICES, isRequired: false, isActive: true, helpText: null };
      return Object.keys(parseCustomFields([field], form).errors).length === 0;
    });
    expect(outcomes).toContain(true);
    expect(outcomes).toContain(false);
  });
});

// RVW-14: the other direction. What the app refuses, a direct API write must not store either.
describe("custom field values the app refuses, the database refuses too", () => {
  const ok = (type: string, value: unknown) =>
    asAdmin(async (q) => (await q<{ ok: boolean }>("select app.custom_value_ok($1, '[]'::jsonb, $2::jsonb) as ok", [type, JSON.stringify(value)])).rows[0].ok);

  it("a rating is a whole number from 1 to 5", async () => {
    for (const bad of [0, 6, 2.5, -1, 99, "3"]) {
      expect(await ok("rating", bad), JSON.stringify(bad)).toBe(false);
    }
    for (const good of [1, 3, 5, null]) {
      expect(await ok("rating", good), JSON.stringify(good)).toBe(true);
    }
    // 3.0 is the number 3 (JSON.parse gives 3, which the app accepts)
    const threePointZero = await asAdmin(
      async (q) => (await q<{ ok: boolean }>("select app.custom_value_ok('rating', '[]'::jsonb, '3.0'::jsonb) as ok")).rows[0].ok,
    );
    expect(threePointZero).toBe(true);
  });

  it("the app and the database agree on every rating 0 to 6 and 2.5", async () => {
    for (const input of ["0", "1", "2.5", "3", "5", "6"]) {
      const field: FieldDefinition = { id: "f", key: "f", label: "f", type: "rating", options: [], isRequired: false, isActive: true, helpText: null };
      const form = new FormData();
      form.set("cf_f", input);
      const appAccepts = Object.keys(parseCustomFields([field], form).errors).length === 0;
      expect(await ok("rating", Number(input)), input).toBe(appAccepts);
    }
  });

  describe("on a record", () => {
    let org: string;
    let rep: { id: string };
    let suspended: { id: string };
    let stranger: { id: string };

    beforeAll(async () => {
      const owner = await createUser("cfs-owner");
      org = await createOrg(owner.id);
      rep = await addMember(org, owner.id, "member");
      suspended = await addMember(org, owner.id, "member");
      const other = await createUser("cfs-other");
      stranger = await addMember(await createOrg(other.id), other.id, "member");
      await asAdmin(async (q) => {
        await q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, suspended.id]);
        await q(
          "insert into public.field_definitions (organization_id, object_type, key, label, field_type) values ($1, 'lead', 'stars', 'stars', 'rating'), ($1, 'lead', 'handler', 'handler', 'user')",
          [org],
        );
      });
    });

    const lead = (custom: unknown) => insertLead(rep.id, org, { custom_fields: JSON.stringify(custom) });
    const hint = async (custom: unknown) => (await pgError(lead(custom))).hint;

    it("refuses a rating of 0, 6 or 2.5 and keeps 3", async () => {
      for (const bad of [0, 6, 2.5]) {
        expect(await hint({ stars: bad }), String(bad)).toBe("custom_field:invalid");
      }
      await expect(lead({ stars: 3 })).resolves.toBeTruthy();
    });

    it("a user field takes a member of the organization, a suspended one included, and no one else", async () => {
      await expect(lead({ handler: rep.id })).resolves.toBeTruthy();
      await expect(lead({ handler: suspended.id })).resolves.toBeTruthy();
      // a real user who belongs to another business
      expect(await hint({ handler: stranger.id })).toBe("custom_field:invalid");
      // an id of no one
      expect(await hint({ handler: "33333333-3333-4333-8333-333333333333" })).toBe("custom_field:invalid");
      expect(await hint({ handler: "not-a-uuid" })).toBe("custom_field:invalid");
    });

    it("an update to a stranger is refused too; an unchanged old value is not checked again", async () => {
      const id = await lead({ handler: rep.id, stars: 4 });
      const update = (patch: unknown) =>
        asUser(rep.id, (q) => q("update public.leads set custom_fields = custom_fields || $2::jsonb where id = $1 returning id", [id, JSON.stringify(patch)]));
      expect((await pgError(update({ handler: stranger.id }))).hint).toBe("custom_field:invalid");
      expect((await pgError(update({ stars: 7 }))).hint).toBe("custom_field:invalid");
      // a value stored before the check (server write) survives an unrelated change
      await asAdmin((q) => q(`update public.leads set custom_fields = custom_fields || '{"stars": 9}'::jsonb where id = $1`, [id]));
      const result = await update({ handler: suspended.id });
      expect(result.rowCount).toBe(1);
    });
  });
});
