import { describe, expect, it } from "vitest";

import { fromDbRule, toDbRule } from "@/features/automations/convert";
import type { Lookups } from "@/features/automations/queries";
import { ruleSchema } from "@/features/automations/schema";
import { describeSetField, setFieldChoices, setFieldDraft, setFieldValue } from "@/features/automations/set-field";
import type { FieldDefinition, FieldType } from "@/features/custom-fields/types";

// AUT-01: the builder's typed value -> the stored JSON value (the same rules as a record form), and back.

const field = (key: string, type: FieldType, extra: Partial<FieldDefinition> = {}): FieldDefinition => ({
  id: `id-${key}`,
  key,
  label: `שדה ${key}`,
  type,
  options: [],
  isRequired: false,
  isActive: true,
  helpText: null,
  ...extra,
});

const MEMBER = "11111111-1111-4111-8111-111111111111";
const SOURCE = "22222222-2222-4222-8222-222222222222";

const lookups: Lookups = {
  statuses: [],
  sources: [{ id: SOURCE, name: "כנס" }],
  tags: [],
  pipelines: [],
  members: [{ id: MEMBER, name: "דנה" }],
  teams: [],
  reasons: [],
  fields: {
    lead: [
      field("note", "text", { isRequired: true }),
      field("size", "number"),
      field("budget", "currency"),
      field("tier", "select", { options: ["זהב", "כסף"] }),
      field("topics", "multi_select", { options: ["א", "ב", "ג"] }),
      field("vip", "checkbox"),
      field("visit", "date"),
      field("meet", "datetime"),
      field("rep", "user", { choices: [{ value: MEMBER, label: "דנה" }] }),
      field("mail", "email"),
    ],
    company: [field("region", "select", { options: ["צפון"] })],
  },
};

describe("set_field values (AUT-01)", () => {
  it("offers the built-in fields of the record type, then its custom fields", () => {
    expect(setFieldChoices("lead", lookups).map((c) => c.key)).toEqual([
      "source_id",
      "cf:note",
      "cf:size",
      "cf:budget",
      "cf:tier",
      "cf:topics",
      "cf:vip",
      "cf:visit",
      "cf:meet",
      "cf:rep",
      "cf:mail",
    ]);
    expect(setFieldChoices("company", lookups).map((c) => c.key)).toEqual(["cf:region"]);
    expect(setFieldChoices("task", lookups).map((c) => c.key)).toEqual(["task_type"]);
  });

  it("reads each kind of value as a record form does; empty clears, even a required field", () => {
    const v = (field: string, raw: string) => setFieldValue("lead", field, raw, lookups);
    expect(v("cf:note", " שלום ")).toEqual({ value: "שלום" });
    expect(v("cf:note", "")).toEqual({ value: null });
    expect(v("cf:size", "1,200")).toEqual({ value: 1200 });
    expect(v("cf:budget", "1,500.50")).toEqual({ value: 150050 });
    expect(v("cf:tier", "כסף")).toEqual({ value: "כסף" });
    expect(v("cf:topics", "ג\nא")).toEqual({ value: ["א", "ג"] });
    expect(v("cf:topics", "")).toEqual({ value: null });
    expect(v("cf:vip", "true")).toEqual({ value: true });
    expect(v("cf:vip", "")).toEqual({ value: false });
    expect(v("cf:visit", "2026-11-01")).toEqual({ value: "2026-11-01" });
    expect(v("cf:rep", MEMBER)).toEqual({ value: MEMBER });
    expect(v("cf:mail", "Dana@Example.test")).toEqual({ value: "dana@example.test" });
    const meet = v("cf:meet", "2026-11-01T09:30");
    expect(typeof meet === "object" && typeof meet.value === "string" && meet.value.startsWith("2026-11-01T")).toBe(true);
  });

  it("refuses a value the field does not take, in Hebrew", () => {
    const v = (field: string, raw: string) => setFieldValue("lead", field, raw, lookups);
    for (const [f, raw] of [
      ["cf:size", "הרבה"],
      ["cf:tier", "ארד"],
      ["cf:topics", "ד"],
      ["cf:visit", "2026-02-30"],
      ["cf:rep", "33333333-3333-4333-8333-333333333333"],
      ["cf:mail", "לא אימייל"],
    ]) {
      const result = v(f, raw);
      expect(typeof result, f).toBe("string");
      expect(result as string).toMatch(/[א-ת]/);
    }
    expect(v("cf:gone", "x")).toBe("השדה שנבחר כבר לא קיים או מוסתר.");
    expect(setFieldValue("company", "source_id", SOURCE, lookups)).toBe("השדה לא מתאים לסוג הרשומה.");
    expect(setFieldValue("lead", "full_name", "x", lookups)).toBe("השדה לא מתאים לסוג הרשומה.");
  });

  it("built-in fields: a source of the list or none, and a task type", () => {
    expect(setFieldValue("deal", "source_id", SOURCE, lookups)).toEqual({ value: SOURCE });
    expect(setFieldValue("deal", "source_id", "", lookups)).toEqual({ value: null });
    expect(setFieldValue("deal", "source_id", "44444444-4444-4444-8444-444444444444", lookups)).toBe("המקור שנבחר כבר לא קיים.");
    expect(setFieldValue("task", "task_type", "call", lookups)).toEqual({ value: "call" });
    expect(setFieldValue("task", "task_type", "", lookups)).toBe("יש לבחור סוג משימה.");
  });

  it("a saved value comes back to the builder as it was typed", () => {
    const fields = lookups.fields.lead!;
    const def = (key: string) => fields.find((f) => f.key === key);
    expect(setFieldDraft(def("budget"), 150050)).toBe("1500.5");
    expect(setFieldDraft(def("topics"), ["א", "ג"])).toBe("א\nג");
    expect(setFieldDraft(def("vip"), true)).toBe("true");
    expect(setFieldDraft(def("vip"), false)).toBe("");
    expect(setFieldDraft(def("note"), null)).toBe("");
    const stored = setFieldValue("lead", "cf:meet", "2026-11-01T09:30", lookups);
    expect(setFieldDraft(def("meet"), (stored as { value: string }).value)).toBe("2026-11-01T09:30");
  });

  it("the whole rule: builder -> stored -> builder, and its description", () => {
    const parsed = ruleSchema.parse({
      name: "סימון ליד",
      trigger: "lead:created",
      conditions: [],
      actions: [
        { type: "set_field", field: "cf:budget", value: "2,000" },
        { type: "set_field", field: "cf:tier" },
        { type: "set_field", field: "source_id", value: SOURCE },
      ],
    });
    const db = toDbRule(parsed, lookups);
    expect(typeof db).toBe("object");
    if (typeof db === "string") return;
    expect(db.actions).toEqual([
      { type: "set_field", field: "cf:budget", value: 200000 },
      { type: "set_field", field: "cf:tier", value: null },
      { type: "set_field", field: "source_id", value: SOURCE },
    ]);
    const back = fromDbRule(
      { name: db.name, entity: db.entity_type, triggerType: db.trigger_type, triggerConfig: db.trigger_config, conditions: db.conditions, actions: db.actions },
      { fields: lookups.fields },
    );
    expect(back?.actions).toEqual([
      { type: "set_field", field: "cf:budget", value: "2000" },
      { type: "set_field", field: "cf:tier", value: "" },
      { type: "set_field", field: "source_id", value: SOURCE },
    ]);
    expect(describeSetField("lead", "cf:tier", null, lookups)).toBe("שדה tier: ריקון");
    expect(describeSetField("lead", "source_id", SOURCE, lookups)).toBe("מקור: כנס");
    expect(describeSetField("lead", "cf:vip", true, lookups)).toBe("שדה vip: כן");
    expect(describeSetField("lead", "cf:gone", "x", lookups)).toBe("שדה שנמחק או הוסתר");
    // a bad value is refused when the rule is saved
    const bad = ruleSchema.parse({ name: "x", trigger: "lead:created", conditions: [], actions: [{ type: "set_field", field: "cf:tier", value: "ארד" }] });
    expect(typeof toDbRule(bad, lookups)).toBe("string");
  });
});
