import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { fromDbRule, toDbRule } from "@/features/automations/convert";
import { actionOffered, actionsFor } from "@/features/automations/definitions";
import { describeRule, STEP_ERRORS, STEP_WARNINGS, stepWarningText } from "@/features/automations/describe";
import type { Lookups } from "@/features/automations/queries";
import { ruleSchema } from "@/features/automations/schema";

// AUT-02 (rest): the "create quote from a template" step: builder values -> stored rule -> builder values, and the texts.

const TEMPLATE = "11111111-1111-4111-8111-111111111111";
const GONE = "22222222-2222-4222-8222-222222222222";

const lookups: Lookups = {
  statuses: [],
  sources: [],
  tags: [],
  pipelines: [],
  members: [],
  teams: [],
  reasons: [],
  fields: {},
  quotes: true,
  quoteTemplates: [{ id: TEMPLATE, name: "שיפוץ מטבח" }],
};

// found by its name, so renumbering the migration at merge keeps the test
const ENGINE = readFileSync(
  `supabase/migrations/${readdirSync("supabase/migrations").find((file) => file.endsWith("_automation_create_quote.sql"))}`,
  "utf8",
);

const parse = (trigger: string, actions: Array<Record<string, string>>) => ruleSchema.parse({ name: "כלל", trigger, conditions: [], actions });

describe("create quote step (AUT-02)", () => {
  it("is offered on deals and contacts only, and only with the quotes flag (a saved rule keeps its own)", () => {
    for (const entity of ["deal", "contact"] as const) expect(actionsFor(entity)).toContain("create_quote");
    for (const entity of ["lead", "company", "task"] as const) expect(actionsFor(entity)).not.toContain("create_quote");
    expect(actionOffered("create_quote", { quotes: true })).toBe(true);
    expect(actionOffered("create_quote", { quotes: false })).toBe(false);
    expect(actionOffered("create_quote", { quotes: false }, "create_quote")).toBe(true);
    expect(actionOffered("create_task", { quotes: false })).toBe(true);
  });

  it("stores the template id and reads it back", () => {
    const db = toDbRule(parse("deal:won", [{ type: "create_quote", template_id: TEMPLATE }]), lookups);
    if (typeof db === "string") throw new Error(db);
    expect(db.actions).toEqual([{ type: "create_quote", template_id: TEMPLATE }]);
    const back = fromDbRule({ name: "כלל", entity: "deal", triggerType: "deal_won", triggerConfig: {}, conditions: [], actions: db.actions });
    expect(back?.actions).toEqual([{ type: "create_quote", template_id: TEMPLATE }]);
    const contact = toDbRule(parse("contact:created", [{ type: "create_quote", template_id: TEMPLATE }]), lookups);
    expect(typeof contact).not.toBe("string");
  });

  it("refuses another record type, a missing flag, a gone template and no template (checked on the server)", () => {
    const quote = (trigger: string, extra: Partial<Lookups> = {}, template = TEMPLATE) =>
      toDbRule(parse(trigger, [{ type: "create_quote", template_id: template }]), { ...lookups, ...extra });
    expect(quote("lead:created")).toBe("הצעת מחיר נוצרת רק לעסקאות ולאנשי קשר.");
    expect(quote("company:created")).toBe("הצעת מחיר נוצרת רק לעסקאות ולאנשי קשר.");
    expect(quote("deal:won", { quotes: false })).toBe("הצעות מחיר אינן כלולות בתוכנית של העסק.");
    expect(quote("deal:won", { quoteTemplates: undefined })).toBe("התבנית שנבחרה כבר לא קיימת.");
    expect(quote("deal:won", {}, GONE)).toBe("התבנית שנבחרה כבר לא קיימת.");
    expect(ruleSchema.safeParse({ name: "כלל", trigger: "deal:won", conditions: [], actions: [{ type: "create_quote" }] }).success).toBe(false);
    expect(ruleSchema.safeParse({ name: "כלל", trigger: "deal:won", conditions: [], actions: [{ type: "create_quote", template_id: "x" }] }).success).toBe(false);
  });

  it("says the step in Hebrew; every engine error and the warning have a Hebrew text", () => {
    const text = describeRule(
      { entity: "deal", triggerType: "deal_won", triggerConfig: {}, conditions: [], actions: [{ type: "create_quote", template_id: TEMPLATE }, { type: "create_quote", template_id: GONE }] },
      lookups,
    ).actions;
    expect(text).toEqual([
      'יצירת הצעת מחיר מתבנית: "שיפוץ מטבח", טיוטה לאחראי על הרשומה',
      'יצירת הצעת מחיר מתבנית: "(נמחק)", טיוטה לאחראי על הרשומה',
    ]);
    for (const error of [
      "a quote is made on a deal or a contact",
      "the record is in the recycle bin",
      "quotes are not in the plan",
      "the quote template no longer exists",
    ]) {
      expect(STEP_ERRORS[error], error).toBeTruthy();
      expect(ENGINE, error).toContain(`raise exception '${error}'`);
    }
    expect(STEP_WARNINGS["some template lines were skipped"]).toBeTruthy();
    expect(ENGINE).toContain("v_warning := 'some template lines were skipped'");
    expect(ENGINE).toContain("jsonb_build_object('warning_count', v_skipped)");
    expect(stepWarningText("some template lines were skipped", undefined, 1)).toBe("הצעת המחיר נוצרה בלי שורה אחת: מוצר שכבר לא מוצע או תכונה שאינה בחבילה");
    expect(stepWarningText("some template lines were skipped", undefined, 3)).toContain("בלי 3 שורות");
    expect(stepWarningText("some template lines were skipped")).toContain("בלי חלק מהשורות");
    // the other warnings are unchanged by the count
    expect(stepWarningText("the requested owner is away, the lead stays with its owner", "דנה", 2)).toBe("האחראי המבוקש נעדר, הליד נשאר אצל דנה");
  });

  it("the engine keeps every earlier step: the new body is the previous one plus this branch", () => {
    for (const action of ["create_task", "notify", "assign_owner", "add_tag", "set_lead_status", "move_deal_stage", "set_field", "create_deal", "create_note"]) {
      expect(ENGINE, action).toContain(`v_type = '${action}'`);
    }
  });
});
