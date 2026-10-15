import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { FieldDefinition } from "@/features/custom-fields/types";
import {
  SCORE_ACTIVITY_TYPES,
  SCORE_BUILT_IN,
  SUGGESTED_RULES,
  customFieldOps,
  describeRule,
  parseRule,
  pointsText,
  scoreFieldChoices,
  type RuleInput,
  type ScoreLookups,
} from "@/features/lead-score/rules";

// LEAD-05: the fields, operators and activity types mirror migration lead_score (the lead renumbers it at merge)
const dir = new URL("../../supabase/migrations/", import.meta.url);
const file = readdirSync(dir).find((name) => name.endsWith("_lead_score.sql"));
const sql = readFileSync(new URL(file ?? "missing", dir), "utf8");
const check = /create or replace function app\.lead_score_rule_check\(\)[\s\S]*?\n\$\$;/.exec(sql)?.[0] ?? "";

const field = (key: string, type: FieldDefinition["type"], options: string[] = []): FieldDefinition => ({
  id: key,
  key,
  label: key,
  type,
  options,
  isRequired: false,
  isActive: true,
  helpText: null,
});

const lookups: ScoreLookups = {
  statuses: [{ id: "11111111-1111-4111-8111-111111111111", name: "חדש" }],
  sources: [{ id: "22222222-2222-4222-8222-222222222222", name: "פייסבוק" }],
  tags: [{ id: "33333333-3333-4333-8333-333333333333", name: "חם" }],
  fields: [field("size", "select", ["קטן", "גדול"]), field("amount", "currency"), field("vip", "checkbox"), field("about", "text")],
};

const input = (over: Partial<RuleInput>): RuleInput => ({ field: "email", op: "filled", value: "", direction: "add", points: "10", ...over });

describe("lead score rules (LEAD-05)", () => {
  it("the activity types equal app.lead_score_activity_types()", () => {
    const array = /function app\.lead_score_activity_types\(\)[\s\S]*?array\[([^\]]*)\]/.exec(sql)?.[1] ?? "";
    const values = [...array.matchAll(/'([^']*)'/g)].map((m) => m[1]).sort();
    expect(values).toEqual(SCORE_ACTIVITY_TYPES.map((t) => t.value).sort());
  });

  it("the built-in fields and their operators equal the database check", () => {
    const keys = [...(/field ~ '\^\(([^)]*)\|cf:/.exec(sql)?.[1] ?? "").split("|")].sort();
    expect(keys).toEqual(SCORE_BUILT_IN.map((f) => f.key).sort());
    // each branch of the check: the keys it names and the operators it lets through
    const branch = (keys: string) => check.slice(check.indexOf(keys)).split(/\n  elsif |\n  end if;/)[0];
    const opsOf = (text: string) => [...new Set([...text.matchAll(/'(filled|empty|eq|neq|gte|lte)'/g)].map((m) => m[1]))].sort();
    expect(opsOf(branch("new.field in ('source', 'status', 'tag')"))).toEqual(["eq", "neq"]);
    expect(opsOf(branch("new.field in ('owner', 'email', 'phone', 'company', 'job_title', 'campaign', 'message', 'product', 'callback')"))).toEqual(["empty", "filled"]);
    expect(opsOf(branch("new.field = 'budget'"))).toEqual(["empty", "filled", "gte", "lte"]);
    for (const f of SCORE_BUILT_IN) {
      const expected = ["source", "status", "tag"].includes(f.key) ? ["eq", "neq"] : f.key === "budget" ? ["empty", "filled", "gte", "lte"] : ["empty", "filled"];
      expect([...f.ops].sort(), f.key).toEqual(expected);
    }
  });

  it("the suggested rules equal app.seed_lead_score_rules()", () => {
    const seed = /function app\.seed_lead_score_rules\([\s\S]*?\n\$\$;/.exec(sql)?.[0] ?? "";
    const rows = [...seed.matchAll(/\(p_org, '([^']+)', '([^']+)', (null|'[^']*'), (-?\d+), (\d+)\)/g)].map((m) => ({
      field: m[1],
      op: m[2],
      value: m[3] === "null" ? null : m[3].slice(1, -1),
      points: Number(m[4]),
      position: Number(m[5]),
    }));
    expect(rows.map((r) => r.position)).toEqual(rows.map((_, i) => i));
    expect(rows.map(({ field, op, value, points }) => ({ field, op, value, points }))).toEqual([...SUGGESTED_RULES]);
    // each one is a rule the form itself accepts
    for (const rule of SUGGESTED_RULES) {
      const parsed = parseRule({ field: rule.field, op: rule.op, value: rule.value ?? "", direction: "add", points: String(rule.points) }, lookups);
      expect(parsed, rule.field).toEqual({ ok: true, rule });
    }
  });

  it("custom field operators follow the type, as the database check does", () => {
    expect(customFieldOps("checkbox")).toEqual(["eq"]);
    expect(customFieldOps("select")).toEqual(["filled", "empty", "eq", "neq"]);
    expect(customFieldOps("currency")).toEqual(["filled", "empty", "gte", "lte"]);
    expect(customFieldOps("text")).toEqual(["filled", "empty"]);
  });

  it("parses a rule into what the table stores", () => {
    expect(parseRule(input({}), lookups)).toEqual({ ok: true, rule: { field: "email", op: "filled", value: null, points: 10 } });
    expect(parseRule(input({ field: "budget", op: "gte", value: "1,500", direction: "subtract", points: "5" }), lookups)).toEqual({
      ok: true,
      rule: { field: "budget", op: "gte", value: "150000", points: -5 },
    });
    expect(parseRule(input({ field: "activity:call", op: "gte", value: "2" }), lookups)).toEqual({ ok: true, rule: { field: "activity:call", op: "gte", value: "2", points: 10 } });
    expect(parseRule(input({ field: "cf:size", op: "eq", value: "גדול" }), lookups)).toMatchObject({ ok: true, rule: { value: "גדול" } });
    expect(parseRule(input({ field: "cf:amount", op: "lte", value: "10" }), lookups)).toMatchObject({ ok: true, rule: { value: "1000" } });
    expect(parseRule(input({ field: "cf:vip", op: "eq", value: "false" }), lookups)).toMatchObject({ ok: true, rule: { value: "false" } });
  });

  it("refuses what the database would refuse", () => {
    const refused = (over: Partial<RuleInput>) => parseRule(input(over), lookups).ok;
    expect(refused({ field: "full_name" })).toBe(false);
    expect(refused({ field: "source", op: "filled" })).toBe(false);
    expect(refused({ field: "source", op: "eq", value: "44444444-4444-4444-8444-444444444444" })).toBe(false);
    expect(refused({ field: "cf:size", op: "eq", value: "בינוני" })).toBe(false);
    expect(refused({ field: "cf:vip", op: "filled" })).toBe(false);
    expect(refused({ field: "cf:about", op: "gte", value: "3" })).toBe(false);
    expect(refused({ field: "activity:call", op: "gte", value: "0" })).toBe(false);
    expect(refused({ field: "activity:call", op: "gte", value: "101" })).toBe(false);
    expect(refused({ field: "budget", op: "gte", value: "" })).toBe(false);
    expect(refused({ points: "0" })).toBe(false);
    expect(refused({ points: "101" })).toBe(false);
    expect(refused({ points: "-5" })).toBe(false);
    expect(refused({ direction: "x" })).toBe(false);
  });

  it("describes a rule in Hebrew, and marks one whose field or value is gone", () => {
    expect(describeRule({ field: "source", op: "eq", value: lookups.sources[0].id }, lookups)).toEqual({ text: 'מקור הוא "פייסבוק"', known: true });
    expect(describeRule({ field: "tag", op: "neq", value: lookups.tags[0].id }, lookups)).toEqual({ text: 'אין את התגית "חם"', known: true });
    expect(describeRule({ field: "activity:call", op: "gte", value: "1" }, lookups).text).toBe("לפחות שיחה אחת בציר הזמן");
    expect(describeRule({ field: "activity:meeting", op: "gte", value: "3" }, lookups).text).toBe("לפחות 3 פגישות בציר הזמן");
    expect(describeRule({ field: "email", op: "filled", value: null }, lookups).text).toBe("אימייל: מלא");
    expect(describeRule({ field: "callback", op: "filled", value: null }, lookups)).toEqual({ text: "ביקשו בטופס שנחזור אליהם", known: true });
    expect(describeRule({ field: "callback", op: "empty", value: null }, lookups).text).toBe("לא ביקשו בטופס שנחזור אליהם");
    expect(describeRule({ field: "cf:gone", op: "filled", value: null }, lookups).known).toBe(false);
    expect(describeRule({ field: "source", op: "eq", value: "44444444-4444-4444-8444-444444444444" }, lookups).known).toBe(false);
    expect(pointsText(10)).toBe("+10");
    expect(pointsText(-5)).toBe("−5");
  });

  it("offers every field, the active custom fields and the activity types", () => {
    const keys = scoreFieldChoices(lookups).map((c) => c.key);
    expect(keys).toContain("cf:size");
    expect(keys.filter((k) => k.startsWith("activity:"))).toHaveLength(SCORE_ACTIVITY_TYPES.length);
    const hidden = scoreFieldChoices({ ...lookups, fields: [{ ...field("old", "text"), isActive: false }] }).map((c) => c.key);
    expect(hidden).not.toContain("cf:old");
  });
});
