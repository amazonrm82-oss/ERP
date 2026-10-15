import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { conditionWithoutPipeline, parseCondition, type FieldCondition } from "@/features/custom-fields/conditions";

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
    // the later migration that redefines app.field_condition_check runs again after it
    for (const suffix of ["_conditional_fields.sql", "_condition_pipeline.sql"]) {
      const file = readdirSync(dir).find((name) => name.endsWith(suffix));
      const sql = readFileSync(join(dir, file ?? ""), "utf8");
      await asAdmin((q) => q(sql));
      await asAdmin((q) => q(sql));
    }
    expect(await conditionOf(org, "lead", "c1")).toEqual({ field: "tier", op: "equals", value: "זהב", effect: "show" });
  });
});

// FLD-09 follow-up (owner, 15 October 2026; migration condition_pipeline): the pipeline as a controlling
// field of deal fields, a pipeline condition beside a stage condition ("or"), and deleting a pipeline
// removes the conditions based on it.
describe("conditional fields: the pipeline (FLD-09 follow-up)", () => {
  let owner: { id: string }, rep: { id: string }, other: { id: string };
  let org: string, otherOrg: string;
  let p1: string, p2: string, s1: string[], s2: string[], otherPipeline: string;

  const define = (userId: string, o: string, object: string, key: string, condition: unknown) =>
    asUser(userId, (q) =>
      q(
        `insert into public.field_definitions (organization_id, object_type, key, label, field_type, condition)
         values ($1, $2, $3, $3, 'text', $4) returning id`,
        [o, object, key, condition === null ? null : JSON.stringify(condition)],
      ),
    );
  const conditionOf = (o: string, key: string) =>
    asAdmin(async (q) => (await q("select condition from public.field_definitions where organization_id = $1 and object_type = 'deal' and key = $2", [o, key])).rows[0]?.condition);
  const addPipeline = async (o: string, name: string) =>
    asAdmin(async (q) => {
      const p = await q("insert into public.pipelines (organization_id, name, position) values ($1, $2, 5) returning id", [o, name]);
      const id = p.rows[0].id as string;
      const stages: string[] = [];
      for (const [position, kind] of ["open", "open", "won"].entries()) {
        const s = await q("insert into public.stages (organization_id, pipeline_id, name, kind, position) values ($1, $2, $3, $4, $5) returning id", [o, id, `${name} ${position}`, kind, position]);
        stages.push(s.rows[0].id as string);
      }
      return { id, stages };
    });
  const deletePipeline = (userId: string, o: string, id: string) =>
    asUser(userId, (q) => q("update public.pipelines set deleted_at = now() where organization_id = $1 and id = $2 returning id", [o, id]));

  beforeAll(async () => {
    owner = await createUser("cfp-owner");
    org = await createOrg(owner.id);
    rep = await addMember(org, owner.id, "member");
    other = await createUser("cfp-other");
    otherOrg = await createOrg(other.id);
    const first = await defaultPipeline(org);
    p1 = first.pipelineId;
    s1 = first.stages.map((stage) => stage.id);
    ({ id: p2, stages: s2 } = await addPipeline(org, "שני"));
    otherPipeline = (await defaultPipeline(otherOrg)).pipelineId;
  });

  it("accepts a pipeline condition on a deal field, with any op", async () => {
    const ok: Array<[string, unknown]> = [
      ["pp1", { field: "builtin:pipeline", op: "equals", value: p1, effect: "show" }],
      ["pp2", { field: "builtin:pipeline", op: "in", value: [p1, p2], effect: "require" }],
      ["pp3", { field: "builtin:pipeline", op: "not_equals", value: p2, effect: "show" }],
      ["pp4", { field: "builtin:pipeline", op: "filled", effect: "show" }],
    ];
    for (const [key, condition] of ok) {
      await define(owner.id, org, "deal", key, condition);
      expect(await conditionOf(org, key), key).toEqual(condition);
    }
  });

  it("refuses a pipeline on another record type, of another organization, a stage id or a deleted pipeline", async () => {
    const gone = await addPipeline(org, "נמחק");
    await deletePipeline(owner.id, org, gone.id);
    const bad: Array<[string, unknown]> = [
      ["lead", { field: "builtin:pipeline", op: "filled", effect: "show" }],
      ["deal", { field: "builtin:pipeline", op: "equals", value: otherPipeline, effect: "show" }],
      ["deal", { field: "builtin:pipeline", op: "equals", value: s1[0], effect: "show" }],
      ["deal", { field: "builtin:pipeline", op: "in", value: [p1, gone.id], effect: "show" }],
    ];
    for (const [index, [object, condition]] of bad.entries()) {
      expect((await failure(define(owner.id, org, object, `pb${index}`, condition))).hint, JSON.stringify(condition)).toBe(HINT);
    }
  });

  it("a stage condition and a pipeline condition on one field (either order), each part checked", async () => {
    const both = { field: "builtin:stage", op: "in", value: [s1[2]], effect: "require", or: { field: "builtin:pipeline", op: "equals", value: p2 } };
    await define(owner.id, org, "deal", "or1", both);
    expect(await conditionOf(org, "or1")).toEqual(both);
    const reversed = { field: "builtin:pipeline", op: "equals", value: p1, effect: "show", or: { field: "builtin:stage", op: "equals", value: s2[0] } };
    await define(owner.id, org, "deal", "or2", reversed);
    expect(await conditionOf(org, "or2")).toEqual(reversed);
    // filled / empty drop a null value in the second part too; a JSON null "or" is no second part
    await define(owner.id, org, "deal", "or3", { field: "builtin:stage", op: "filled", effect: "show", or: { field: "builtin:pipeline", op: "empty", value: null } });
    expect(await conditionOf(org, "or3")).toEqual({ field: "builtin:stage", op: "filled", effect: "show", or: { field: "builtin:pipeline", op: "empty" } });
    await define(owner.id, org, "deal", "or4", { field: "builtin:stage", op: "filled", effect: "show", or: null });
    expect(await conditionOf(org, "or4")).toEqual({ field: "builtin:stage", op: "filled", effect: "show" });
  });

  it("refuses any other second part", async () => {
    await asUser(owner.id, (q) => q("insert into public.field_definitions (organization_id, object_type, key, label, field_type, options) values ($1, 'deal', 'tier', 'tier', 'select', '[\"זהב\"]')", [org]));
    const pipe = { field: "builtin:pipeline", op: "equals", value: p1 };
    const bad: Array<[string, unknown]> = [
      // the same field twice, a custom field, an effect inside, an unknown key, not an object
      ["deal", { field: "builtin:stage", op: "filled", effect: "show", or: { field: "builtin:stage", op: "empty" } }],
      ["deal", { field: "builtin:pipeline", op: "filled", effect: "show", or: { field: "builtin:pipeline", op: "empty" } }],
      ["deal", { field: "tier", op: "equals", value: "זהב", effect: "show", or: pipe }],
      ["deal", { field: "builtin:stage", op: "filled", effect: "show", or: { field: "tier", op: "equals", value: "זהב" } }],
      ["deal", { field: "builtin:stage", op: "filled", effect: "show", or: { ...pipe, effect: "show" } }],
      ["deal", { field: "builtin:stage", op: "filled", effect: "show", or: { ...pipe, x: 1 } }],
      ["deal", { field: "builtin:stage", op: "filled", effect: "show", or: [pipe] }],
      // a bad value in the second part
      ["deal", { field: "builtin:stage", op: "filled", effect: "show", or: { field: "builtin:pipeline", op: "equals", value: otherPipeline } }],
      ["deal", { field: "builtin:stage", op: "filled", effect: "show", or: { field: "builtin:pipeline", op: "in", value: [] } }],
      ["deal", { field: "builtin:stage", op: "filled", effect: "show", or: { field: "builtin:pipeline", op: "filled", value: p1 } }],
      ["deal", { field: "builtin:stage", op: "filled", effect: "show", or: { field: "builtin:pipeline", op: "like", value: p1 } }],
      // only on deals
      ["lead", { field: "builtin:status", op: "filled", effect: "show", or: { field: "builtin:source", op: "filled" } }],
    ];
    for (const [index, [object, condition]] of bad.entries()) {
      expect((await failure(define(owner.id, org, object, `ob${index}`, condition))).hint, JSON.stringify(condition)).toBe(HINT);
    }
  });

  it("a stage of a deleted pipeline is refused as a stage value", async () => {
    const gone = await addPipeline(org, "שלבים שנמחקו");
    await define(owner.id, org, "deal", "gs0", { field: "builtin:stage", op: "equals", value: gone.stages[0], effect: "show" });
    await deletePipeline(owner.id, org, gone.id);
    expect((await failure(define(owner.id, org, "deal", "gs1", { field: "builtin:stage", op: "equals", value: gone.stages[0], effect: "show" }))).hint).toBe(HINT);
    expect(
      (await failure(define(owner.id, org, "deal", "gs2", { field: "builtin:pipeline", op: "filled", effect: "show", or: { field: "builtin:stage", op: "in", value: [s1[0], gone.stages[1]] } }))).hint,
    ).toBe(HINT);
  });

  it("a person who sets app.condition_cleanup by hand is still checked", async () => {
    const withSetting = (key: string, condition: unknown) =>
      asUser(owner.id, async (q) => {
        await q("select set_config('app.condition_cleanup', 'on', true)");
        return q(
          "insert into public.field_definitions (organization_id, object_type, key, label, field_type, condition) values ($1, 'deal', $2, $2, 'text', $3) returning id",
          [org, key, JSON.stringify(condition)],
        );
      });
    expect((await failure(withSetting("gc1", { field: "builtin:pipeline", op: "equals", value: otherPipeline, effect: "show" }))).hint).toBe(HINT);
    expect((await failure(withSetting("gc2", { field: "nothing", op: "bogus", effect: "show" }))).hint).toBe(HINT);
    // with the setting on, the person's pipeline delete still cleans (the cleanup runs as the owner)
    const p = await addPipeline(org, "עם ההגדרה");
    await define(owner.id, org, "deal", "gc3", { field: "builtin:pipeline", op: "equals", value: p.id, effect: "show" });
    await asUser(owner.id, async (q) => {
      await q("select set_config('app.condition_cleanup', 'on', true)");
      await q("update public.pipelines set deleted_at = now() where organization_id = $1 and id = $2", [org, p.id]);
    });
    expect(await conditionOf(org, "gc3")).toBeNull();
  });

  it("a hard delete of a live pipeline cleans its conditions too; deleting an organization still works", async () => {
    const p = await addPipeline(org, "נמחק לגמרי");
    await define(owner.id, org, "deal", "hd1", { field: "builtin:stage", op: "equals", value: s1[0], effect: "show", or: { field: "builtin:pipeline", op: "equals", value: p.id } });
    await define(owner.id, org, "deal", "hd2", { field: "builtin:stage", op: "in", value: [p.stages[0]], effect: "require" });
    await asAdmin((q) => q("delete from public.pipelines where id = $1", [p.id]));
    expect(await conditionOf(org, "hd1")).toEqual({ field: "builtin:stage", op: "equals", value: s1[0], effect: "show" });
    expect(await conditionOf(org, "hd2")).toBeNull();
    // an organization with pipeline conditions can be deleted (its fields go with it)
    const doomedOwner = await createUser("cfp-doomed");
    const doomed = await createOrg(doomedOwner.id);
    const dp = await defaultPipeline(doomed);
    await define(doomedOwner.id, doomed, "deal", "dd1", { field: "builtin:pipeline", op: "equals", value: dp.pipelineId, effect: "show" });
    await asAdmin((q) => q("delete from public.organizations where id = $1", [doomed]));
    expect(await asAdmin(async (q) => (await q("select count(*)::int as n from public.field_definitions where organization_id = $1", [doomed])).rows[0].n)).toBe(0);
  });

  it("a member cannot write it; an outsider gets RLS's refusal", async () => {
    const condition = { field: "builtin:pipeline", op: "equals", value: p1, effect: "show" };
    expect((await failure(define(rep.id, org, "deal", "w1", condition))).code).toBe("42501");
    const error = await failure(define(other.id, org, "deal", "w2", condition));
    expect(error.code).toBe("42501");
    expect(error.hint).not.toBe(HINT);
  });

  describe("deleting a pipeline removes the conditions based on it", () => {
    let p3: string, s3: string[], p4: string, s4: string[];
    const cases: Record<string, (ids: { p3: string; s3: string[]; p4: string; s4: string[] }) => FieldCondition> = {
      only_pipeline: ({ p3 }) => ({ field: "builtin:pipeline", op: "equals", value: p3, effect: "show" }),
      not_pipeline: ({ p3 }) => ({ field: "builtin:pipeline", op: "not_equals", value: p3, effect: "require" }),
      pipeline_list: ({ p3, p4 }) => ({ field: "builtin:pipeline", op: "in", value: [p3, p4], effect: "show" }),
      stage_list: ({ s3, s4 }) => ({ field: "builtin:stage", op: "in", value: [s3[0], s4[0], s3[1]], effect: "show" }),
      stage_of_it: ({ s3 }) => ({ field: "builtin:stage", op: "equals", value: s3[2], effect: "require" }),
      stage_or_pipeline: ({ p3, s4 }) => ({ field: "builtin:stage", op: "equals", value: s4[2], effect: "require", or: { field: "builtin:pipeline", op: "equals", value: p3 } }),
      pipeline_or_stage: ({ p3, s4 }) => ({ field: "builtin:pipeline", op: "equals", value: p3, effect: "show", or: { field: "builtin:stage", op: "in", value: [s4[1]] } }),
      both_go: ({ p3, s3 }) => ({ field: "builtin:pipeline", op: "in", value: [p3], effect: "show", or: { field: "builtin:stage", op: "equals", value: s3[0] } }),
      untouched_other: ({ p4, s4 }) => ({ field: "builtin:stage", op: "equals", value: s4[0], effect: "show", or: { field: "builtin:pipeline", op: "not_equals", value: p4 } }),
      untouched_filled: () => ({ field: "builtin:pipeline", op: "filled", effect: "show", or: { field: "builtin:stage", op: "empty" } }),
    };

    beforeAll(async () => {
      ({ id: p3, stages: s3 } = await addPipeline(org, "שלישי"));
      ({ id: p4, stages: s4 } = await addPipeline(org, "רביעי"));
      for (const [key, make] of Object.entries(cases)) {
        await define(owner.id, org, "deal", `del_${key}`, make({ p3, s3, p4, s4 }));
      }
      // a condition whose stage value was removed earlier must not stop the delete
      await define(owner.id, org, "deal", "del_dangling", { field: "builtin:stage", op: "in", value: [s4[1], s4[0]], effect: "show", or: { field: "builtin:pipeline", op: "equals", value: p3 } });
      await asAdmin((q) => q("delete from public.stages where id = $1", [s4[1]]));
      // a lead field and another organization are never touched
      await define(other.id, otherOrg, "deal", "del_other", { field: "builtin:pipeline", op: "equals", value: otherPipeline, effect: "show" });
    });

    it("by the rule the delete window uses (conditionWithoutPipeline), audited", async () => {
      const before = Object.fromEntries(await Promise.all(Object.keys(cases).map(async (key) => [key, await conditionOf(org, `del_${key}`)] as const)));
      expect((await deletePipeline(owner.id, org, p3)).rowCount).toBe(1);
      for (const key of Object.keys(cases)) {
        const expected = conditionWithoutPipeline(parseCondition(before[key]), p3, s3);
        expect(await conditionOf(org, `del_${key}`), key).toEqual(expected ?? null);
      }
      expect(await conditionOf(org, "del_only_pipeline")).toBeNull();
      expect(await conditionOf(org, "del_not_pipeline")).toBeNull();
      expect(await conditionOf(org, "del_pipeline_list")).toEqual({ field: "builtin:pipeline", op: "in", value: [p4], effect: "show" });
      expect(await conditionOf(org, "del_stage_list")).toEqual({ field: "builtin:stage", op: "in", value: [s4[0]], effect: "show" });
      expect(await conditionOf(org, "del_stage_of_it")).toBeNull();
      expect(await conditionOf(org, "del_stage_or_pipeline")).toEqual({ field: "builtin:stage", op: "equals", value: s4[2], effect: "require" });
      expect(await conditionOf(org, "del_pipeline_or_stage")).toEqual({ field: "builtin:stage", op: "in", value: [s4[1]], effect: "show" });
      expect(await conditionOf(org, "del_both_go")).toBeNull();
      expect(await conditionOf(org, "del_untouched_other")).toEqual(before.untouched_other);
      expect(await conditionOf(org, "del_untouched_filled")).toEqual(before.untouched_filled);
      expect(await conditionOf(org, "del_dangling")).toEqual({ field: "builtin:stage", op: "in", value: [s4[1], s4[0]], effect: "show" });
      expect(await conditionOf(otherOrg, "del_other")).toEqual({ field: "builtin:pipeline", op: "equals", value: otherPipeline, effect: "show" });
      // the change is in the audit log, by the person who deleted the pipeline
      const audited = await asAdmin(async (q) =>
        (await q(
          `select count(*)::int as n from public.audit_log a join public.field_definitions f on f.id = a.entity_id
            where a.organization_id = $1 and f.key = 'del_only_pipeline' and a.actor_id = $2 and a.action = 'update'`,
          [org, owner.id],
        )).rows[0].n,
      );
      expect(audited).toBe(1);
      // after the cleanup the check runs again as usual
      expect((await failure(define(owner.id, org, "deal", "after1", { field: "builtin:pipeline", op: "equals", value: p3, effect: "show" }))).hint).toBe(HINT);
    });

    it("the SQL rule equals conditionWithoutPipeline()", async () => {
      const ids = { p3: "11111111-1111-4111-8111-111111111111", p4: "22222222-2222-4222-8222-222222222222", s3: ["31111111-1111-4111-8111-111111111111", "32222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"], s4: ["41111111-1111-4111-8111-111111111111", "42222222-2222-4222-8222-222222222222", "43333333-3333-4333-8333-333333333333"] };
      const conditions: FieldCondition[] = [
        ...Object.values(cases).map((make) => make(ids)),
        { field: "tier", op: "equals", value: "זהב", effect: "show" },
        { field: "builtin:stage", op: "in", value: [ids.s3[0], ids.s3[1]], effect: "show", or: { field: "builtin:pipeline", op: "in", value: [ids.p4, ids.p3] } },
      ];
      for (const condition of conditions) {
        const sql = await asAdmin(async (q) => (await q("select app.condition_without_pipeline($1::jsonb, $2, $3::text[]) as c", [JSON.stringify(condition), ids.p3, ids.s3])).rows[0].c);
        expect(sql, JSON.stringify(condition)).toEqual(conditionWithoutPipeline(condition, ids.p3, ids.s3));
      }
      expect(await asAdmin(async (q) => (await q("select app.condition_without_pipeline(null, $1, '{}') as c", [ids.p3])).rows[0].c)).toBeNull();
    });
  });
});
