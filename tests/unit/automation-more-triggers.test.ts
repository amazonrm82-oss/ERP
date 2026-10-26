import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { FieldDefinition } from "@/features/custom-fields/types";
import { fromDbRule, toDbRule } from "@/features/automations/convert";
import { TRIGGERS, triggerOf } from "@/features/automations/definitions";
import { describeRule } from "@/features/automations/describe";
import { describeFieldTrigger, WATCH_FIELDS, watchChoices, watchValues } from "@/features/automations/field-trigger";
import { isManualEntity, manualRulesOf, manualRunResult } from "@/features/automations/manual";
import type { Lookups } from "@/features/automations/queries";
import { ruleSchema } from "@/features/automations/schema";
import { describeScheduleTrigger, scheduleTriggerConfig, scheduleTriggerDraft } from "@/features/automations/schedule-trigger";

// AUT-03 (rest): "a field changed" on any field, "form submitted", a fixed schedule and the card's manual button.

const ENGINE = readFileSync(
  `supabase/migrations/${readdirSync("supabase/migrations").find((file) => file.endsWith("_automation_more_triggers.sql"))}`,
  "utf8",
);

const field = (key: string, type: FieldDefinition["type"], options: string[] = []): FieldDefinition => ({
  id: key,
  key,
  label: `שדה ${key}`,
  type,
  options,
  isRequired: false,
  isActive: true,
  helpText: null,
});

const OWNER = "11111111-1111-4111-8111-111111111111";
const SOURCE = "22222222-2222-4222-8222-222222222222";
const FORM = "33333333-3333-4333-8333-333333333333";
const lookups: Lookups = {
  statuses: [],
  sources: [{ id: SOURCE, name: "פייסבוק" }],
  tags: [],
  pipelines: [],
  members: [{ id: OWNER, name: "דנה" }],
  teams: [],
  reasons: [],
  fields: { lead: [field("level", "select", ["חם", "קר"]), field("vip", "checkbox"), field("note", "text")] },
  forms: [{ id: FORM, name: "טופס האתר" }],
};
const store = (rule: Record<string, unknown>) =>
  toDbRule(ruleSchema.parse({ name: "כלל", conditions: [], actions: [{ type: "notify", to: "owner", title: "x" }], ...rule }), lookups);

describe("AUT-03: a field changed", () => {
  it("offers the built-in fields and every active custom field; status and stage keep their own triggers", () => {
    const keys = watchChoices("lead", lookups).map((c) => c.key);
    expect(keys).toContain("owner_id");
    expect(keys).toContain("cf:level");
    expect(keys).toContain("cf:note");
    expect(keys).not.toContain("status_id");
    expect(watchChoices("deal", lookups).map((c) => c.key)).not.toContain("stage_id");
    expect(watchChoices("task", lookups)).toEqual([]);
    for (const entity of ["lead", "contact", "company", "deal"] as const) {
      expect(TRIGGERS.some((t) => t.entity === entity && t.anyField), entity).toBe(true);
    }
  });

  it("every built-in field is a column of its table (database.types.ts rows)", () => {
    const types = readFileSync("src/lib/database.types.ts", "utf8");
    const row = (name: string) => {
      const start = types.indexOf(`type ${name} = {`);
      return types.slice(start, types.indexOf("\n};", start));
    };
    const rows = { lead: row("LeadRow"), contact: row("ContactRow"), company: row("CompanyRow"), deal: row("DealRow") };
    for (const [entity, list] of Object.entries(WATCH_FIELDS)) {
      for (const f of list) expect(rows[entity as keyof typeof rows], `${entity}.${f.key}`).toMatch(new RegExp(`\\n\\s*${f.key}:`));
    }
  });

  it("offers a value only for fields with a closed list", () => {
    expect(watchValues("lead", "cf:level", lookups).map((c) => c.value)).toEqual(["חם", "קר"]);
    expect(watchValues("lead", "cf:vip", lookups).map((c) => c.value)).toEqual(["true", "false"]);
    expect(watchValues("lead", "owner_id", lookups).map((c) => c.value)).toEqual([OWNER]);
    expect(watchValues("lead", "preferred_channel", lookups).length).toBeGreaterThan(0);
    expect(watchValues("lead", "cf:note", lookups)).toEqual([]);
    expect(watchValues("lead", "email", lookups)).toEqual([]);
  });

  it("stores {field, to?} and reads it back; refuses an unknown field or value", () => {
    expect(store({ trigger: "lead:field", trigger_field: "cf:level", trigger_value: "חם" })).toMatchObject({
      entity_type: "lead",
      trigger_type: "field_changed",
      trigger_config: { field: "cf:level", to: "חם" },
    });
    expect(store({ trigger: "lead:field", trigger_field: "email" })).toMatchObject({ trigger_config: { field: "email" } });
    expect(store({ trigger: "lead:field" })).toBe("יש לבחור שדה.");
    expect(store({ trigger: "lead:field", trigger_field: "cf:gone" })).toBe("השדה שנבחר כבר לא קיים או מוסתר.");
    expect(store({ trigger: "lead:field", trigger_field: "cf:level", trigger_value: "פושר" })).toBe("הערך שנבחר בטריגר כבר לא קיים.");
    // a text field takes no value to wait for
    expect(store({ trigger: "lead:field", trigger_field: "cf:note", trigger_value: "x" })).toBe("הערך שנבחר בטריגר כבר לא קיים.");

    const back = fromDbRule({ name: "כלל", entity: "lead", triggerType: "field_changed", triggerConfig: { field: "cf:level", to: "חם" }, conditions: [], actions: [] });
    expect(back).toMatchObject({ trigger: "lead:field", triggerField: "cf:level", triggerValue: "חם", triggerTo: "" });
  });

  it("a stored status or stage rule still reads as its own trigger", () => {
    expect(triggerOf("lead", "field_changed", { field: "status_id" })?.key).toBe("lead:status");
    expect(triggerOf("deal", "field_changed", { field: "stage_id" })?.key).toBe("deal:stage");
    expect(triggerOf("deal", "field_changed", { field: "owner_id" })?.key).toBe("deal:field");
    expect(triggerOf("contact", "field_changed", { field: "city" })?.key).toBe("contact:field");
  });

  it("reads in Hebrew", () => {
    expect(describeFieldTrigger("lead", { field: "owner_id", to: OWNER }, lookups)).toBe('"אחראי" ל"דנה"');
    expect(describeFieldTrigger("lead", { field: "cf:gone" }, lookups)).toBe('"שדה שנמחק או הוסתר"');
    expect(describeRule({ entity: "lead", triggerType: "field_changed", triggerConfig: { field: "cf:level" }, conditions: [], actions: [] }, lookups).when).toBe(
      'שדה בליד השתנה: "שדה level"',
    );
  });
});

describe("AUT-03: form submitted", () => {
  it("on leads and contacts, any form or one", () => {
    expect(TRIGGERS.filter((t) => t.type === "form_submitted").map((t) => t.entity)).toEqual(["lead", "contact"]);
    expect(store({ trigger: "lead:form" })).toMatchObject({ trigger_type: "form_submitted", trigger_config: {} });
    expect(store({ trigger: "contact:form", trigger_form_id: FORM })).toMatchObject({ trigger_config: { form_id: FORM } });
    expect(store({ trigger: "lead:form", trigger_form_id: OWNER })).toBe("הטופס שנבחר כבר לא קיים.");
    expect(describeRule({ entity: "lead", triggerType: "form_submitted", triggerConfig: { form_id: FORM }, conditions: [], actions: [] }, lookups).when).toBe(
      "נשלח טופס (ליד): טופס האתר",
    );
    expect(fromDbRule({ name: "כלל", entity: "lead", triggerType: "form_submitted", triggerConfig: { form_id: FORM }, conditions: [], actions: [] })).toMatchObject({
      trigger: "lead:form",
      triggerFormId: FORM,
    });
  });
});

describe("AUT-03: fixed schedule", () => {
  it("daily or weekly at a quarter of an hour", () => {
    expect(scheduleTriggerConfig({ frequency: "daily", time: "09:30" })).toEqual({ frequency: "daily", time: "09:30" });
    expect(scheduleTriggerConfig({ frequency: "weekly", time: "08:00", days: [3, 0, 3] })).toEqual({ frequency: "weekly", time: "08:00", days: [0, 3] });
    expect(scheduleTriggerConfig({ frequency: "weekly", time: "08:00", days: [] })).toBe("יש לבחור לפחות יום אחד בשבוע.");
    expect(scheduleTriggerConfig({ frequency: "daily", time: "09:10" })).toBe("יש לבחור שעה (ברבעי שעה).");
    expect(scheduleTriggerConfig({ frequency: "daily", time: "24:00" })).toBe("יש לבחור שעה (ברבעי שעה).");
    expect(scheduleTriggerConfig({ time: "09:00" })).toBe("יש לבחור כל כמה זמן.");
  });

  it("stores, reads back and describes", () => {
    expect(store({ trigger: "task:schedule", trigger_frequency: "weekly", trigger_time: "07:45", trigger_weekdays: [1, 4] })).toMatchObject({
      entity_type: "task",
      trigger_type: "schedule",
      trigger_config: { frequency: "weekly", time: "07:45", days: [1, 4] },
    });
    expect(scheduleTriggerDraft({ frequency: "weekly", time: "07:45", days: [1, 4] })).toEqual({ frequency: "weekly", hour: "07", minute: "45", days: [1, 4] });
    expect(describeScheduleTrigger({ frequency: "daily", time: "09:00" })).toBe("כל יום ב-09:00");
    expect(describeScheduleTrigger({ frequency: "weekly", time: "08:30", days: [0, 3] })).toBe("בימים ראשון, רביעי ב-08:30");
    expect(describeScheduleTrigger({ frequency: "weekly", time: "08:30", days: [5] })).toBe("ביום שישי ב-08:30");
    expect(TRIGGERS.filter((t) => t.type === "schedule").map((t) => t.entity)).toEqual(["lead", "contact", "company", "deal", "task"]);
  });

  it("the weekdays are PostgreSQL's dow (0 = Sunday), as app.schedule_slot reads them", () => {
    expect(ENGINE).toContain("extract(dow from v_day)");
    expect(ENGINE).toContain("'^([01][0-9]|2[0-3]):[0-5][0-9]$'");
  });
});

describe("AUT-03: manual button", () => {
  it("on leads, contacts, companies and deals", () => {
    expect(TRIGGERS.filter((t) => t.type === "manual").map((t) => t.entity)).toEqual(["lead", "contact", "company", "deal"]);
    expect(isManualEntity("deal")).toBe(true);
    expect(isManualEntity("task")).toBe(false);
    expect(store({ trigger: "deal:manual" })).toMatchObject({ entity_type: "deal", trigger_type: "manual", trigger_config: {} });
  });

  it("reads the database's answers", () => {
    expect(manualRulesOf([{ id: "a", name: "שליחה" }, { id: 1 }, null])).toEqual([{ id: "a", name: "שליחה" }]);
    expect(manualRulesOf(null)).toEqual([]);
    expect(manualRunResult({ ok: true, status: "success" })).toEqual({ ok: true, message: "האוטומציה רצה: כל הפעולות בוצעו." });
    expect(manualRunResult({ ok: false, reason: "conditions" }).ok).toBe(false);
    expect(manualRunResult({ ok: false, reason: "limit" }).message).toContain("20");
    expect(manualRunResult({ ok: false, reason: "limit", detail: "daily" }).message).toContain("20");
    expect(manualRunResult({ ok: false, reason: "limit", detail: "quota" }).message).toContain("ההרצות החודשיות");
    expect(manualRunResult("x")).toEqual({ ok: false, message: "לא הצלחנו להפעיל את האוטומציה. נסו שוב." });
  });
});

describe("AUT-03: the engine knows every new type", () => {
  it("in the constraint, the outbox (form only), the matcher, the facts and the retry check", () => {
    const allowed = ENGINE.match(/automations_trigger_type_check check \(trigger_type = any \(array\[([^\]]*)\]/)![1];
    const outbox = ENGINE.match(/and a\.trigger_type in \(([^)]*)\)/)![1];
    for (const type of ["form_submitted", "schedule", "manual"]) {
      expect(allowed, type).toContain(`'${type}'`);
      expect(ENGINE, type).toMatch(new RegExp(`when '${type}' then`));
    }
    expect(outbox).toContain("'form_submitted'");
    expect(outbox).not.toContain("'schedule'");
    expect(outbox).not.toContain("'manual'");
    // the card's button is counted and stopped by AUT-07 (lead's decision): its key is not an admin's 'manual:' test run
    expect(ENGINE).toContain("'button:' || gen_random_uuid()");
    expect(ENGINE).not.toMatch(/execute_automation\(v_auto, p_record, 'manual:/);
  });
});
