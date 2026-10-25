import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { toDbRule } from "@/features/automations/convert";
import { FEATURE_MISSING, TRIGGERS, triggerFeature, triggerOffered, type TriggerType } from "@/features/automations/definitions";
import { describeRule, retryLine } from "@/features/automations/describe";
import type { Lookups } from "@/features/automations/queries";
import { ruleSchema } from "@/features/automations/schema";

// AUT-04: the commercial triggers in the builder: offered and saved only with their plan flag, the same flags as the
// engine's app.automation_trigger_feature, every type allowed by the constraint and offered by the outbox.

const ENGINE = readFileSync(
  `supabase/migrations/${readdirSync("supabase/migrations").find((file) => file.endsWith("_commercial_triggers.sql"))}`,
  "utf8",
);

const lookups: Lookups = { statuses: [], sources: [], tags: [], pipelines: [], members: [], teams: [], reasons: [], fields: {}, payments: true, quotes: true, documents: true };
const store = (trigger: string, with_: Lookups = lookups) =>
  toDbRule(ruleSchema.parse({ name: "כלל", trigger, conditions: [], actions: [{ type: "notify", to: "owner", title: "x" }] }), with_);

const NEW_TYPES: TriggerType[] = [
  "quote_viewed",
  "quote_accepted",
  "quote_declined",
  "quote_expired",
  "document_recorded",
  "meeting_scheduled",
  "meeting_cancelled",
  "meeting_no_show",
];

describe("commercial triggers (AUT-04)", () => {
  it("the builder's flags are the engine's (app.automation_trigger_feature)", () => {
    const body = ENGINE.slice(ENGINE.indexOf("function app.automation_trigger_feature"));
    const sql = new Map<string, string>();
    for (const m of body.slice(0, body.indexOf("$$;", body.indexOf("$$") + 2)).matchAll(/when p_trigger (?:in \(([^)]*)\)|= ('[a-z_]+')) then '([a-z]+)'/g)) {
      for (const t of (m[1] ?? m[2]).matchAll(/'([a-z_]+)'/g)) sql.set(t[1], m[3]);
    }
    const types = [...new Set(TRIGGERS.map((t) => t.type))];
    for (const type of types) expect(triggerFeature(type) ?? undefined, type).toBe(sql.get(type));
  });

  it("every new type is in the constraint and offered by the outbox", () => {
    const allowed = ENGINE.match(/automations_trigger_type_check check \(trigger_type = any \(array\[([^\]]*)\]/)![1];
    const outbox = ENGINE.match(/and a\.trigger_type in \(([^)]*)\)/)![1];
    for (const type of NEW_TYPES) {
      expect(allowed, type).toContain(`'${type}'`);
      expect(outbox, type).toContain(`'${type}'`);
    }
    for (const trigger of TRIGGERS) expect(allowed, trigger.key).toContain(`'${trigger.type}'`);
  });

  it("quote triggers on deals and contacts, documents on deals and contacts, meetings on every linked record type", () => {
    const entities = (type: TriggerType) => TRIGGERS.filter((t) => t.type === type).map((t) => t.entity);
    for (const type of ["quote_viewed", "quote_accepted", "quote_declined", "quote_expired", "document_recorded"] as TriggerType[]) {
      expect(entities(type), type).toEqual(["deal", "contact"]);
    }
    for (const type of ["meeting_scheduled", "meeting_cancelled", "meeting_no_show"] as TriggerType[]) {
      expect(entities(type), type).toEqual(["lead", "contact", "company", "deal"]);
    }
  });

  it("is offered and saved only with its flag; a saved rule keeps its own; meetings are core", () => {
    const accepted = TRIGGERS.find((t) => t.key === "deal:quote_accepted")!;
    const doc = TRIGGERS.find((t) => t.key === "contact:document")!;
    const meeting = TRIGGERS.find((t) => t.key === "lead:meeting_no_show")!;
    expect(triggerOffered(accepted, { quotes: false })).toBe(false);
    expect(triggerOffered(accepted, { quotes: false }, "deal:quote_accepted")).toBe(true);
    expect(triggerOffered(doc, { documents: true })).toBe(true);
    expect(triggerOffered(meeting, {})).toBe(true);
    expect(store("deal:quote_accepted", { ...lookups, quotes: false })).toBe(FEATURE_MISSING.quotes);
    expect(store("contact:document", { ...lookups, documents: false })).toBe(FEATURE_MISSING.documents);
    expect(store("lead:meeting_scheduled", { ...lookups, quotes: false, documents: false, payments: false })).toMatchObject({
      entity_type: "lead",
      trigger_type: "meeting_scheduled",
      trigger_config: {},
    });
    expect(store("contact:quote_expired")).toMatchObject({ entity_type: "contact", trigger_type: "quote_expired" });
    // owner's answer 4 ב: "quote accepted" takes a minimum in shekels before VAT, stored in agorot; only that quote trigger
    const withMin = toDbRule(ruleSchema.parse({ name: "כלל", trigger: "deal:quote_accepted", trigger_min: "1,000", conditions: [], actions: [{ type: "notify", to: "owner", title: "x" }] }), lookups);
    expect(withMin).toMatchObject({ trigger_type: "quote_accepted", trigger_config: { min_agorot: 100000 } });
    expect(TRIGGERS.filter((t) => t.type.startsWith("quote_") && t.minAmount).map((t) => t.key)).toEqual(["deal:quote_accepted", "contact:quote_accepted"]);
  });

  it("reads in Hebrew", () => {
    const when = (entity: string, triggerType: string) => describeRule({ entity, triggerType, triggerConfig: {}, conditions: [], actions: [] }, lookups).when;
    expect(when("deal", "quote_viewed")).toBe("הצעת מחיר בעסקה נצפתה");
    expect(describeRule({ entity: "contact", triggerType: "quote_accepted", triggerConfig: { min_agorot: 100000 }, conditions: [], actions: [] }, lookups).when).toBe(
      "הצעת מחיר לאיש קשר אושרה (לפחות ₪1,000 לפני מע״מ)",
    );
    expect(when("contact", "document_recorded")).toBe("נרשם מסמך לאיש קשר");
    expect(when("lead", "meeting_no_show")).toBe("הליד לא הגיע לפגישה");
    expect(new Set(TRIGGERS.map((t) => t.label)).size).toBe(TRIGGERS.length);
  });

  it("a retry of a rule whose plan flag is gone ends with \"לא רץ: לא כלול בתוכנית\"", () => {
    expect(ENGINE).toContain("retry_note = 'feature_off'");
    expect(ENGINE).toMatch(/retry_note in \([^)]*'feature_off'\)/);
    expect(retryLine({ retryCount: 0, nextRetryAt: null, retryNote: "feature_off" }, null)).toBe("לא רץ: לא כלול בתוכנית");
  });
});
