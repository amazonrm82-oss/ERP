import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { conditionTreeMatch, type ConditionContext, type ConditionRecords } from "@/features/automations/condition-match";
import { fitConditions, LINKS_FOR } from "@/features/automations/conditions";
import { fromDbRule, toDbRule } from "@/features/automations/convert";
import { CONDITIONS } from "@/features/automations/definitions";
import { describeRule } from "@/features/automations/describe";
import type { Lookups } from "@/features/automations/queries";
import { CONDITION_NUMBER, ruleSchema } from "@/features/automations/schema";

// AUT-05: the TS mirror of app.automation_condition_tree runs the shared cases; the database test runs the same file.

type Case = { name: string; conditions: unknown; records: ConditionRecords; ctx: ConditionContext; expected: boolean | "error" };
const CASES = JSON.parse(readFileSync("tests/unit/fixtures/automation-conditions.json", "utf8")) as Case[];

describe("automation conditions, the TS mirror (AUT-05)", () => {
  it("has the shared cases", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(40);
    expect(new Set(CASES.map((c) => c.name)).size).toBe(CASES.length);
  });

  for (const c of CASES) {
    it(c.name, () => {
      if (c.expected === "error") {
        expect(() => conditionTreeMatch(c.conditions, c.records, c.ctx)).toThrow();
      } else {
        expect(conditionTreeMatch(c.conditions, c.records, c.ctx)).toBe(c.expected);
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The builder side: groups, linked records and time conditions, stored and read back, in Hebrew
// ---------------------------------------------------------------------------------------------------------------------

const lookups: Lookups = {
  statuses: [{ id: "00000000-0000-4000-8000-000000000010", name: "חדש", kind: "open" }] as Lookups["statuses"],
  sources: [{ id: "00000000-0000-4000-8000-000000000020", name: "פייסבוק" }] as Lookups["sources"],
  tags: [{ id: "00000000-0000-4000-8000-000000000030", name: "VIP" }] as Lookups["tags"],
  pipelines: [{ id: "00000000-0000-4000-8000-000000000040", name: "מכירות", stages: [] }] as unknown as Lookups["pipelines"],
  members: [],
  teams: [],
  reasons: [],
  fields: {},
};
const VIP = "00000000-0000-4000-8000-000000000030";
const FB = "00000000-0000-4000-8000-000000000020";
const PIPE = "00000000-0000-4000-8000-000000000040";

const parseRule = (trigger: string, conditions: unknown[]) =>
  ruleSchema.safeParse({ name: "כלל", trigger, conditions, actions: [{ type: "notify", to: "owner", title: "x" }] });
const storeRule = (trigger: string, conditions: unknown[]) => {
  const parsed = parseRule(trigger, conditions);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  return toDbRule(parsed.data, lookups);
};

describe("automation conditions in the builder (AUT-05)", () => {
  it("stores old conditions as before, and groups, links and time conditions in the engine's shape", () => {
    expect(storeRule("lead:created", [{ key: "source", value: FB }])).toMatchObject({ conditions: [{ field: "source_id", op: "eq", value: FB }] });
    expect(storeRule("lead:created", [{ key: "no_owner" }])).toMatchObject({ conditions: [{ field: "owner_id", op: "empty" }] });
    const db = storeRule("deal:created", [
      { any: [{ key: "tag", value: VIP, on: "contact" }, { key: "amount", value: "1,000" }] },
      { key: "hours", value: "out" },
      { key: "weekday", value: "4,0,4" },
    ]);
    expect(db).toMatchObject({
      conditions: [
        { any: [{ on: "contact", field: "tag_ids", op: "has_tag", value: VIP }, { field: "amount_agorot", op: "gte", value: "100000" }] },
        { kind: "hours", value: "out" },
        { kind: "weekday", days: [0, 4] },
      ],
    });
    // and back to the builder
    if (typeof db === "string") throw new Error(db);
    expect(fromDbRule({ name: "כלל", entity: "deal", triggerType: "created", triggerConfig: {}, conditions: db.conditions, actions: [] })?.conditions).toEqual([
      { any: [{ key: "tag", value: VIP, on: "contact" }, { key: "amount", value: "1000" }] },
      { key: "hours", value: "out" },
      { key: "weekday", value: "0,4" },
    ]);
  });

  it("every stored shape the builder makes is a case the shared rule judges (a field condition on a linked record)", () => {
    const db = storeRule("task:created", [{ key: "pipeline", value: PIPE, on: "deal" }]);
    if (typeof db === "string") throw new Error(db);
    expect(conditionTreeMatch(db.conditions, { self: {}, deal: { pipeline_id: PIPE } }, {})).toBe(true);
    expect(conditionTreeMatch(db.conditions, { self: {} }, {})).toBe(false);
  });

  it("refuses a link the record type does not have, a condition that does not fit the linked record, and empty values", () => {
    expect(storeRule("lead:created", [{ key: "tag", value: VIP, on: "contact" }])).toBe("הרשומה המקושרת לא מתאימה לסוג הרשומה.");
    // a task type condition on a linked contact
    expect(storeRule("deal:created", [{ key: "task_type", value: "call", on: "contact" }])).toBe("אחד התנאים לא מתאים לסוג הרשומה.");
    expect(storeRule("lead:created", [{ key: "weekday", value: "9" }])).toBe("יש לבחור לפחות יום אחד.");
    expect(storeRule("lead:created", [{ key: "hours", value: "in", on: "contact" }])).toBe("תנאי הזמן חל על הרשומה עצמה.");
    expect(parseRule("lead:created", [{ key: "weekday" }]).success).toBe(false);
    expect(parseRule("lead:created", [{ any: [{ key: "no_owner" }] }]).success).toBe(false);
    expect(parseRule("lead:created", [{ key: "moon", value: "x" }]).success).toBe(false);
    // a number comparison needs a number, as the database checks it (review low 1)
    expect(parseRule("deal:created", [{ key: "amount", value: "abc" }]).success).toBe(false);
    expect(parseRule("deal:created", [{ key: "amount", value: "1.2.3" }]).success).toBe(false);
    expect(parseRule("deal:created", [{ key: "amount", value: "₪ 1,000.50" }]).success).toBe(true);
    expect(CONDITION_NUMBER.test("-12.5")).toBe(true);
  });

  it("limits: 10 conditions, 10 in a group, 20 in all", () => {
    const leaf = { key: "no_owner" };
    expect(parseRule("lead:created", Array(10).fill(leaf)).success).toBe(true);
    expect(parseRule("lead:created", Array(11).fill(leaf)).success).toBe(false);
    expect(parseRule("lead:created", [{ any: Array(11).fill(leaf) }]).success).toBe(false);
    expect(parseRule("lead:created", [{ any: Array(10).fill(leaf) }, { any: Array(10).fill(leaf) }]).success).toBe(true);
    expect(parseRule("lead:created", [{ any: Array(10).fill(leaf) }, { any: Array(10).fill(leaf) }, leaf]).success).toBe(false);
  });

  it("reads in Hebrew", () => {
    const describe_ = (conditions: Array<Record<string, unknown>>) =>
      describeRule({ entity: "deal", triggerType: "created", triggerConfig: {}, conditions, actions: [] }, lookups).conditions;
    expect(describe_([{ field: "owner_id", op: "empty" }])).toEqual(["אין אחראי"]);
    expect(
      describe_([
        { any: [{ on: "contact", field: "tag_ids", op: "has_tag", value: VIP }, { field: "source_id", op: "eq", value: FB }] },
        { kind: "hours", value: "in" },
        { kind: "weekday", days: [0, 1] },
        { kind: "weekday", days: [5] },
      ]),
    ).toEqual(["אחד מאלה: איש הקשר: יש תגית VIP או המקור הוא פייסבוק", "בשעות העבודה של האחראי", "בימים א׳, ב׳", "ביום ו׳"]);
  });

  it("a trigger of another record type keeps only the conditions that still fit", () => {
    expect(
      fitConditions(
        [{ any: [{ key: "tag", value: VIP, on: "contact" }, { key: "no_owner", value: "" }] }, { key: "hours", value: "in" }, { key: "pipeline", value: PIPE }],
        "contact",
      ),
    ).toEqual([{ key: "no_owner", value: "" }, { key: "hours", value: "in" }]);
  });

  it("the links offered per record type are columns the engine reads (<link>_id)", () => {
    expect(LINKS_FOR).toEqual({ lead: [], contact: ["company"], company: [], deal: ["contact", "company"], task: ["lead", "contact", "company", "deal"] });
    // every field condition is a field name and an operator the engine knows
    for (const c of CONDITIONS) {
      expect(c.field).toMatch(/^[a-z_]{1,40}$/);
      expect(["eq", "neq", "empty", "not_empty", "gte", "lte", "has_tag"]).toContain(c.op);
    }
  });
});
