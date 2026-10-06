import { CONDITIONS, TRIGGERS, type Entity } from "./definitions";
import type { Lookups } from "./queries";
import type { Rule } from "./schema";

export type DbRule = {
  name: string;
  entity_type: Entity;
  trigger_type: string;
  trigger_config: Record<string, string | number>;
  conditions: Array<{ field: string; op: string; value?: string }>;
  actions: Array<Record<string, string | number>>;
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

  const conditions: DbRule["conditions"] = [];
  for (const condition of rule.conditions) {
    const option = CONDITIONS.find((c) => c.key === condition.key)!;
    if (!option.entities.includes(entity)) return "אחד התנאים לא מתאים לסוג הרשומה.";
    let value = condition.value;
    if (option.input === "source" && !has(lookups.sources, value)) return "המקור שנבחר כבר לא קיים.";
    if (option.input === "status" && !has(lookups.statuses, value)) return "הסטטוס שנבחר כבר לא קיים.";
    if (option.input === "tag" && !has(lookups.tags, value)) return "התגית שנבחרה כבר לא קיימת.";
    if (option.input === "pipeline" && !has(lookups.pipelines, value)) return "הפייפליין שנבחר כבר לא קיים.";
    if (option.input === "shekels") {
      const shekels = Number(String(value).replace(/[,\s₪]/g, ""));
      if (!Number.isFinite(shekels) || shekels < 0) return "יש להזין סכום תקין בתנאי.";
      value = String(Math.round(shekels * 100));
    }
    conditions.push(option.op === "empty" ? { field: option.field, op: option.op } : { field: option.field, op: option.op, value });
  }

  const actions: DbRule["actions"] = [];
  for (const action of rule.actions) {
    if (action.type === "create_task") {
      if (action.assign === "user" && !has(lookups.members, action.user_id)) return "המשתמש שנבחר כבר לא פעיל.";
      const out: Record<string, string | number> = { type: "create_task", title: action.title, task_type: action.task_type, assign: action.assign };
      if (action.due_unit === "minutes") out.due_in_minutes = action.due_amount;
      if (action.due_unit === "days") out.due_in_days = action.due_amount;
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
      actions.push({ type: "set_lead_status", status_id: action.status_id });
    } else if (action.type === "move_deal_stage") {
      if (entity !== "deal") return "העברת שלב מתאימה רק לעסקאות.";
      if (!has(stages, action.stage_id)) return "השלב שנבחר כבר לא קיים.";
      actions.push({ type: "move_deal_stage", stage_id: action.stage_id });
    }
  }

  return { name: rule.name, entity_type: entity, trigger_type: trigger.type, trigger_config, conditions, actions };
}
