import { z } from "zod";

import { BUSINESS_DAYS_FREE_MAX } from "@/features/calendar-days/business-days";

import { DEAL_NAME_MAX, NOTE_BODY_MAX } from "./create-records";
import { DATE_DIRECTIONS, DATE_TRIGGER_MAX_DAYS } from "./date-trigger";
import { LINKS } from "./condition-match";
import { countLeaves, knownConditionKey, MAX_CONDITION_ITEMS, MAX_CONDITION_LEAVES, MAX_GROUP_ITEMS, type ConditionItem } from "./conditions";
import { CONDITIONS, TASK_TYPES, TRIGGERS } from "./definitions";

const id = z.guid({ error: "יש לבחור ערך." });
const text = (max: number, missing: string) => z.string().trim().min(1, { error: missing }).max(max, { error: "הטקסט ארוך מדי." });

// AUT-05: the value of a gte/lte condition (as app.automation_condition_item_ok)
export const CONDITION_NUMBER = /^-?[0-9]+(\.[0-9]+)?$/;

// AUT-05: one condition of the builder (a field condition, "hours" or "weekday"; on = a linked record)
const conditionLeaf = z.object({
  key: z.string().refine(knownConditionKey),
  value: z.string().max(100).optional(),
  on: z.enum(LINKS).optional(),
});

const actionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create_task"),
    title: text(300, "יש לכתוב כותרת למשימה."),
    due_amount: z.coerce.number().int().min(0).max(10_000).default(0),
    due_unit: z.enum(["none", "minutes", "days", "business_days"]).default("none"),
    assign: z.enum(["owner", "user"]).default("owner"),
    user_id: id.optional(),
    task_type: z.enum(TASK_TYPES.map((t) => t.value)).default("todo"),
  }),
  z.object({
    type: z.literal("notify"),
    to: z.enum(["owner", "admins", "user"]),
    user_id: id.optional(),
    title: text(200, "יש לכתוב את נוסח ההתראה."),
  }),
  z.object({
    type: z.literal("assign_owner"),
    mode: z.enum(["user", "round_robin"]),
    user_id: id.optional(),
    team_id: id.optional(),
  }),
  z.object({ type: z.literal("add_tag"), tag_id: id }),
  // reason_id: required when the status is "not relevant" (checked against the organization's list in toDbRule)
  z.object({ type: z.literal("set_lead_status"), status_id: id, reason_id: id.optional() }),
  z.object({ type: z.literal("move_deal_stage"), stage_id: id }),
  // AUT-01: "cf:<key>" or a built-in field of BUILTIN_SET_FIELDS; the value as typed (empty = clear), read by the
  // field's own rules in toDbRule
  z.object({
    type: z.literal("set_field"),
    field: z.string().min(1, { error: "יש לבחור שדה." }).max(100),
    value: z.string().max(10_000, { error: "הערך ארוך מדי." }).optional(),
    // AUT-01 part B: a relative date on a date field ("calendar" or "business" days, 0..365 as typed)
    relative_unit: z.enum(["calendar", "business"]).optional(),
    relative_days: z.string().max(10, { error: "מספר הימים ארוך מדי." }).optional(),
  }),
  // AUT-02: a new deal for the record's customer; the amount in shekels as typed (empty = no amount)
  z.object({
    type: z.literal("create_deal"),
    name: z.string().trim().max(DEAL_NAME_MAX, { error: "שם העסקה ארוך מדי." }).optional(),
    pipeline_id: z.guid({ error: "יש לבחור תהליך מכירה." }),
    stage_id: id.optional(),
    amount: z.string().max(30, { error: "הסכום ארוך מדי." }).optional(),
    assign: z.enum(["owner", "user"]).default("owner"),
    user_id: id.optional(),
    // DEAL-08 follow-up: "1" = on (deal rules only)
    pipeline_source: z.enum(["", "1"]).optional(),
    copy_source: z.enum(["", "1"]).optional(),
  }),
  // AUT-02: a note on the record's timeline
  z.object({ type: z.literal("create_note"), body: text(NOTE_BODY_MAX, "יש לכתוב את ההערה.") }),
  // AUT-02 (rest): a draft quote from a quote template (checked against the business's templates and plan in toDbRule)
  // follow-up (owner, 26 October 2026): an optional owner of the quote (empty = the record's owner)
  z.object({ type: z.literal("create_quote"), template_id: z.guid({ error: "יש לבחור תבנית הצעת מחיר." }), owner_id: id.optional() }),
]);

export type RuleAction = z.infer<typeof actionSchema>;

/** What the builder sends (as JSON in one form field). */
export const ruleSchema = z
  .object({
    name: text(80, "יש לתת שם לאוטומציה."),
    trigger: z.string().refine((key) => TRIGGERS.some((t) => t.key === key), { error: "יש לבחור מתי זה קורה." }),
    trigger_to: id.optional(),
    trigger_number: z.coerce.number().int().min(1).max(10_080).optional(),
    // AUT-03: a date trigger's field, direction and days (checked against the record type in toDbRule)
    trigger_field: z.string().max(100).optional(),
    trigger_direction: z.enum(DATE_DIRECTIONS).optional(),
    trigger_days: z.coerce.number({ error: "יש להזין מספר ימים." }).int({ error: "יש להזין מספר ימים שלם." }).min(0).max(DATE_TRIGGER_MAX_DAYS, { error: `עד ${DATE_TRIGGER_MAX_DAYS} ימים.` }).optional(),
    // PAY-07: the minimum payment in shekels as typed (checked in toDbRule)
    trigger_min: z.string().max(30, { error: "הסכום ארוך מדי." }).optional(),
    // AUT-05: a condition, or an "or" group of conditions; a condition may test a linked record or the time
    conditions: z
      .array(z.union([z.object({ any: z.array(conditionLeaf).min(2, { error: "בקבוצת \"או\" יש לפחות 2 תנאים." }).max(MAX_GROUP_ITEMS, { error: `בקבוצת "או" עד ${MAX_GROUP_ITEMS} תנאים.` }) }), conditionLeaf]))
      .max(MAX_CONDITION_ITEMS, { error: `עד ${MAX_CONDITION_ITEMS} תנאים.` })
      .refine((items) => countLeaves(items as ConditionItem[]) <= MAX_CONDITION_LEAVES, { error: `עד ${MAX_CONDITION_LEAVES} תנאים בסך הכול, כולל אלה שבתוך קבוצות "או".` }),
    actions: z.array(actionSchema).min(1, { error: "יש להוסיף לפחות פעולה אחת." }).max(10, { error: "עד 10 פעולות." }),
  })
  .superRefine((rule, ctx) => {
    rule.actions.forEach((action, index) => {
      const needsUser =
        ((action.type === "create_task" || action.type === "create_deal") && action.assign === "user") ||
        (action.type === "notify" && action.to === "user") ||
        (action.type === "assign_owner" && action.mode === "user");
      if (needsUser && !("user_id" in action && action.user_id)) {
        ctx.addIssue({ code: "custom", path: ["actions", index], message: "יש לבחור משתמש." });
      }
      // HEB-03: the engine accepts 0..60 business days
      if (action.type === "create_task" && action.due_unit === "business_days" && action.due_amount > BUSINESS_DAYS_FREE_MAX) {
        ctx.addIssue({ code: "custom", path: ["actions", index], message: `עד ${BUSINESS_DAYS_FREE_MAX} ימי עסקים.` });
      }
    });
    rule.conditions.forEach((item, index) => {
      const leaves = "any" in item ? item.any : [item];
      for (const condition of leaves) {
        const option = CONDITIONS.find((c) => c.key === condition.key);
        const needsValue = option ? option.input !== "none" : true;
        if (needsValue && !condition.value) {
          ctx.addIssue({ code: "custom", path: ["conditions", index], message: "יש לבחור ערך לתנאי." });
        }
        // a number comparison needs a number (the database checks the stored value the same way)
        if (option && (option.op as string === "gte" || option.op as string === "lte") && condition.value && !CONDITION_NUMBER.test(condition.value.replace(/[,\s₪]/g, ""))) {
          ctx.addIssue({ code: "custom", path: ["conditions", index], message: "יש להזין סכום תקין בתנאי." });
        }
      }
    });
  });

export type Rule = z.infer<typeof ruleSchema>;
