import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BUILTIN_CONDITION_FIELDS,
  buildCondition,
  conditionApplies,
  conditionHolds,
  conditionReminder,
  conditionValuesFromForm,
  describeCondition,
  fieldState,
  hasConditions,
  opsForType,
  parseCondition,
  sameAsStored,
  missingFieldsMessage,
  missingRequiredAfter,
  shownMarkerName,
  type FieldCondition,
} from "@/features/custom-fields/conditions";
import { effectiveDefinitions } from "@/features/custom-fields/form-conditions";
import { customValuesForCreate, customValuesForUpdate } from "@/features/custom-fields/settings";
import type { FieldDefinition } from "@/features/custom-fields/types";
import { parseCustomFields } from "@/features/custom-fields/values";
import { customFieldMessage } from "@/lib/errors";

// FLD-09: conditional fields. The database checks the shape (app.field_condition_check);
// what a condition does is app-only (these functions).

function def(key: string, type: FieldDefinition["type"], extra: Partial<FieldDefinition> = {}): FieldDefinition {
  return { id: `id-${key}`, key, label: key, type, options: [], isRequired: false, isActive: true, helpText: null, ...extra };
}

const tier = def("tier", "select", { options: ["רגיל", "זהב", "פלטינה"] });
const tags = def("tags", "multi_select", { options: ["א", "ב", "ג"] });
const vip = def("vip", "checkbox");
const score = def("score", "rating");
const note = def("note", "text");

const STATUS_NEW = "11111111-1111-4111-8111-111111111111";
const STATUS_WON = "22222222-2222-4222-8222-222222222222";

describe("conditionHolds", () => {
  it("equals / not_equals on a select", () => {
    const c: FieldCondition = { field: "tier", op: "equals", value: "זהב", effect: "show" };
    expect(conditionHolds(c, { tier: "זהב" })).toBe(true);
    expect(conditionHolds(c, { tier: "רגיל" })).toBe(false);
    expect(conditionHolds(c, {})).toBe(false);
    const n: FieldCondition = { ...c, op: "not_equals" };
    expect(conditionHolds(n, { tier: "רגיל" })).toBe(true);
    expect(conditionHolds(n, {})).toBe(true);
    expect(conditionHolds(n, { tier: "זהב" })).toBe(false);
  });

  it("a multi_select holds a choice when it contains it; in = any of them", () => {
    expect(conditionHolds({ field: "tags", op: "equals", value: "ב", effect: "show" }, { tags: ["א", "ב"] })).toBe(true);
    expect(conditionHolds({ field: "tags", op: "not_equals", value: "ב", effect: "show" }, { tags: ["א"] })).toBe(true);
    expect(conditionHolds({ field: "tags", op: "in", value: ["ג", "ב"], effect: "show" }, { tags: ["א", "ב"] })).toBe(true);
    expect(conditionHolds({ field: "tags", op: "in", value: ["ג"], effect: "show" }, { tags: ["א", "ב"] })).toBe(false);
  });

  it("a checkbox: unticked is false", () => {
    const off: FieldCondition = { field: "vip", op: "equals", value: false, effect: "show" };
    expect(conditionHolds(off, {})).toBe(true);
    expect(conditionHolds(off, { vip: false })).toBe(true);
    expect(conditionHolds(off, { vip: true })).toBe(false);
    expect(conditionHolds({ ...off, value: true }, { vip: true })).toBe(true);
    expect(conditionHolds({ ...off, value: true }, {})).toBe(false);
  });

  it("in, filled and empty; a rating compares numbers", () => {
    expect(conditionHolds({ field: "score", op: "in", value: [4, 5], effect: "show" }, { score: 5 })).toBe(true);
    expect(conditionHolds({ field: "score", op: "in", value: [4, 5], effect: "show" }, { score: 3 })).toBe(false);
    expect(conditionHolds({ field: "note", op: "filled", effect: "show" }, { note: "x" })).toBe(true);
    expect(conditionHolds({ field: "note", op: "filled", effect: "show" }, { note: "  " })).toBe(false);
    expect(conditionHolds({ field: "note", op: "empty", effect: "show" }, {})).toBe(true);
    expect(conditionHolds({ field: "tags", op: "empty", effect: "show" }, { tags: [] })).toBe(true);
  });

  it("built-in fields compare ids", () => {
    const c: FieldCondition = { field: "builtin:status", op: "in", value: [STATUS_NEW, STATUS_WON], effect: "require" };
    expect(conditionHolds(c, { "builtin:status": STATUS_WON })).toBe(true);
    expect(conditionHolds(c, { "builtin:status": null })).toBe(false);
  });
});

describe("fieldState", () => {
  const shown = def("budget", "number", { condition: { field: "tier", op: "equals", value: "זהב", effect: "show" }, isRequired: true });
  const required = def("reason", "text", { condition: { field: "builtin:status", op: "equals", value: STATUS_WON, effect: "require" } });
  const all = [tier, shown, required, note];

  it("show: hidden (and never required) while the condition does not hold", () => {
    expect(fieldState(shown, all, { tier: "רגיל" }, "lead")).toEqual({ visible: false, required: false });
    expect(fieldState(shown, all, { tier: "זהב" }, "lead")).toEqual({ visible: true, required: true });
  });

  it("require: always shown, required while it holds", () => {
    expect(fieldState(required, all, { "builtin:status": STATUS_NEW }, "lead")).toEqual({ visible: true, required: false });
    expect(fieldState(required, all, { "builtin:status": STATUS_WON }, "lead")).toEqual({ visible: true, required: true });
  });

  it("a deleted or hidden controlling field: the condition is ignored and the field always shows", () => {
    expect(fieldState(shown, [shown, note], { tier: "רגיל" }, "lead")).toEqual({ visible: true, required: true });
    const hiddenTier = { ...tier, isActive: false };
    expect(fieldState(shown, [hiddenTier, shown], {}, "lead")).toEqual({ visible: true, required: true });
    expect(hasConditions([shown, note], "lead")).toBe(false);
    expect(hasConditions(all, "lead")).toBe(true);
  });

  it("a controlling field whose type no longer takes the op, or a built-in of another record type, is ignored", () => {
    const retyped = { ...tier, type: "text" as const };
    expect(conditionApplies(shown.condition!, [retyped, shown], "lead")).toBe(false);
    expect(conditionApplies({ field: "builtin:stage", op: "filled", effect: "show" }, [], "lead")).toBe(false);
    expect(conditionApplies({ field: "builtin:stage", op: "filled", effect: "show" }, [], "deal")).toBe(true);
  });
});

describe("parseCondition", () => {
  it("accepts the stored shapes and nothing else", () => {
    expect(parseCondition({ field: "tier", op: "equals", value: "זהב", effect: "show" })).toEqual({ field: "tier", op: "equals", value: "זהב", effect: "show" });
    expect(parseCondition({ field: "note", op: "filled", effect: "require" })).toEqual({ field: "note", op: "filled", effect: "require" });
    expect(parseCondition(null)).toBeNull();
    expect(parseCondition({ field: "tier", op: "equals", effect: "show" })).toBeNull();
    expect(parseCondition({ field: "tier", op: "in", value: "x", effect: "show" })).toBeNull();
    expect(parseCondition({ field: "tier", op: "like", value: "x", effect: "show" })).toBeNull();
    expect(parseCondition({ field: "tier", op: "equals", value: "x", effect: "hide" })).toBeNull();
  });
});

describe("buildCondition (the settings form)", () => {
  const target = def("budget", "number");
  const all = [tier, tags, vip, score, note, target];
  const builtins = { "builtin:status": [{ value: STATUS_NEW, label: "חדש" }, { value: STATUS_WON, label: "נסגר" }] };
  const build = (input: { effect: string; controller: string; op: string; choices: string[] }, defs = all, field = target) =>
    buildCondition(field, defs, "lead", builtins, input);

  it("builds each op with typed values", () => {
    expect(build({ effect: "show", controller: "tier", op: "equals", choices: ["זהב"] })).toEqual({
      ok: true,
      condition: { field: "tier", op: "equals", value: "זהב", effect: "show" },
    });
    expect(build({ effect: "require", controller: "vip", op: "equals", choices: ["true"] })).toEqual({
      ok: true,
      condition: { field: "vip", op: "equals", value: true, effect: "require" },
    });
    expect(build({ effect: "show", controller: "score", op: "in", choices: ["4", "5"] })).toEqual({
      ok: true,
      condition: { field: "score", op: "in", value: [4, 5], effect: "show" },
    });
    expect(build({ effect: "show", controller: "note", op: "filled", choices: [] })).toEqual({
      ok: true,
      condition: { field: "note", op: "filled", effect: "show" },
    });
    expect(build({ effect: "show", controller: "builtin:status", op: "in", choices: [STATUS_WON] })).toEqual({
      ok: true,
      condition: { field: "builtin:status", op: "in", value: [STATUS_WON], effect: "show" },
    });
    expect(build({ effect: "none", controller: "", op: "", choices: [] })).toEqual({ ok: true, condition: null });
  });

  it("refuses: itself, a value off the list, an op the type does not take, a built-in of another type", () => {
    expect(build({ effect: "show", controller: "budget", op: "filled", choices: [] }).ok).toBe(false);
    expect(build({ effect: "show", controller: "tier", op: "equals", choices: ["אין כזה"] }).ok).toBe(false);
    expect(build({ effect: "show", controller: "tier", op: "equals", choices: ["זהב", "רגיל"] }).ok).toBe(false);
    expect(build({ effect: "show", controller: "note", op: "equals", choices: ["x"] }).ok).toBe(false);
    expect(build({ effect: "show", controller: "vip", op: "filled", choices: [] }).ok).toBe(false);
    expect(build({ effect: "show", controller: "builtin:stage", op: "filled", choices: [] }).ok).toBe(false);
    expect(build({ effect: "maybe", controller: "tier", op: "equals", choices: ["זהב"] }).ok).toBe(false);
  });

  it("no chains: a controller with a condition is not offered, and a field others depend on gets none", () => {
    const dependent = { ...tier, condition: { field: "vip", op: "equals", value: true, effect: "show" } as FieldCondition };
    expect(build({ effect: "show", controller: "tier", op: "equals", choices: ["זהב"] }, [dependent, vip, target]).ok).toBe(false);
    const controlled = def("budget", "number", { condition: { field: "tier", op: "filled", effect: "show" } });
    expect(build({ effect: "show", controller: "note", op: "filled", choices: [] }, [tier, note, controlled], tier).ok).toBe(false);
    // a hidden controller is not offered either
    expect(build({ effect: "show", controller: "tier", op: "equals", choices: ["זהב"] }, [{ ...tier, isActive: false }, target]).ok).toBe(false);
  });

  it("sameAsStored: the editor repeating what is saved", () => {
    const stored: FieldCondition = { field: "score", op: "in", value: [5, 4], effect: "show" };
    expect(sameAsStored(stored, { effect: "show", controller: "score", op: "in", choices: ["4", "5"] })).toBe(true);
    expect(sameAsStored(stored, { effect: "show", controller: "score", op: "in", choices: ["4"] })).toBe(false);
    expect(sameAsStored(null, { effect: "none", controller: "", op: "", choices: [] })).toBe(true);
    expect(sameAsStored(null, { effect: "show", controller: "tier", op: "filled", choices: [] })).toBe(false);
  });
});

describe("the settings page reminder and description", () => {
  const builtins = { "builtin:status": [{ value: STATUS_NEW, label: "חדש" }] };
  const field = def("budget", "number", { condition: { field: "tier", op: "equals", value: "זהב", effect: "show" } });

  it("is silent while the condition works", () => {
    expect(conditionReminder(field, [tier, field], "lead", builtins)).toBeNull();
    expect(describeCondition(field.condition!, [tier, field], "lead", builtins)).toBe('מופיע רק כאשר "tier" שווה ל: "זהב"');
  });

  it("names a deleted or hidden controller, and a removed choice", () => {
    expect(conditionReminder(field, [field], "lead", builtins)).toMatch(/נמחק/);
    expect(conditionReminder(field, [{ ...tier, isActive: false }, field], "lead", builtins)).toMatch(/מוסתר/);
    expect(conditionReminder(field, [{ ...tier, options: ["רגיל"] }, field], "lead", builtins)).toMatch(/הוסר/);
    const onStatus = def("x", "text", { condition: { field: "builtin:status", op: "equals", value: STATUS_WON, effect: "require" } });
    expect(conditionReminder(onStatus, [onStatus], "lead", builtins)).toMatch(/הוסר/);
  });
});

describe("conditionValuesFromForm (server)", () => {
  it("reads the built-in inputs the form has, else what the record holds", () => {
    const form = new FormData();
    form.set("source_id", "");
    const values = conditionValuesFromForm("lead", form, { tier: "זהב" }, { custom: { tier: "רגיל", note: "x" }, builtins: { "builtin:status": STATUS_WON, "builtin:source": "s" } }, ["builtin:source"]);
    expect(values).toEqual({ tier: "זהב", note: "x", "builtin:status": STATUS_WON, "builtin:source": null });
  });
});

describe("effectiveDefinitions (what a record form checks and sends)", () => {
  const budget = def("budget", "number", { isRequired: true, defaultValue: 5, condition: { field: "tier", op: "equals", value: "זהב", effect: "show" } });
  const reason = def("reason", "text", { condition: { field: "builtin:status", op: "equals", value: STATUS_WON, effect: "require" } });
  const locked = def("origin", "text", { isReadOnly: true, condition: { field: "builtin:status", op: "equals", value: STATUS_WON, effect: "require" } });
  const all = [tier, budget, reason, locked];
  const form = (entries: Record<string, string>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(entries)) data.set(key, value);
    return data;
  };

  it("a hidden field is not checked and not sent: an edit keeps its value, a create leaves the default to the database", () => {
    const data = form({ cf_tier: "רגיל", cf_budget: "not a number", status_id: STATUS_NEW });
    const defs = effectiveDefinitions("lead", all, data, null, false, ["builtin:status", "builtin:source"]);
    expect(defs.map((field) => field.key)).toEqual(["tier", "reason", "origin"]);
    const { values, errors } = parseCustomFields(defs, data);
    expect(errors).toEqual({});
    expect("budget" in customValuesForCreate(defs, values)).toBe(false);
    expect("budget" in customValuesForUpdate(defs, values)).toBe(false);
  });

  it("a shown field keeps its own required box; a require condition that holds makes the field required", () => {
    const data = form({ cf_tier: "זהב", status_id: STATUS_WON });
    const defs = effectiveDefinitions("lead", all, data, null, false, ["builtin:status", "builtin:source"]);
    const { errors } = parseCustomFields(defs, data);
    expect(Object.keys(errors).sort()).toEqual(["cf_budget", "cf_origin", "cf_reason"]);
  });

  it("an edit form without the status input reads the record's status; a locked read-only value is satisfied", () => {
    const data = form({ cf_tier: "רגיל", [shownMarkerName("reason")]: "1", [shownMarkerName("origin")]: "1" });
    const stored = { custom: { origin: "אתר" }, builtins: { "builtin:status": STATUS_WON } };
    const defs = effectiveDefinitions("lead", all, data, stored, true);
    const { errors } = parseCustomFields(defs, data);
    expect(Object.keys(errors)).toEqual(["cf_reason"]);
  });
});

describe("the shown marker on an edit (review fix)", () => {
  const budget = def("budget", "number", { condition: { field: "builtin:status", op: "equals", value: STATUS_WON, effect: "show" } });
  const all = [budget, note];

  it("an edit skips a conditional field whose marker did not arrive, even when the server thinks it shows", () => {
    const data = new FormData();
    data.set("cf_note", "x");
    const stored = { custom: { budget: 7 }, builtins: { "builtin:status": STATUS_WON } };
    const defs = effectiveDefinitions("lead", all, data, stored, true, []);
    expect(defs.map((field) => field.key)).toEqual(["note"]);
    // nothing is sent for it, so the stored value stays
    const { values } = parseCustomFields(defs, data);
    expect("budget" in customValuesForUpdate(defs, values)).toBe(false);
  });

  it("with the marker it is checked and sent", () => {
    const data = new FormData();
    data.set(shownMarkerName("budget"), "1");
    data.set("cf_budget", "");
    const stored = { custom: { budget: 7 }, builtins: { "builtin:status": STATUS_WON } };
    const defs = effectiveDefinitions("lead", all, data, stored, true, []);
    expect(defs.map((field) => field.key)).toEqual(["budget", "note"]);
    const { values } = parseCustomFields(defs, data);
    expect(customValuesForUpdate(defs, values).budget).toBeNull();
  });

  it("a built-in input the action does not write is ignored; the record's value counts", () => {
    const data = new FormData();
    data.set("status_id", STATUS_NEW);
    data.set(shownMarkerName("budget"), "1");
    const stored = { custom: {}, builtins: { "builtin:status": STATUS_WON } };
    expect(effectiveDefinitions("lead", all, data, stored, true, []).map((f) => f.key)).toEqual(["budget", "note"]);
    expect(effectiveDefinitions("lead", all, data, stored, true, ["builtin:status"]).map((f) => f.key)).toEqual(["note"]);
  });
});

describe("missingRequiredAfter (board, table cell, bulk)", () => {
  const STAGE_A = "33333333-3333-4333-8333-333333333333";
  const STAGE_WON = "44444444-4444-4444-8444-444444444444";
  const signed = def("signed", "date", { label: "תאריך חתימה", condition: { field: "builtin:stage", op: "equals", value: STAGE_WON, effect: "require" } });
  const contract = def("contract", "checkbox", { label: "חוזה נחתם", condition: { field: "builtin:stage", op: "in", value: [STAGE_WON], effect: "require" } });
  const shownRequired = def("po", "text", { label: "מספר הזמנה", isRequired: true, condition: { field: "builtin:stage", op: "equals", value: STAGE_WON, effect: "show" } });
  const plainRequired = def("plain", "text", { label: "רגיל", isRequired: true });
  const onTier = def("budget", "number", { label: "תקציב", condition: { field: "tier", op: "equals", value: "זהב", effect: "require" } });
  const all = [signed, contract, shownRequired, plainRequired, onTier, tier];

  it("names the conditional fields the target makes required and the record leaves empty", () => {
    const missing = missingRequiredAfter(all, { "builtin:stage": STAGE_A }, "deal", { "builtin:stage": STAGE_WON });
    expect(missing.map((field) => field.key)).toEqual(["signed", "contract", "po"]);
  });

  it("a filled value, a ticked box, or a target that requires nothing: none", () => {
    expect(missingRequiredAfter(all, { signed: "2026-10-14", contract: true, po: "77" }, "deal", { "builtin:stage": STAGE_WON })).toEqual([]);
    expect(missingRequiredAfter(all, { contract: false }, "deal", { "builtin:stage": STAGE_A }).map((f) => f.key)).toEqual([]);
    // an unticked box is missing
    expect(missingRequiredAfter(all, { signed: "2026-10-14", po: "1", contract: false }, "deal", { "builtin:stage": STAGE_WON }).map((f) => f.key)).toEqual(["contract"]);
  });

  it("a field required by its own box alone, or by a condition the change does not touch, counts only when its condition holds", () => {
    // plain required without a condition never counts here (the record form's business)
    expect(missingRequiredAfter(all, {}, "deal", { "builtin:stage": STAGE_A }).some((f) => f.key === "plain")).toBe(false);
    // a custom-field condition that already holds is reported too: the record would be left without it
    expect(missingRequiredAfter(all, { tier: "זהב" }, "deal", { "builtin:stage": STAGE_A }).map((f) => f.key)).toEqual(["budget"]);
  });

  it("a condition on a hidden or deleted controlling field is ignored", () => {
    const hiddenTier = { ...tier, isActive: false };
    expect(missingRequiredAfter([onTier, hiddenTier], { tier: "זהב" }, "deal", {})).toEqual([]);
    expect(missingRequiredAfter([onTier], { tier: "זהב" }, "deal", {})).toEqual([]);
  });

  it("the owner's wording", () => {
    expect(missingFieldsMessage([{ label: "תקציב" }])).toBe("חסר שדה חובה: תקציב");
    expect(missingFieldsMessage([{ label: "תקציב" }, { label: "תאריך חתימה" }])).toBe("חסר שדה חובה: תקציב, תאריך חתימה");
  });
});

describe("mirrors the database", () => {
  const migration = readFileSync(
    join(
      "supabase/migrations",
      readdirSync("supabase/migrations").find((name) => name.endsWith("_conditional_fields.sql")) ?? "",
    ),
    "utf8",
  );

  it("the same built-in fields", () => {
    const pairs = [...migration.matchAll(/\('(lead|deal|contact|company)', '(\w+)'\)/g)].map((m) => `${m[1]}:${m[2]}`).sort();
    const ours = Object.entries(BUILTIN_CONDITION_FIELDS)
      .flatMap(([object, fields]) => fields.map((field) => `${object}:${field.key.slice("builtin:".length)}`))
      .sort();
    expect(pairs).toEqual(ours);
  });

  it("the same ops per controlling type", () => {
    expect(migration).toContain("v_op in ('equals', 'not_equals') and v_ctrl.field_type not in ('select', 'multi_select', 'checkbox', 'rating')");
    expect(migration).toContain("v_op = 'in' and v_ctrl.field_type not in ('select', 'multi_select', 'rating')");
    expect(opsForType("select")).toEqual(["equals", "not_equals", "in", "filled", "empty"]);
    expect(opsForType("checkbox")).toEqual(["equals", "not_equals"]);
    expect(opsForType("text")).toEqual(["filled", "empty"]);
    expect(opsForType("builtin")).toEqual(["equals", "not_equals", "in", "filled", "empty"]);
  });

  it("maps the refusal to Hebrew", () => {
    expect(customFieldMessage({ code: "P0001", hint: "custom_field:condition", message: "x" })).toMatch(/התנאי/);
  });
});
