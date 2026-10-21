import { z } from "zod";

import { BUSINESS_DAYS_FREE_MAX } from "@/features/calendar-days/business-days";

import { DEAL_NAME_MAX, NOTE_BODY_MAX } from "./create-records";
import { DATE_DIRECTIONS, DATE_TRIGGER_MAX_DAYS } from "./date-trigger";
import { CONDITIONS, TASK_TYPES, TRIGGERS } from "./definitions";

const id = z.guid({ error: "יש לבחור ערך." });
const text = (max: number, missing: string) => z.string().trim().min(1, { error: missing }).max(max, { error: "הטקסט ארוך מדי." });

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
    conditions: z
      .array(z.object({ key: z.string().refine((key) => CONDITIONS.some((c) => c.key === key)), value: z.string().max(100).optional() }))
      .max(5, { error: "עד 5 תנאים." }),
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
    rule.conditions.forEach((condition, index) => {
      const option = CONDITIONS.find((c) => c.key === condition.key);
      if (option && option.input !== "none" && !condition.value) {
        ctx.addIssue({ code: "custom", path: ["conditions", index], message: "יש לבחור ערך לתנאי." });
      }
    });
  });

export type Rule = z.infer<typeof ruleSchema>;
