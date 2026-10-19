import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { fromDbRule, toDbRule } from "@/features/automations/convert";
import { createDealDraft, describeCreateDeal, openStagesOf, shekelsToAgorot } from "@/features/automations/create-records";
import { actionsFor } from "@/features/automations/definitions";
import { describeRule, STEP_ERRORS, STEP_WARNINGS } from "@/features/automations/describe";
import type { Lookups } from "@/features/automations/queries";
import { ruleSchema } from "@/features/automations/schema";

// AUT-02: the "create deal" and "create note" steps: builder values -> stored rule -> builder values, and the texts.

const PIPELINE = "11111111-1111-4111-8111-111111111111";
const OPEN = "22222222-2222-4222-8222-222222222222";
const OPEN2 = "33333333-3333-4333-8333-333333333333";
const WON = "44444444-4444-4444-8444-444444444444";
const MEMBER = "55555555-5555-4555-8555-555555555555";

const lookups: Lookups = {
  statuses: [],
  sources: [],
  tags: [],
  pipelines: [
    {
      id: PIPELINE,
      name: "מכירות",
      stages: [
        { id: OPEN, name: "חדש", kind: "open" },
        { id: OPEN2, name: "הצעה", kind: "open" },
        { id: WON, name: "נסגר", kind: "won" },
      ],
    },
  ],
  members: [{ id: MEMBER, name: "דנה" }],
  teams: [],
  reasons: [],
  fields: {},
};

// found by its name, so renumbering the migration at merge keeps the test
const ENGINE = readFileSync(
  `supabase/migrations/${readdirSync("supabase/migrations").find((file) => file.endsWith("_automation_create_records.sql"))}`,
  "utf8",
);

const parse = (trigger: string, actions: Array<Record<string, string>>) => ruleSchema.parse({ name: "כלל", trigger, conditions: [], actions });

describe("create deal and create note steps (AUT-02)", () => {
  it("are offered on every record type, except a deal from a lead (a lead becomes a deal by conversion)", () => {
    expect(actionsFor("lead")).toContain("create_note");
    expect(actionsFor("lead")).not.toContain("create_deal");
    for (const entity of ["contact", "company", "deal", "task"] as const) {
      expect(actionsFor(entity)).toEqual(expect.arrayContaining(["create_deal", "create_note"]));
    }
  });

  it("stores a deal step with only what was chosen, and reads it back", () => {
    const rule = parse("deal:won", [
      { type: "create_deal", name: " חידוש: {{name}} ", pipeline_id: PIPELINE, stage_id: OPEN2, amount: "2,500.5", assign: "user", user_id: MEMBER },
      { type: "create_deal", pipeline_id: PIPELINE },
    ]);
    const db = toDbRule(rule, lookups);
    if (typeof db === "string") throw new Error(db);
    expect(db.actions).toEqual([
      { type: "create_deal", pipeline_id: PIPELINE, assign: "user", name: "חידוש: {{name}}", stage_id: OPEN2, amount_agorot: 250050, user_id: MEMBER },
      { type: "create_deal", pipeline_id: PIPELINE, assign: "owner" },
    ]);
    const back = fromDbRule({ name: "כלל", entity: "deal", triggerType: "deal_won", triggerConfig: {}, conditions: [], actions: db.actions });
    expect(back?.actions).toEqual([
      { type: "create_deal", name: "חידוש: {{name}}", pipeline_id: PIPELINE, stage_id: OPEN2, amount: "2500.5", assign: "user", user_id: MEMBER, pipeline_source: "", copy_source: "" },
      { type: "create_deal", name: "", pipeline_id: PIPELINE, stage_id: "", amount: "", assign: "owner", user_id: "", pipeline_source: "", copy_source: "" },
    ]);
  });

  it("refuses a lead trigger, a gone pipeline, a stage that is not open, a bad amount and a gone person", () => {
    const deal = (extra: Record<string, string>, trigger = "contact:created") =>
      toDbRule(parse(trigger, [{ type: "create_deal", pipeline_id: PIPELINE, ...extra }]), lookups);
    expect(deal({}, "lead:created")).toMatch(/בהמרה/);
    expect(deal({ pipeline_id: MEMBER })).toBe("תהליך המכירה שנבחר כבר לא קיים.");
    expect(deal({ stage_id: WON })).toBe("השלב שנבחר אינו שלב פתוח בתהליך המכירה.");
    expect(deal({ amount: "-5" })).toMatch(/סכום תקין/);
    expect(deal({ amount: "1.234" })).toMatch(/סכום תקין/);
    expect(deal({ amount: "1000000001" })).toMatch(/סכום תקין/);
    expect(deal({ assign: "user", user_id: PIPELINE })).toBe("המשתמש שנבחר כבר לא פעיל.");
    // a chosen person is required when the deal goes to a person
    expect(ruleSchema.safeParse({ name: "כלל", trigger: "contact:created", conditions: [], actions: [{ type: "create_deal", pipeline_id: PIPELINE, assign: "user" }] }).success).toBe(false);
  });

  it("stores a note step, which needs text", () => {
    const db = toDbRule(parse("lead:created", [{ type: "create_note", body: " נכנס {{name}} " }]), lookups);
    if (typeof db === "string") throw new Error(db);
    expect(db.actions).toEqual([{ type: "create_note", body: "נכנס {{name}}" }]);
    expect(fromDbRule({ name: "כלל", entity: "lead", triggerType: "created", triggerConfig: {}, conditions: [], actions: db.actions })?.actions).toEqual([
      { type: "create_note", body: "נכנס {{name}}" },
    ]);
    expect(ruleSchema.safeParse({ name: "כלל", trigger: "lead:created", conditions: [], actions: [{ type: "create_note", body: "   " }] }).success).toBe(false);
    expect(ruleSchema.safeParse({ name: "כלל", trigger: "lead:created", conditions: [], actions: [{ type: "create_note", body: "א".repeat(2001) }] }).success).toBe(false);
  });

  it("says the steps in Hebrew, and every engine error of the steps has a Hebrew text", () => {
    const text = describeRule(
      {
        entity: "deal",
        triggerType: "deal_won",
        triggerConfig: {},
        conditions: [],
        actions: [
          { type: "create_deal", pipeline_id: PIPELINE, stage_id: OPEN2, amount_agorot: 100000, assign: "user", user_id: MEMBER },
          { type: "create_deal", pipeline_id: PIPELINE, assign: "owner" },
          { type: "create_note", body: "נסגר" },
        ],
      },
      lookups,
    ).actions;
    expect(text).toEqual([
      `יצירת עסקה: "עסקה: {{name}}", בתהליך מכירות, בשלב הצעה, ₪${(1000).toLocaleString("he-IL")}, לדנה`,
      'יצירת עסקה: "עסקה: {{name}}", בתהליך מכירות, בשלב הפתוח הראשון, לאחראי',
      'הוספת הערה: "נסגר"',
    ]);
    expect(describeCreateDeal({ pipeline_id: "gone", assign: "owner" }, lookups)).toContain("בתהליך (נמחק)");
    for (const error of [
      "a lead becomes a deal by conversion",
      "the pipeline no longer exists",
      "the stage is not an open stage of the pipeline",
      "the pipeline has no open stage",
      "the amount is invalid",
      "the plan record limit is reached",
      "the user is not an active member",
      "the note is empty",
      "the task is not linked to a record",
    ]) {
      expect(STEP_ERRORS[error], error).toBeTruthy();
      // the engine raises exactly this text
      expect(ENGINE, error).toContain(`raise exception '${error.replaceAll("'", "''")}'`);
    }
  });

  it("helpers: open stages only, shekels to agorot", () => {
    expect(openStagesOf(lookups.pipelines, PIPELINE).map((s) => s.id)).toEqual([OPEN, OPEN2]);
    expect(openStagesOf(lookups.pipelines, "x")).toEqual([]);
    expect(shekelsToAgorot("")).toBe(0);
    expect(shekelsToAgorot("₪ 1,000")).toBe(100000);
    expect(shekelsToAgorot("0.05")).toBe(5);
    expect(shekelsToAgorot("1000000000")).toBe(100_000_000_000);
    expect(shekelsToAgorot("abc")).toBeNull();
    expect(createDealDraft({ type: "create_deal", pipeline_id: PIPELINE, amount_agorot: 0 }).amount).toBe("");
  });
});

// DEAL-08 follow-up (migration automation_deal_from_source): a new deal in the source deal's process, with its revenue and lines
const FOLLOW = readFileSync(
  `supabase/migrations/${readdirSync("supabase/migrations").find((file) => file.endsWith("_automation_deal_from_source.sql"))}`,
  "utf8",
);

describe("a create deal step that follows its source deal (DEAL-08 follow-up)", () => {
  it("stores both settings for a deal rule, keeps the fallback pipeline, and reads them back", () => {
    const rule = parse("deal:won", [{ type: "create_deal", pipeline_id: PIPELINE, stage_id: OPEN2, pipeline_source: "1", copy_source: "1" }]);
    const db = toDbRule(rule, lookups);
    if (typeof db === "string") throw new Error(db);
    expect(db.actions).toEqual([
      { type: "create_deal", pipeline_id: PIPELINE, assign: "owner", pipeline: "source", copy_from_source: true, stage_id: OPEN2 },
    ]);
    const back = fromDbRule({ name: "כלל", entity: "deal", triggerType: "deal_won", triggerConfig: {}, conditions: [], actions: db.actions });
    expect(back?.actions[0]).toMatchObject({ pipeline_source: "1", copy_source: "1", pipeline_id: PIPELINE, stage_id: OPEN2 });
    // unticked: nothing stored
    const plain = toDbRule(parse("deal:won", [{ type: "create_deal", pipeline_id: PIPELINE, pipeline_source: "", copy_source: "" }]), lookups);
    if (typeof plain === "string") throw new Error(plain);
    expect(plain.actions).toEqual([{ type: "create_deal", pipeline_id: PIPELINE, assign: "owner" }]);
  });

  it("refuses both settings outside deal rules, a gone fallback pipeline, and other values", () => {
    for (const extra of [{ pipeline_source: "1" }, { copy_source: "1" }] as Array<Record<string, string>>) {
      expect(toDbRule(parse("contact:created", [{ type: "create_deal", pipeline_id: PIPELINE, ...extra }]), lookups)).toBe(
        "העתקה מהעסקה המקורית מתאימה רק לאוטומציה על עסקאות.",
      );
    }
    expect(toDbRule(parse("deal:won", [{ type: "create_deal", pipeline_id: MEMBER, pipeline_source: "1" }]), lookups)).toBe("תהליך המכירה שנבחר כבר לא קיים.");
    expect(ruleSchema.safeParse({ name: "כלל", trigger: "deal:won", conditions: [], actions: [{ type: "create_deal", pipeline_id: PIPELINE, copy_source: "yes" }] }).success).toBe(false);
  });

  it("says the settings in Hebrew, and the engine's warning has a Hebrew text", () => {
    const text = describeCreateDeal({ pipeline_id: PIPELINE, stage_id: OPEN2, pipeline: "source", copy_from_source: true, assign: "owner" }, lookups);
    expect(text).toBe('"עסקה: {{name}}", בתהליך המכירה של העסקה המקורית, בשלב הפתוח הראשון (אם אינו קיים: מכירות, שלב הצעה), עם ההכנסה החוזרת והשורות של העסקה המקורית, לאחראי');
    expect(STEP_WARNINGS["some lines were not copied"]).toBeTruthy();
    expect(FOLLOW).toContain("v_warning := 'some lines were not copied'");
    // the step's own errors are unchanged
    for (const error of ["the pipeline no longer exists", "the stage is not an open stage of the pipeline", "the pipeline has no open stage"]) {
      expect(FOLLOW, error).toContain(`raise exception '${error}'`);
    }
  });
});
