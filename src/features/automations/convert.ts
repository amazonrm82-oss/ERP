import { BUSINESS_DAYS_FREE_MAX } from "@/features/calendar-days/business-days";

import type { Json } from "@/lib/database.types";

import { conditionsFromDb, conditionsToDb, type ConditionItem } from "./conditions";
import { DEBT_OVERDUE_MAX_DAYS, FEATURE_MISSING, TRIGGERS, triggerFlags, triggerOf, type Entity } from "./definitions";
import type { Lookups } from "./queries";
import type { Rule } from "./schema";
import { createDealAction, createDealDraft, createQuoteAction } from "./create-records";
import { dateTriggerConfig, dateTriggerDraft } from "./date-trigger";
import { customDefinition, setFieldDraft, setFieldRelativeDraft, setFieldValue } from "./set-field";

export const REASON_REQUIRED = "יש לבחור סיבה לסטטוס \"לא רלוונטי\".";

/** A shekel amount as typed ("1,500", "₪ 99.90") in whole agorot, or null when it is not a non-negative amount. */
export function shekelsToAgorot(value: string): number | null {
  const shekels = Number(value.replace(/[,\s₪]/g, ""));
  if (value.trim() === "" || !Number.isFinite(shekels) || shekels < 0) return null;
  const agorot = Math.round(shekels * 100);
  return Number.isSafeInteger(agorot) ? agorot : null;
}

export type DbRule = {
  name: string;
  entity_type: Entity;
  trigger_type: string;
  trigger_config: Record<string, string | number>;
  conditions: Array<Record<string, Json>>;
  // AUT-01: a set_field step keeps the field's JSON value
  actions: Array<Record<string, Json>>;
};

/**
 * Builder rule -> the JSON the engine reads, after checking that every id it
 * names belongs to this organization (the lookups come from the user's own
 * organization through RLS). Returns an error message instead when it does not.
 */
export function toDbRule(rule: Rule, lookups: Lookups): DbRule | string {
  const trigger = TRIGGERS.find((t) => t.key === rule.trigger)!;
  const entity = trigger.entity;
  const has = (list: Array<{ id: string }>, id: string | undefined) => !id || list.some((item) => item.id === id);
  const stages = lookups.pipelines.flatMap((p) => p.stages);

  const trigger_config: Record<string, string | number> = {};
  if (trigger.field) {
    trigger_config.field = trigger.field;
    if (rule.trigger_to) {
      const ok = trigger.field === "status_id" ? has(lookups.statuses, rule.trigger_to) : has(stages, rule.trigger_to);
      if (!ok) return "הערך שנבחר בטריגר כבר לא קיים.";
      trigger_config.to = rule.trigger_to;
    }
  }
  if (trigger.number) {
    trigger_config[trigger.number.key] = rule.trigger_number ?? trigger.number.default;
  }
  if (trigger.date) {
    const config = dateTriggerConfig(entity, { field: rule.trigger_field, days: rule.trigger_days, direction: rule.trigger_direction }, lookups);
    if (typeof config === "string") return config;
    Object.assign(trigger_config, config);
  }
  // PAY-07, AUT-04: a trigger of a module needs its plan flag
  const missing = triggerFlags(trigger.type).find((flag) => !lookups[flag]);
  if (missing) return FEATURE_MISSING[missing];
  // AUT-04 follow-up: days after the due date (0 = the day after it)
  if (trigger.overdue) {
    const days = rule.trigger_days ?? 0;
    if (days > DEBT_OVERDUE_MAX_DAYS) return `עד ${DEBT_OVERDUE_MAX_DAYS} ימים.`;
    trigger_config.days_overdue = days;
  }
  if (trigger.minAmount && rule.trigger_min?.trim()) {
    const agorot = shekelsToAgorot(rule.trigger_min);
    if (agorot === null) return "יש להזין סכום מינימלי תקין.";
    if (agorot > 0) trigger_config.min_agorot = agorot;
  }

  // AUT-05: "or" groups, linked records, working hours and the weekday
  const conditions = conditionsToDb(rule.conditions as ConditionItem[], entity, lookups);
  if (typeof conditions === "string") return conditions;

  const actions: DbRule["actions"] = [];
  for (const action of rule.actions) {
    if (action.type === "create_task") {
      if (action.assign === "user" && !has(lookups.members, action.user_id)) return "המשתמש שנבחר כבר לא פעיל.";
      const out: Record<string, string | number> = { type: "create_task", title: action.title, task_type: action.task_type, assign: action.assign };
      if (action.due_unit === "minutes") out.due_in_minutes = action.due_amount;
      if (action.due_unit === "days") out.due_in_days = action.due_amount;
      if (action.due_unit === "business_days") {
        if (action.due_amount > BUSINESS_DAYS_FREE_MAX) return `עד ${BUSINESS_DAYS_FREE_MAX} ימי עסקים.`;
        out.due_in_business_days = action.due_amount;
      }
      if (action.assign === "user" && action.user_id) out.user_id = action.user_id;
      actions.push(out);
    } else if (action.type === "notify") {
      if (action.to === "user" && !has(lookups.members, action.user_id)) return "המשתמש שנבחר כבר לא פעיל.";
      actions.push({ type: "notify", to: action.to, title: action.title, ...(action.to === "user" && action.user_id ? { user_id: action.user_id } : {}) });
    } else if (action.type === "assign_owner") {
      if (action.mode === "user" && !has(lookups.members, action.user_id)) return "המשתמש שנבחר כבר לא פעיל.";
      if (action.mode === "round_robin" && !has(lookups.teams, action.team_id)) return "הצוות שנבחר כבר לא קיים.";
      actions.push(
        action.mode === "user"
          ? { type: "assign_owner", mode: "user", user_id: action.user_id! }
          : { type: "assign_owner", mode: "round_robin", ...(action.team_id ? { team_id: action.team_id } : {}) },
      );
    } else if (action.type === "add_tag") {
      if (entity === "task") return "למשימות אין תגיות.";
      if (!has(lookups.tags, action.tag_id)) return "התגית שנבחרה כבר לא קיימת.";
      actions.push({ type: "add_tag", tag_id: action.tag_id });
    } else if (action.type === "set_lead_status") {
      if (entity !== "lead") return "שינוי סטטוס מתאים רק ללידים.";
      const status = lookups.statuses.find((s) => s.id === action.status_id);
      if (!status || status.kind === "converted") return "יש לבחור סטטוס שאינו 'הומר'.";
      if (status.kind === "disqualified") {
        // RVW-9: a rule that makes a lead "not relevant" says why, from the organization's list.
        // Owner, 13 October 2026: while the list is empty the rule is saved without a reason
        // (the engine leaves the reason empty); once the list has reasons, one is required.
        if (lookups.reasons.length === 0) {
          actions.push({ type: "set_lead_status", status_id: action.status_id });
          continue;
        }
        if (!action.reason_id) return REASON_REQUIRED;
        if (!has(lookups.reasons, action.reason_id)) return "הסיבה שנבחרה כבר לא ברשימה. יש לבחור סיבה אחרת.";
        actions.push({ type: "set_lead_status", status_id: action.status_id, reason_id: action.reason_id });
      } else {
        actions.push({ type: "set_lead_status", status_id: action.status_id });
      }
    } else if (action.type === "move_deal_stage") {
      if (entity !== "deal") return "העברת שלב מתאימה רק לעסקאות.";
      if (!has(stages, action.stage_id)) return "השלב שנבחר כבר לא קיים.";
      actions.push({ type: "move_deal_stage", stage_id: action.stage_id });
    } else if (action.type === "set_field") {
      const built = setFieldValue(entity, action.field, action.value ?? "", lookups, { unit: action.relative_unit, days: action.relative_days });
      if (typeof built === "string") return built;
      actions.push({ type: "set_field", field: action.field, value: built.value });
    } else if (action.type === "create_deal") {
      const built = createDealAction(entity, action, lookups);
      if (typeof built === "string") return built;
      actions.push(built);
    } else if (action.type === "create_note") {
      actions.push({ type: "create_note", body: action.body });
    } else if (action.type === "create_quote") {
      const built = createQuoteAction(entity, action, lookups);
      if (typeof built === "string") return built;
      actions.push(built);
    }
  }

  return { name: rule.name, entity_type: entity, trigger_type: trigger.type, trigger_config, conditions, actions };
}

/** What the builder starts from when editing: a saved rule turned back into the builder's form values. */
export type BuilderInitial = {
  name: string;
  trigger: string;
  triggerTo: string;
  triggerNumber: string;
  // AUT-03: a date trigger's field, days and direction ("on" = the day itself)
  triggerField?: string;
  triggerDays?: string;
  triggerDirection?: string;
  // PAY-07: the minimum payment in shekels ("" = any amount)
  triggerMin?: string;
  conditions: ConditionItem[];
  actions: Array<Record<string, string>>;
};

const str = (value: unknown) => (value === undefined || value === null ? "" : String(value));

export function fromDbRule(
  rule: {
    name: string;
    entity: string;
    triggerType: string;
    triggerConfig: Record<string, unknown>;
    conditions: Array<Record<string, unknown>>;
    actions: Array<Record<string, unknown>>;
  },
  // AUT-01: to show a set_field value as typed (currency in shekels, date and time in the business's zone)
  set: { fields: Lookups["fields"]; timeZone?: string } = { fields: {} },
): BuilderInitial | null {
  const trigger = triggerOf(rule.entity, rule.triggerType, rule.triggerConfig);
  if (!trigger) return null;
  const conditions = conditionsFromDb(rule.conditions, trigger.entity);
  const actions = rule.actions.flatMap((a): Array<Record<string, string>> => {
    switch (a.type) {
      case "create_task": {
        const unit =
          typeof a.due_in_business_days === "number"
            ? "business_days"
            : a.due_in_minutes !== undefined
              ? "minutes"
              : a.due_in_days !== undefined
                ? "days"
                : "none";
        return [
          {
            type: "create_task",
            title: str(a.title),
            due_unit: unit,
            due_amount:
              unit === "business_days"
                ? str(a.due_in_business_days)
                : unit === "minutes"
                  ? str(a.due_in_minutes)
                  : unit === "days"
                    ? str(a.due_in_days)
                    : "0",
            assign: str(a.assign) || "owner",
            user_id: str(a.user_id),
            task_type: str(a.task_type) || "todo",
          },
        ];
      }
      case "notify":
        return [{ type: "notify", to: str(a.to) || "owner", user_id: str(a.user_id), title: str(a.title) }];
      case "assign_owner":
        return [{ type: "assign_owner", mode: str(a.mode) || "round_robin", user_id: str(a.user_id), team_id: str(a.team_id) }];
      case "add_tag":
        return [{ type: "add_tag", tag_id: str(a.tag_id) }];
      case "set_lead_status":
        return [{ type: "set_lead_status", status_id: str(a.status_id), reason_id: str(a.reason_id) }];
      case "move_deal_stage":
        return [{ type: "move_deal_stage", stage_id: str(a.stage_id) }];
      case "set_field": {
        const field = str(a.field);
        const relative = setFieldRelativeDraft(a.value);
        return [{ type: "set_field", field, value: setFieldDraft(customDefinition(trigger.entity, field, set), a.value, set.timeZone), ...relative }];
      }
      case "create_deal":
        return [createDealDraft(a)];
      case "create_note":
        return [{ type: "create_note", body: str(a.body) }];
      case "create_quote":
        return [{ type: "create_quote", template_id: str(a.template_id) }];
      default:
        return [];
    }
  });
  const date = trigger.date ? dateTriggerDraft(rule.triggerConfig) : null;
  return {
    name: rule.name,
    trigger: trigger.key,
    triggerTo: str(rule.triggerConfig.to),
    triggerNumber: trigger.number ? str(rule.triggerConfig[trigger.number.key] ?? trigger.number.default) : "",
    ...(date ? { triggerField: date.field, triggerDays: date.days, triggerDirection: date.direction } : {}),
    ...(trigger.overdue ? { triggerDays: typeof rule.triggerConfig.days_overdue === "number" ? String(rule.triggerConfig.days_overdue) : "0" } : {}),
    ...(trigger.minAmount
      ? { triggerMin: typeof rule.triggerConfig.min_agorot === "number" ? String(rule.triggerConfig.min_agorot / 100) : "" }
      : {}),
    conditions,
    actions,
  };
}

/**
 * RVW-9: the actions of a saved rule that make a lead "not relevant" without a
 * usable reason: none was set (rules saved before the reason was required), or
 * the reason is no longer an active one of the list. Such a rule still runs and
 * leaves the reason empty; the screens remind the admin to complete it.
 * While the organization's list is empty there is nothing to pick, so nothing is
 * reported (owner, 13 October 2026); the builder says the list is empty instead.
 * Returns the 0-based positions of those actions.
 */
export function actionsMissingReason(actions: Array<Record<string, unknown>>, lookups: Pick<Lookups, "statuses" | "reasons">): number[] {
  if (lookups.reasons.length === 0) return [];
  return actions.flatMap((action, index) => {
    if (action.type !== "set_lead_status") return [];
    const status = lookups.statuses.find((s) => s.id === action.status_id);
    if (status?.kind !== "disqualified") return [];
    return lookups.reasons.some((r) => r.id === action.reason_id) ? [] : [index];
  });
}
