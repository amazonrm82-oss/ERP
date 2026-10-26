import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { fromDbRule, toDbRule } from "@/features/automations/convert";
import { describeRule, STEP_WARNINGS, stepWarningTexts } from "@/features/automations/describe";
import type { Lookups } from "@/features/automations/queries";
import { ruleSchema } from "@/features/automations/schema";

// AUT-02 follow-up (owner's answers of 26 October 2026): the create_quote step's optional owner and the warnings of a
// customer on hold and of a quote with no owner.

const TEMPLATE = "11111111-1111-4111-8111-111111111111";
const MEMBER = "33333333-3333-4333-8333-333333333333";
const GONE = "44444444-4444-4444-8444-444444444444";

const lookups: Lookups = {
  statuses: [],
  sources: [],
  tags: [],
  pipelines: [],
  members: [{ id: MEMBER, name: "דנה" }],
  teams: [],
  reasons: [],
  fields: {},
  quotes: true,
  quoteTemplates: [{ id: TEMPLATE, name: "שיפוץ מטבח" }],
};

// found by its name, so renumbering the migration at merge keeps the test
const ENGINE = readFileSync(
  `supabase/migrations/${readdirSync("supabase/migrations").find((file) => file.endsWith("_automation_quote_owner_hold.sql"))}`,
  "utf8",
);

const parse = (actions: Array<Record<string, string>>) => ruleSchema.parse({ name: "כלל", trigger: "deal:won", conditions: [], actions });

describe("create quote step: owner and holds (AUT-02 follow-up)", () => {
  it("stores a chosen owner only when one is chosen, and reads it back", () => {
    const chosen = toDbRule(parse([{ type: "create_quote", template_id: TEMPLATE, owner_id: MEMBER }]), lookups);
    if (typeof chosen === "string") throw new Error(chosen);
    expect(chosen.actions).toEqual([{ type: "create_quote", template_id: TEMPLATE, owner_id: MEMBER }]);
    const back = fromDbRule({ name: "כלל", entity: "deal", triggerType: "deal_won", triggerConfig: {}, conditions: [], actions: chosen.actions });
    expect(back?.actions).toEqual([{ type: "create_quote", template_id: TEMPLATE, owner_id: MEMBER }]);

    const none = toDbRule(parse([{ type: "create_quote", template_id: TEMPLATE }]), lookups);
    if (typeof none === "string") throw new Error(none);
    expect(none.actions).toEqual([{ type: "create_quote", template_id: TEMPLATE }]);
  });

  it("refuses an owner who is not an active member of this business, and an owner that is not an id", () => {
    expect(toDbRule(parse([{ type: "create_quote", template_id: TEMPLATE, owner_id: GONE }]), lookups)).toBe("המשתמש שנבחר כבר לא פעיל.");
    expect(
      ruleSchema.safeParse({ name: "כלל", trigger: "deal:won", conditions: [], actions: [{ type: "create_quote", template_id: TEMPLATE, owner_id: "x" }] })
        .success,
    ).toBe(false);
  });

  it("says the owner in the rule's description", () => {
    const text = describeRule(
      {
        entity: "deal",
        triggerType: "deal_won",
        triggerConfig: {},
        conditions: [],
        actions: [
          { type: "create_quote", template_id: TEMPLATE, owner_id: MEMBER },
          { type: "create_quote", template_id: TEMPLATE, owner_id: GONE },
          { type: "create_quote", template_id: TEMPLATE },
        ],
      },
      lookups,
    ).actions;
    expect(text).toEqual([
      'יצירת הצעת מחיר מתבנית: "שיפוץ מטבח", טיוטה לדנה',
      'יצירת הצעת מחיר מתבנית: "שיפוץ מטבח", טיוטה ל(נמחק)',
      'יצירת הצעת מחיר מתבנית: "שיפוץ מטבח", טיוטה לאחראי על הרשומה',
    ]);
  });

  it("every warning the engine writes has a Hebrew text, and all of a step's warnings are shown", () => {
    const keys = [
      "the chosen owner is not usable, the quote has no owner",
      "the record owner is not usable, the quote has no owner",
      "the customer is on hold",
      "the customer's company is on hold",
      "some template lines were skipped",
    ];
    for (const key of keys) {
      expect(STEP_WARNINGS[key], key).toBeTruthy();
      expect(ENGINE, key).toContain(`'${key.replace("'", "''")}'::text`);
    }
    expect(ENGINE).toContain("jsonb_build_object('warnings', to_jsonb(v_warnings))");
    expect(
      stepWarningTexts({ warning: "the chosen owner is not usable, the quote has no owner", warnings: [keys[0], keys[2], keys[4]], warningCount: 2 }),
    ).toEqual([
      "הצעת המחיר נוצרה בלי אחראי: המשתמש שנבחר לא פעיל או צופה בלבד",
      'הצעת המחיר נוצרה, אבל הלקוח מסומן "לא למכור עד הסדרת חוב"',
      "הצעת המחיר נוצרה בלי 2 שורות: מוצר שכבר לא מוצע או תכונה שאינה בחבילה",
    ]);
    // a step of before (one warning, no list) reads as it did
    expect(stepWarningTexts({ warning: "some template lines were skipped", warningCount: 1 })).toEqual([
      "הצעת המחיר נוצרה בלי שורה אחת: מוצר שכבר לא מוצע או תכונה שאינה בחבילה",
    ]);
    expect(stepWarningTexts({})).toEqual([]);
  });

  it("the JWT claims are put aside and given back only when they were set (review L1)", () => {
    expect(ENGINE).not.toContain("coalesce(v_claims, '')");
    expect(ENGINE).not.toContain("coalesce(v_claim_sub, '')");
    // create_deal's copied lines and create_quote: two put-asides, each restored on success and on error
    expect(ENGINE.match(/perform set_config\('request\.jwt\.claims', '', true\);/g)).toHaveLength(2);
    expect(ENGINE.match(/perform set_config\('request\.jwt\.claims', v_claims, true\);/g)).toHaveLength(4);
  });

  it("the engine keeps every earlier step", () => {
    for (const action of ["create_task", "notify", "assign_owner", "add_tag", "set_lead_status", "move_deal_stage", "set_field", "create_deal", "create_note", "create_quote"]) {
      expect(ENGINE, action).toContain(`v_type = '${action}'`);
    }
  });
});
