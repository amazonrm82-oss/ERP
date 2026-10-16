import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { fromDbRule, toDbRule } from "@/features/automations/convert";
import { DATE_TRIGGER_FIELDS, DATE_TRIGGER_HOUR, dateTriggerChoices, describeDateTrigger } from "@/features/automations/date-trigger";
import { describeRule } from "@/features/automations/describe";
import type { Lookups } from "@/features/automations/queries";
import { ruleSchema } from "@/features/automations/schema";
import { TEMPLATES } from "@/features/automations/templates";
import type { FieldDefinition, FieldType } from "@/features/custom-fields/types";

// AUT-03: the "X days before or after a date" trigger: builder values -> stored setting -> builder values, and the texts.

// found by its name, so renumbering the migration at merge keeps the test
const ENGINE = readFileSync(
  `supabase/migrations/${readdirSync("supabase/migrations").find((file) => file.endsWith("_automation_date_triggers.sql"))}`,
  "utf8",
);

const field = (key: string, type: FieldType): FieldDefinition => ({
  id: `id-${key}`,
  key,
  label: `שדה ${key}`,
  type,
  options: [],
  isRequired: false,
  isActive: true,
  helpText: null,
});

const lookups: Lookups = {
  statuses: [],
  sources: [],
  tags: [],
  pipelines: [],
  members: [],
  teams: [],
  reasons: [],
  fields: { contact: [field("visit", "date"), field("call_at", "datetime"), field("note", "text")] },
};

const parse = (trigger: string, extra: Record<string, unknown>) =>
  ruleSchema.parse({ name: "כלל", trigger, conditions: [], actions: [{ type: "notify", to: "admins", title: "הגיע" }], ...extra });

describe("date triggers (AUT-03)", () => {
  it("the built-in date fields equal the engine's list, per record type", () => {
    for (const [entity, fields] of Object.entries(DATE_TRIGGER_FIELDS)) {
      const line = ENGINE.match(new RegExp(`when '${entity}' then array\\[([^\\]]*)\\]`));
      expect(line, entity).not.toBeNull();
      const keys = [...line![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
      expect(keys, entity).toEqual(fields.map((f) => f.key));
    }
    expect(ENGINE).toContain(`else ${DATE_TRIGGER_HOUR} end`);
  });

  it("offers the built-in date fields, then the custom date and date-and-time fields", () => {
    expect(dateTriggerChoices("contact", lookups).map((c) => c.key)).toEqual(["created_at", "cf:visit", "cf:call_at"]);
    expect(dateTriggerChoices("deal", lookups).map((c) => c.key)).toEqual(["created_at", "expected_close_date", "renewal_date", "recurring_start_date"]);
  });

  it("stores before, after and on the day, and reads them back", () => {
    const store = (extra: Record<string, unknown>, trigger = "contact:date") => {
      const db = toDbRule(parse(trigger, extra), lookups);
      if (typeof db === "string") throw new Error(db);
      return db;
    };
    const before = store({ trigger_field: "cf:visit", trigger_direction: "before", trigger_days: "3" });
    expect(before.trigger_type).toBe("date_reached");
    expect(before.trigger_config).toEqual({ field: "cf:visit", days: 3, direction: "before" });
    expect(store({ trigger_field: "created_at", trigger_direction: "after", trigger_days: 10 }).trigger_config).toEqual({ field: "created_at", days: 10, direction: "after" });
    // on the day = 0 days after, whatever days were typed
    const on = store({ trigger_field: "cf:call_at", trigger_direction: "on", trigger_days: 7 });
    expect(on.trigger_config).toEqual({ field: "cf:call_at", days: 0, direction: "after" });
    const back = (db: ReturnType<typeof store>) =>
      fromDbRule({ name: "כלל", entity: db.entity_type, triggerType: db.trigger_type, triggerConfig: db.trigger_config, conditions: [], actions: db.actions });
    expect(back(before)).toMatchObject({ trigger: "contact:date", triggerField: "cf:visit", triggerDirection: "before", triggerDays: "3" });
    expect(back(on)).toMatchObject({ triggerField: "cf:call_at", triggerDirection: "on" });
  });

  it("refuses a missing or unknown field, a text field, and days outside 1..365", () => {
    const refuse = (extra: Record<string, unknown>, trigger = "contact:date") => toDbRule(parse(trigger, extra), lookups);
    expect(refuse({ trigger_direction: "before", trigger_days: 3 })).toBe("יש לבחור שדה תאריך.");
    expect(refuse({ trigger_field: "cf:note", trigger_direction: "before", trigger_days: 3 })).toBe("שדה התאריך שנבחר כבר לא קיים או מוסתר.");
    expect(refuse({ trigger_field: "renewal_date", trigger_direction: "before", trigger_days: 3 })).toBe("שדה התאריך שנבחר כבר לא קיים או מוסתר.");
    expect(refuse({ trigger_field: "created_at", trigger_direction: "before", trigger_days: 0 })).toMatch(/בין 1 ל-365/);
    expect(ruleSchema.safeParse({ name: "כלל", trigger: "contact:date", trigger_days: 366, conditions: [], actions: [{ type: "notify", to: "admins", title: "x" }] }).success).toBe(false);
  });

  it("says the trigger in Hebrew", () => {
    expect(describeDateTrigger("deal", { field: "renewal_date", days: 30, direction: "before" }, lookups)).toBe("30 ימים לפני תאריך החידוש");
    expect(describeDateTrigger("task", { field: "due_at", days: 1, direction: "after" }, lookups)).toBe("יום אחד אחרי מועד המשימה");
    expect(describeDateTrigger("contact", { field: "cf:visit", days: 0, direction: "after" }, lookups)).toBe("ביום שדה visit");
    expect(describeDateTrigger("contact", { field: "cf:gone", days: 2, direction: "after" }, lookups)).toBe("2 ימים אחרי שדה תאריך שנמחק או הוסתר");
    const when = describeRule(
      { entity: "deal", triggerType: "date_reached", triggerConfig: { field: "renewal_date", days: 30, direction: "before" }, conditions: [], actions: [] },
      lookups,
    ).when;
    expect(when).toBe("תאריך בעסקה: 30 ימים לפני תאריך החידוש");
  });

  it("the renewal template is now a real rule", () => {
    const template = TEMPLATES.find((t) => t.key === "renewal_30d")!;
    expect(template.unavailable).toBeUndefined();
    const rule = template.build!(lookups)!;
    const db = toDbRule(ruleSchema.parse(rule), lookups);
    if (typeof db === "string") throw new Error(db);
    expect(db).toMatchObject({ entity_type: "deal", trigger_type: "date_reached", trigger_config: { field: "renewal_date", days: 30, direction: "before" } });
  });
});
