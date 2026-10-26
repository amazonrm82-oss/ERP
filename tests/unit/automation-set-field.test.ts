import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CONTACT_CHANNELS, CONTACT_LOCALES } from "@/features/contacts/preferences";
import { BUILTIN_SET_FIELDS } from "@/features/automations/definitions";

import { fromDbRule, toDbRule } from "@/features/automations/convert";
import type { Lookups } from "@/features/automations/queries";
import { ruleSchema } from "@/features/automations/schema";
import { describeSetField, isDateSetField, relativeOf, setFieldChoices, setFieldDraft, setFieldRelativeDraft, setFieldValue } from "@/features/automations/set-field";
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
    deal: [field("kickoff", "date"), field("deal_note", "text")],
  },
};

describe("set_field values (AUT-01)", () => {
  it("offers the built-in fields of the record type, then its custom fields", () => {
    expect(setFieldChoices("lead", lookups).map((c) => c.key)).toEqual([
      "source_id",
      "preferred_channel",
      "preferred_locale",
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

  it("part B: the preferred channel and language of leads and contacts, and the deal's expected close date", () => {
    expect(setFieldChoices("contact", lookups).map((c) => c.key)).toEqual(["source_id", "preferred_channel", "preferred_locale"]);
    expect(setFieldChoices("deal", lookups).map((c) => c.key)).toEqual(["source_id", "expected_close_date", "cf:kickoff", "cf:deal_note"]);
    expect(setFieldChoices("company", lookups).map((c) => c.key)).toEqual(["cf:region"]);
    for (const entity of ["lead", "contact"] as const) {
      expect(setFieldValue(entity, "preferred_channel", "whatsapp", lookups)).toEqual({ value: "whatsapp" });
      expect(setFieldValue(entity, "preferred_channel", "", lookups)).toEqual({ value: null });
      expect(setFieldValue(entity, "preferred_channel", "fax", lookups)).toBe("יש לבחור ערוץ מהרשימה.");
      expect(setFieldValue(entity, "preferred_locale", "am", lookups)).toEqual({ value: "am" });
      expect(setFieldValue(entity, "preferred_locale", "", lookups)).toEqual({ value: null });
      expect(setFieldValue(entity, "preferred_locale", "de", lookups)).toBe("יש לבחור שפה מהרשימה.");
      expect(setFieldValue(entity, "expected_close_date", "2026-12-31", lookups)).toBe("השדה לא מתאים לסוג הרשומה.");
    }
    expect(setFieldValue("deal", "expected_close_date", "2026-12-31", lookups)).toEqual({ value: "2026-12-31" });
    expect(setFieldValue("deal", "expected_close_date", "", lookups)).toEqual({ value: null });
    expect(setFieldValue("deal", "expected_close_date", "2026-02-30", lookups)).toBe("תאריך הסגירה הצפוי לא תקין.");
    for (const field of ["preferred_channel", "preferred_locale"]) {
      expect(setFieldValue("deal", field, "he", lookups)).toBe("השדה לא מתאים לסוג הרשומה.");
      expect(setFieldValue("company", field, "he", lookups)).toBe("השדה לא מתאים לסוג הרשומה.");
      expect(setFieldValue("task", field, "he", lookups)).toBe("השדה לא מתאים לסוג הרשומה.");
    }
    // names and phones never
    for (const [entity, field] of [["lead", "full_name"], ["lead", "phone"], ["contact", "first_name"], ["contact", "phone"], ["deal", "name"]] as const) {
      expect(setFieldValue(entity, field, "x", lookups)).toBe("השדה לא מתאים לסוג הרשומה.");
    }
    expect(describeSetField("lead", "preferred_channel", "whatsapp", lookups)).toBe("ערוץ מועדף: וואטסאפ");
    expect(describeSetField("contact", "preferred_locale", "ar", lookups)).toBe("שפה מועדפת: ערבית");
    expect(describeSetField("contact", "preferred_locale", null, lookups)).toBe("שפה מועדפת: ריקון");
    expect(describeSetField("deal", "expected_close_date", "2026-12-31", lookups)).toMatch(/31/);
  });

  it("part B: a relative date, on date fields only, 0..365 whole days", () => {
    const r = (entity: "lead" | "deal", field: string, unit: string, days: string) => setFieldValue(entity, field, "", lookups, { unit, days });
    expect(isDateSetField("deal", "expected_close_date", lookups)).toBe(true);
    expect(isDateSetField("deal", "cf:kickoff", lookups)).toBe(true);
    expect(isDateSetField("lead", "cf:meet", lookups)).toBe(true);
    expect(isDateSetField("lead", "expected_close_date", lookups)).toBe(false);
    expect(isDateSetField("lead", "cf:note", lookups)).toBe(false);
    expect(r("deal", "expected_close_date", "calendar", "10")).toEqual({ value: { relative: { days: 10, unit: "calendar" } } });
    expect(r("deal", "expected_close_date", "business", "0")).toEqual({ value: { relative: { days: 0, unit: "business" } } });
    expect(r("deal", "cf:kickoff", "business", "365")).toEqual({ value: { relative: { days: 365, unit: "business" } } });
    expect(r("lead", "cf:meet", "calendar", " 2 ")).toEqual({ value: { relative: { days: 2, unit: "calendar" } } });
    for (const days of ["366", "-1", "2.5", "", "שלושה", "1e2"]) {
      expect(r("deal", "expected_close_date", "calendar", days), days).toBe("מספר הימים: מספר שלם מ-0 עד 365.");
    }
    expect(r("deal", "expected_close_date", "weeks", "1")).toBe("יש לבחור איך לחשב את התאריך.");
    expect(r("lead", "cf:note", "calendar", "1")).toBe("תאריך יחסי מתאים רק לשדה תאריך.");
    expect(setFieldValue("lead", "preferred_channel", "", lookups, { unit: "calendar", days: "1" })).toBe("תאריך יחסי מתאים רק לשדה תאריך.");
    // the stored shape is read back the same way, and an invalid one is not taken for a relative date
    expect(relativeOf({ relative: { days: 3, unit: "business" } })).toEqual({ days: 3, unit: "business" });
    for (const bad of [{ relative: { days: 400, unit: "calendar" } }, { relative: { days: 1.5, unit: "calendar" } }, { relative: { days: 1, unit: "x" } }, "2026-01-01", null]) {
      expect(relativeOf(bad)).toBeNull();
    }
    expect(describeSetField("deal", "expected_close_date", { relative: { days: 3, unit: "business" } }, lookups)).toBe("תאריך סגירה צפוי: בעוד 3 ימי עבודה");
    expect(describeSetField("deal", "expected_close_date", { relative: { days: 0, unit: "business" } }, lookups)).toBe("תאריך סגירה צפוי: ביום העבודה הקרוב");
    expect(describeSetField("deal", "cf:kickoff", { relative: { days: 10, unit: "calendar" } }, lookups)).toBe("שדה kickoff: בעוד 10 ימים");
    expect(describeSetField("deal", "cf:kickoff", { relative: { days: 0, unit: "calendar" } }, lookups)).toBe("שדה kickoff: היום");
    expect(setFieldRelativeDraft("2026-01-01")).toBeNull();
    expect(setFieldRelativeDraft({ relative: { days: 7, unit: "calendar" } })).toEqual({ relative_unit: "calendar", relative_days: "7" });
  });

  it("part B: builder -> stored -> builder for the new fields and a relative date", () => {
    const parsed = ruleSchema.parse({
      name: "תאריך סגירה",
      trigger: "deal:created",
      conditions: [],
      actions: [
        { type: "set_field", field: "expected_close_date", relative_unit: "business", relative_days: "5" },
        { type: "set_field", field: "cf:kickoff", value: "2026-11-01" },
        { type: "set_field", field: "expected_close_date" },
      ],
    });
    const db = toDbRule(parsed, lookups);
    expect(typeof db).toBe("object");
    if (typeof db === "string") return;
    expect(db.actions).toEqual([
      { type: "set_field", field: "expected_close_date", value: { relative: { days: 5, unit: "business" } } },
      { type: "set_field", field: "cf:kickoff", value: "2026-11-01" },
      { type: "set_field", field: "expected_close_date", value: null },
    ]);
    const back = fromDbRule(
      { name: db.name, entity: db.entity_type, triggerType: db.trigger_type, triggerConfig: db.trigger_config, conditions: db.conditions, actions: db.actions },
      { fields: lookups.fields },
    );
    expect(back?.actions).toEqual([
      { type: "set_field", field: "expected_close_date", value: "", relative_unit: "business", relative_days: "5" },
      { type: "set_field", field: "cf:kickoff", value: "2026-11-01" },
      { type: "set_field", field: "expected_close_date", value: "" },
    ]);
    const lead = ruleSchema.parse({
      name: "ערוץ",
      trigger: "lead:created",
      conditions: [],
      actions: [
        { type: "set_field", field: "preferred_channel", value: "sms" },
        { type: "set_field", field: "preferred_locale", value: "ru" },
      ],
    });
    const leadDb = toDbRule(lead, lookups);
    expect(typeof leadDb === "object" && leadDb.actions).toEqual([
      { type: "set_field", field: "preferred_channel", value: "sms" },
      { type: "set_field", field: "preferred_locale", value: "ru" },
    ]);
    // a relative date on a field that is not a date, or too many days, is refused when the rule is saved
    const bad = ruleSchema.parse({ name: "x", trigger: "lead:created", conditions: [], actions: [{ type: "set_field", field: "cf:note", relative_unit: "calendar", relative_days: "1" }] });
    expect(toDbRule(bad, lookups)).toBe("תאריך יחסי מתאים רק לשדה תאריך.");
    const tooMany = ruleSchema.parse({ name: "x", trigger: "deal:created", conditions: [], actions: [{ type: "set_field", field: "expected_close_date", relative_unit: "calendar", relative_days: "400" }] });
    expect(toDbRule(tooMany, lookups)).toBe("מספר הימים: מספר שלם מ-0 עד 365.");
  });

  it("the built-in fields and value lists equal the engine's (the latest migration that redefines run_automation_actions)", () => {
    const dir = join(process.cwd(), "supabase", "migrations");
    const file = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .filter((name) => readFileSync(join(dir, name), "utf8").includes("create or replace function app.run_automation_actions"))
      .at(-1)!;
    const sql = readFileSync(join(dir, file), "utf8");
    const branch = sql.slice(sql.indexOf("elsif v_type = 'set_field' then"), sql.indexOf("elsif v_type = 'create_deal' then"));
    const engine = [...branch.matchAll(/elsif v_field = '(\w+)' then\s+if p_entity not in \(([^)]*)\) then/g)].map((m) => ({
      key: m[1],
      entities: [...m[2].matchAll(/'(\w+)'/g)].map((e) => e[1]),
    }));
    expect(engine).toEqual(BUILTIN_SET_FIELDS.map((b) => ({ key: b.key, entities: b.entities })));
    const listAfter = (marker: string) => {
      const part = branch.slice(branch.indexOf(`elsif v_field = '${marker}' then`));
      const array = part.match(/<> all \(array\[([^\]]*)\]\)/)!;
      return [...array[1].matchAll(/'(\w+)'/g)].map((e) => e[1]);
    };
    expect(listAfter("preferred_channel")).toEqual([...CONTACT_CHANNELS]);
    expect(listAfter("preferred_locale")).toEqual([...CONTACT_LOCALES]);
    // the relative-date limits of the engine's helper (the latest migration that redefines app.automation_relative_date)
    const helperFile = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .filter((name) => readFileSync(join(dir, name), "utf8").includes("create or replace function app.automation_relative_date"))
      .at(-1)!;
    const helper = readFileSync(join(dir, helperFile), "utf8");
    expect(helper).toMatch(/\(p_spec ->> 'days'\)::numeric > 365/);
    expect(helper).toMatch(/not in \('calendar', 'business'\)/);
  });
});
