import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CONTACT_LOCALES } from "@/features/contacts/preferences";
import { parseDistributionForm, ruleSchema, WEIGHT_PREFIX } from "@/features/lead-distribution/schema";
import {
  DEFAULT_DISTRIBUTION,
  DISTRIBUTION_FEATURE,
  DISTRIBUTION_METHODS,
  distributionSettingsFrom,
  effectiveMethod,
  ruleConditionText,
  ruleTargetText,
  RULES_MAX,
  takesLeads,
  WEIGHT_MAX,
  WEIGHT_MIN,
  weightOf,
  weightsToSave,
} from "@/features/lead-distribution/settings";

const dir = join(process.cwd(), "supabase/migrations");
const migration = readdirSync(dir)
  .filter((f) => f.endsWith("_lead_distribution.sql"))
  .map((f) => readFileSync(join(dir, f), "utf8"))[0];

const migration2 = readdirSync(dir)
  .filter((f) => f.endsWith("_lead_distribution_rules_more.sql"))
  .map((f) => readFileSync(join(dir, f), "utf8"))[0];

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

/** CAP-08: the screen's rules are the table's. */
describe("lead distribution settings", () => {
  it("the methods, the weight range, the rule cap and the plan key are the migration's", () => {
    const methods = migration.match(/lead_distribution_settings_method_check check \(method in \(([^)]*)\)\)/)?.[1] ?? "";
    expect([...methods.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual([...DISTRIBUTION_METHODS]);
    const range = Array.from({ length: WEIGHT_MAX - WEIGHT_MIN + 1 }, (_, i) => WEIGHT_MIN + i).join(", ");
    expect(migration).toContain(`not in (${range})`);
    expect(migration).toContain(`in (${range})`);
    expect(migration).toContain(`>= ${RULES_MAX} then`);
    expect(migration).toContain(`'${DISTRIBUTION_FEATURE}'`);
  });

  it("reads a row: unknown values fall back, a missing weight is 1", () => {
    expect(distributionSettingsFrom(null)).toEqual(DEFAULT_DISTRIBUTION);
    const s = distributionSettingsFrom({ method: "weighted", weights: { [A]: 3, [B]: 11, x: "2" } });
    expect(s).toEqual({ method: "weighted", weights: { [A]: 3 } });
    expect(distributionSettingsFrom({ method: "random", weights: [] }).method).toBe("round_robin");
    expect(weightOf(s.weights, A)).toBe(3);
    expect(weightOf(s.weights, B)).toBe(1);
    // weight 1 is the default and is not stored
    expect(weightsToSave([[A, 1], [B, 4]])).toEqual({ [B]: 4 });
  });

  it("without the plan key the distribution is the plain round robin", () => {
    expect(effectiveMethod("load", false)).toBe("round_robin");
    expect(effectiveMethod("load", true)).toBe("load");
  });

  it("parses the form: the method and every weight field, in range", () => {
    const form = new FormData();
    form.set("method", "load");
    form.set(`${WEIGHT_PREFIX}${A}`, "2");
    form.set(`${WEIGHT_PREFIX}${B}`, "1");
    form.set(`${WEIGHT_PREFIX}not-an-id`, "5");
    expect(parseDistributionForm(form)).toEqual({ ok: true, method: "load", weights: [[A, 2], [B, 1]] });
    form.set(`${WEIGHT_PREFIX}${A}`, "0");
    form.set("method", "fast");
    const bad = parseDistributionForm(form);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.fieldErrors).sort()).toEqual(["method", `${WEIGHT_PREFIX}${A}`]);
    form.set(`${WEIGHT_PREFIX}${A}`, "2.5");
    form.set("method", "weighted");
    expect(parseDistributionForm(form).ok).toBe(false);
  });

  it("a rule needs a condition (source, product, language or list field) and a team or one person", () => {
    const team = `team:${B}`;
    expect(ruleSchema.safeParse({ source_id: "", product_id: "", locale: "", field: "", target: team }).success).toBe(false);
    expect(ruleSchema.safeParse({ source_id: A, product_id: "", locale: "", field: "", target: "" }).success).toBe(false);
    expect(ruleSchema.safeParse({ source_id: A, product_id: "", locale: "", field: "", target: `group:${B}` }).success).toBe(false);
    expect(ruleSchema.safeParse({ source_id: A, product_id: "", locale: "", field: "", target: team }).data).toEqual({
      source_id: A, product_id: null, locale: null, field_key: null, field_value: null, team_id: B, user_id: null,
    });
    expect(ruleSchema.safeParse({ source_id: "", product_id: "", locale: "ar", field: "area|צפון", target: `user:${A}` }).data).toEqual({
      source_id: null, product_id: null, locale: "ar", field_key: "area", field_value: "צפון", team_id: null, user_id: A,
    });
    expect(ruleSchema.safeParse({ source_id: "", product_id: "", locale: "xx", field: "", target: team }).success).toBe(false);
    expect(ruleSchema.safeParse({ source_id: "", product_id: "", locale: "", field: "Area|x", target: team }).success).toBe(false);
    expect(ruleSchema.safeParse({ source_id: "", product_id: "", locale: "", field: "area|", target: team }).success).toBe(false);
  });

  it("the rule's language list and the leads' are the contacts' codes", () => {
    const leads = migration2.match(/leads_preferred_locale_check\s+check \(preferred_locale in \(([^)]*)\)\)/)?.[1] ?? "";
    const rules = migration2.match(/lead_routing_rules_locale_check\s+check \(locale in \(([^)]*)\)\)/)?.[1] ?? "";
    for (const list of [leads, rules]) expect([...list.matchAll(/'([a-z]+)'/g)].map((m) => m[1])).toEqual([...CONTACT_LOCALES]);
    expect(migration2).toContain(`v_locale text := case when p_payload ->> 'preferred_locale' in (${CONTACT_LOCALES.map((c) => `'${c}'`).join(", ")})`);
  });

  it("describes a rule and who takes leads", () => {
    expect(ruleConditionText({ sourceId: A, productId: null }, { source: "פייסבוק" })).toBe('ליד מהמקור "פייסבוק"');
    expect(ruleConditionText({ sourceId: A, productId: B }, { source: "פייסבוק", product: "מנוי" })).toBe('ליד מהמקור "פייסבוק" ושמבקש את המוצר "מנוי"');
    expect(ruleConditionText({ sourceId: null, productId: B })).toBe('ליד שמבקש את המוצר "שנמחק"');
    expect(ruleConditionText({ sourceId: null, productId: null, locale: "ar", fieldKey: "area", fieldValue: "צפון" }, { field: "אזור" })).toBe(
      'ליד שמעדיף ערבית ושב"אזור" נבחר "צפון"',
    );
    expect(ruleTargetText({ teamId: A, userId: null }, { team: "צפון" })).toBe('נכנס לצוות "צפון"');
    expect(ruleTargetText({ teamId: null, userId: A }, { user: "דנה" })).toBe("הולך לדנה");
    expect(takesLeads({ role: "member", seatType: "full", status: "active" })).toBe(true);
    expect(takesLeads({ role: "viewer", seatType: "full", status: "active" })).toBe(false);
    expect(takesLeads({ role: "member", seatType: "view", status: "active" })).toBe(false);
    expect(takesLeads({ role: "member", seatType: "full", status: "suspended" })).toBe(false);
  });
});
