import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, defaultLeadStatus, defaultPipeline, insertLead, pgError } from "./helpers";

afterAll(closePool);

// FLD-09 (migration conditional_fields): field_definitions.condition, checked by
// app.field_condition_check when it is written. What it does is app-only.
type DbError = { code?: string; hint?: string; message: string };
const failure = async (promise: Promise<unknown>) => (await pgError(promise)) as DbError;
const HINT = "custom_field:condition";

describe("conditional fields (FLD-09)", () => {
  let owner: { id: string }, admin: { id: string }, manager: { id: string }, rep: { id: string }, other: { id: string };
  let org: string, otherOrg: string;
  let statusId: string, otherStatusId: string, stageId: string, contactTypeId: string, companyTypeId: string;

  const define = (userId: string, o: string, object: string, key: string, type: string, extra: { options?: string[]; condition?: unknown; active?: boolean } = {}) =>
    asUser(userId, (q) =>
      q(
        `insert into public.field_definitions (organization_id, object_type, key, label, field_type, options, condition, is_active)
         values ($1, $2, $3, $3, $4, $5, $6, $7) returning id`,
        [o, object, key, type, JSON.stringify(extra.options ?? []), extra.condition === undefined ? null : JSON.stringify(extra.condition), extra.active ?? true],
      ),
    );
  const setCondition = (userId: string, o: string, object: string, key: string, condition: unknown) =>
    asUser(userId, (q) =>
      q("update public.field_definitions set condition = $4 where organization_id = $1 and object_type = $2 and key = $3 returning id", [
        o,
        object,
        key,
        condition === null ? null : JSON.stringify(condition),
      ]),
    );
  const conditionOf = (o: string, object: string, key: string) =>
    asAdmin(async (q) => (await q("select condition from public.field_definitions where organization_id = $1 and object_type = $2 and key = $3", [o, object, key])).rows[0]?.condition);

  beforeAll(async () => {
    owner = await createUser("cf-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin");
    manager = await addMember(org, owner.id, "manager");
    rep = await addMember(org, owner.id, "member");
    other = await createUser("cf-other");
    otherOrg = await createOrg(other.id);
    statusId = await defaultLeadStatus(org);
    otherStatusId = await defaultLeadStatus(otherOrg);
    stageId = (await defaultPipeline(org)).stages[0].id;
    [contactTypeId, companyTypeId] = await asAdmin(async (q) => {
      const c = await q("insert into public.record_type_options (organization_id, object_type, name) values ($1, 'contact', 'ספק FLD09') returning id", [org]);
      const k = await q("insert into public.record_type_options (organization_id, object_type, name) values ($1, 'company', 'לקוח FLD09') returning id", [org]);
      return [c.rows[0].id as string, k.rows[0].id as string];
    });
    await define(owner.id, org, "lead", "tier", "select", { options: ["רגיל", "זהב"] });
    await define(owner.id, org, "lead", "tags", "multi_select", { options: ["א", "ב"] });
    await define(owner.id, org, "lead", "vip", "checkbox");
    await define(owner.id, org, "lead", "score", "rating");
    await define(owner.id, org, "lead", "note", "text");
    await define(owner.id, org, "lead", "off", "select", { options: ["x"], active: false });
    await define(owner.id, org, "contact", "segment", "select", { options: ["זהב"] });
    await define(other.id, otherOrg, "lead", "secret", "select", { options: ["זהב"] });
  });

  describe("the shape", () => {
    it("accepts each op on the types that take it, and on built-in fields", async () => {
      const ok: Array<[string, string, unknown]> = [
        ["c1", "text", { field: "tier", op: "equals", value: "זהב", effect: "show" }],
        ["c2", "text", { field: "tier", op: "not_equals", value: "רגיל", effect: "require" }],
        ["c3", "text", { field: "tags", op: "in", value: ["א", "ב"], effect: "show" }],
        ["c4", "text", { field: "vip", op: "equals", value: true, effect: "require" }],
        ["c5", "text", { field: "score", op: "in", value: [4, 5], effect: "show" }],
        ["c6", "text", { field: "note", op: "filled", effect: "show" }],
        ["c7", "number", { field: "builtin:status", op: "in", value: [statusId], effect: "require" }],
        ["c8", "number", { field: "builtin:source", op: "empty", effect: "show" }],
      ];
      for (const [key, type, condition] of ok) {
        await define(owner.id, org, "lead", key, type, { condition });
        expect(await conditionOf(org, "lead", key), key).toEqual(condition);
      }
      await define(owner.id, org, "deal", "d1", "text", { condition: { field: "builtin:stage", op: "equals", value: stageId, effect: "show" } });
      await define(owner.id, org, "contact", "k1", "text", { condition: { field: "builtin:type", op: "equals", value: contactTypeId, effect: "show" } });
      await define(owner.id, org, "company", "m1", "text", { condition: { field: "builtin:type", op: "in", value: [companyTypeId], effect: "require" } });
    });

    it("JSON null is no condition; filled / empty drop a null value", async () => {
      await define(owner.id, org, "lead", "n1", "text", { condition: null });
      await asUser(owner.id, (q) => q("update public.field_definitions set condition = 'null'::jsonb where organization_id = $1 and key = 'n1'", [org]));
      expect(await conditionOf(org, "lead", "n1")).toBeNull();
      await setCondition(owner.id, org, "lead", "n1", { field: "note", op: "empty", value: null, effect: "show" });
      expect(await conditionOf(org, "lead", "n1")).toEqual({ field: "note", op: "empty", effect: "show" });
    });

    it("refuses a bad shape", async () => {
      const bad: unknown[] = [
        "tier",
        [],
        { field: "tier", op: "equals", value: "זהב" },
        { field: "tier", op: "equals", value: "זהב", effect: "hide" },
        { field: "tier", op: "like", value: "זהב", effect: "show" },
        { field: "tier", op: "equals", value: "זהב", effect: "show", extra: 1 },
        { field: 5, op: "equals", value: "זהב", effect: "show" },
        { field: "tier", op: "equals", effect: "show" },
        { field: "tier", op: "equals", value: ["זהב"], effect: "show" },
        { field: "tier", op: "in", value: "זהב", effect: "show" },
        { field: "tier", op: "in", value: [], effect: "show" },
        { field: "tier", op: "in", value: ["זהב", "זהב"], effect: "show" },
        { field: "note", op: "filled", value: "x", effect: "show" },
      ];
      for (const [index, condition] of bad.entries()) {
        expect((await failure(define(owner.id, org, "lead", `bad${index}`, "text", { condition }))).hint, JSON.stringify(condition)).toBe(HINT);
      }
    });

    it("the value must fit the controlling field's type and options; the op must fit its type", async () => {
      const bad: unknown[] = [
        { field: "tier", op: "equals", value: "פלטינה", effect: "show" },
        { field: "tags", op: "in", value: ["ג"], effect: "show" },
        { field: "vip", op: "equals", value: "true", effect: "show" },
        { field: "vip", op: "filled", effect: "show" },
        { field: "vip", op: "in", value: [true], effect: "show" },
        { field: "score", op: "equals", value: 6, effect: "show" },
        { field: "note", op: "equals", value: "x", effect: "show" },
      ];
      for (const [index, condition] of bad.entries()) {
        expect((await failure(define(owner.id, org, "lead", `fit${index}`, "text", { condition }))).hint, JSON.stringify(condition)).toBe(HINT);
      }
    });

    it("the controlling field must exist, be active and not be the field itself", async () => {
      expect((await failure(define(owner.id, org, "lead", "x1", "text", { condition: { field: "nothing", op: "filled", effect: "show" } }))).hint).toBe(HINT);
      expect((await failure(define(owner.id, org, "lead", "x2", "text", { condition: { field: "off", op: "filled", effect: "show" } }))).hint).toBe(HINT);
      expect((await failure(define(owner.id, org, "lead", "x3", "text", { condition: { field: "x3", op: "filled", effect: "show" } }))).hint).toBe(HINT);
    });

    it("built-in fields: only the listed ones per record type, ids of this organization's list", async () => {
      const bad: Array<[string, unknown]> = [
        ["lead", { field: "builtin:stage", op: "filled", effect: "show" }],
        ["lead", { field: "builtin:owner", op: "filled", effect: "show" }],
        ["deal", { field: "builtin:status", op: "filled", effect: "show" }],
        ["lead", { field: "builtin:status", op: "equals", value: otherStatusId, effect: "show" }],
        ["lead", { field: "builtin:status", op: "equals", value: "not-a-uuid", effect: "show" }],
        ["lead", { field: "builtin:status", op: "equals", value: stageId, effect: "show" }],
        ["company", { field: "builtin:type", op: "equals", value: contactTypeId, effect: "show" }],
      ];
      for (const [index, [object, condition]] of bad.entries()) {
        expect((await failure(define(owner.id, org, object, `bi${index}`, "text", { condition }))).hint, JSON.stringify(condition)).toBe(HINT);
      }
    });
  });

  it("cross-type: a lead field cannot depend on a contact field", async () => {
    expect((await failure(define(owner.id, org, "lead", "ct1", "text", { condition: { field: "segment", op: "equals", value: "זהב", effect: "show" } }))).hint).toBe(HINT);
    // the same key on contacts works
    await define(owner.id, org, "contact", "ct1", "text", { condition: { field: "segment", op: "equals", value: "זהב", effect: "show" } });
  });

  describe("no chains", () => {
    it("the controlling field may not have a condition itself", async () => {
      // c6 depends on note: c6 cannot control another field
      expect((await failure(define(owner.id, org, "lead", "ch1", "text", { condition: { field: "c6", op: "filled", effect: "show" } }))).hint).toBe(HINT);
    });

    it("a field others depend on may not get a condition", async () => {
      expect((await failure(setCondition(owner.id, org, "lead", "note", { field: "vip", op: "equals", value: true, effect: "show" }))).hint).toBe(HINT);
      expect((await failure(setCondition(owner.id, org, "lead", "tier", { field: "score", op: "filled", effect: "show" }))).hint).toBe(HINT);
    });
  });

  describe("renaming a key or moving a field to another record type is checked again", () => {
    it("a renamed key cannot close a chain", async () => {
      await define(owner.id, org, "lead", "z_ctl", "select", { options: ["כן"] });
      await define(owner.id, org, "lead", "z_dep", "text", { condition: { field: "z_ctl", op: "equals", value: "כן", effect: "show" } });
      await asAdmin((q) => q("delete from public.field_definitions where organization_id = $1 and key = 'z_ctl'", [org]));
      await define(owner.id, org, "lead", "z_other", "text", { condition: { field: "tier", op: "filled", effect: "show" } });
      // z_other has a condition and z_dep points at "z_ctl": taking that key would make a chain
      const rename = (key: string, to: string) =>
        asUser(owner.id, (q) => q("update public.field_definitions set key = $3 where organization_id = $1 and key = $2 returning id", [org, key, to]));
      expect((await failure(rename("z_other", "z_ctl"))).hint).toBe(HINT);
      // a field without a condition may take it
      await define(owner.id, org, "lead", "z_plain", "select", { options: ["כן"] });
      expect((await rename("z_plain", "z_ctl")).rowCount).toBe(1);
    });

    it("a field moved to another record type must still find its controlling field there", async () => {
      await define(owner.id, org, "lead", "mv1", "text", { condition: { field: "tier", op: "filled", effect: "show" } });
      const move = await failure(asUser(owner.id, (q) => q("update public.field_definitions set object_type = 'contact' where organization_id = $1 and object_type = 'lead' and key = 'mv1'", [org])));
      expect(move.hint).toBe(HINT);
      // without a condition it moves
      await define(owner.id, org, "lead", "mv2", "text");
      const moved = await asUser(owner.id, (q) => q("update public.field_definitions set object_type = 'contact' where organization_id = $1 and object_type = 'lead' and key = 'mv2' returning id", [org]));
      expect(moved.rowCount).toBe(1);
    });
  });

  describe("who may write it", () => {
    it("owners and admins; not managers or members", async () => {
      await define(admin.id, org, "lead", "adm1", "text", { condition: { field: "tier", op: "filled", effect: "show" } });
      expect((await setCondition(admin.id, org, "lead", "adm1", { field: "tier", op: "empty", effect: "show" })).rowCount).toBe(1);
      for (const user of [manager, rep]) {
        expect((await setCondition(user.id, org, "lead", "adm1", null)).rowCount).toBe(0);
        expect((await failure(define(user.id, org, "lead", `w_${user.id.slice(0, 6)}`, "text", { condition: { field: "tier", op: "filled", effect: "show" } }))).code).toBe("42501");
      }
      expect(await conditionOf(org, "lead", "adm1")).toEqual({ field: "tier", op: "empty", effect: "show" });
    });

    it("an outsider gets RLS's refusal, not the condition check, and cannot touch another organization's fields", async () => {
      // a condition naming a field only the other organization has: plain 42501, nothing learned
      const error = await failure(define(other.id, org, "lead", "spy", "text", { condition: { field: "tier", op: "equals", value: "זהב", effect: "show" } }));
      expect(error.code).toBe("42501");
      expect(error.hint).not.toBe(HINT);
      expect((await setCondition(other.id, org, "lead", "c1", null)).rowCount).toBe(0);
      expect(await conditionOf(org, "lead", "c1")).toEqual({ field: "tier", op: "equals", value: "זהב", effect: "show" });
      // a field of this organization cannot depend on a field of the other one
      expect((await failure(define(owner.id, org, "lead", "xo1", "text", { condition: { field: "secret", op: "equals", value: "זהב", effect: "show" } }))).hint).toBe(HINT);
      // the other organization does not see this one's fields or conditions
      const seen = await asUser(other.id, async (q) => (await q("select count(*)::int as n from public.field_definitions where organization_id = $1", [org])).rows[0].n);
      expect(seen).toBe(0);
    });
  });

  describe("a controlling field hidden or deleted later", () => {
    it("is allowed; the condition stays (the app ignores it) and other settings of the field still save", async () => {
      await define(owner.id, org, "lead", "ctl", "select", { options: ["כן", "לא"] });
      await define(owner.id, org, "lead", "dep", "text", { condition: { field: "ctl", op: "equals", value: "כן", effect: "show" } });
      await asUser(owner.id, (q) => q("update public.field_definitions set is_active = false where organization_id = $1 and key = 'ctl'", [org]));
      const renamed = await asUser(owner.id, (q) => q("update public.field_definitions set label = 'תלוי' where organization_id = $1 and key = 'dep' returning id", [org]));
      expect(renamed.rowCount).toBe(1);
      // a new condition on the hidden one is refused
      expect((await failure(setCondition(owner.id, org, "lead", "dep", { field: "ctl", op: "equals", value: "לא", effect: "show" }))).hint).toBe(HINT);
      await asAdmin((q) => q("delete from public.field_definitions where organization_id = $1 and key = 'ctl'", [org]));
      expect(await conditionOf(org, "lead", "dep")).toEqual({ field: "ctl", op: "equals", value: "כן", effect: "show" });
      // removing the condition always works
      expect((await setCondition(owner.id, org, "lead", "dep", null)).rowCount).toBe(1);
    });

    it("an option the condition uses may be removed from the controlling field", async () => {
      await define(owner.id, org, "lead", "opt", "select", { options: ["א", "ב"] });
      await define(owner.id, org, "lead", "optdep", "text", { condition: { field: "opt", op: "equals", value: "ב", effect: "require" } });
      const changed = await asUser(owner.id, (q) => q(`update public.field_definitions set options = '["א"]' where organization_id = $1 and key = 'opt' returning id`, [org]));
      expect(changed.rowCount).toBe(1);
    });
  });

  it("is never enforced on records: a person's insert with the condition holding and the field empty is stored", async () => {
    const id = await insertLead(rep.id, org, { custom_fields: JSON.stringify({ tier: "זהב", vip: true }) });
    const stored = await asAdmin(async (q) => (await q("select custom_fields from public.leads where id = $1", [id])).rows[0].custom_fields);
    expect(stored).toEqual({ tier: "זהב", vip: true });
  });

  it("the migration is safe to run twice", async () => {
    const dir = "supabase/migrations";
    const file = readdirSync(dir).find((name) => name.endsWith("_conditional_fields.sql"));
    const sql = readFileSync(join(dir, file ?? ""), "utf8");
    await asAdmin((q) => q(sql));
    await asAdmin((q) => q(sql));
    expect(await conditionOf(org, "lead", "c1")).toEqual({ field: "tier", op: "equals", value: "זהב", effect: "show" });
  });
});
