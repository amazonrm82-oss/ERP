import { ACTION_LABELS, CONDITIONS, TASK_TYPES, triggerOf, type ActionType } from "./definitions";
import type { Lookups } from "./queries";

type Json = Record<string, unknown>;

const nameIn = (list: Array<{ id: string; name: string }>, id: unknown) => list.find((item) => item.id === id)?.name ?? "(נמחק)";

/** "כאשר … אם … אז …" for a stored rule. */
export function describeRule(
  rule: { entity: string; triggerType: string; triggerConfig: Json; conditions: Json[]; actions: Json[] },
  lookups: Lookups,
): { when: string; conditions: string[]; actions: string[] } {
  const stages = lookups.pipelines.flatMap((p) => p.stages);
  const trigger = triggerOf(rule.entity, rule.triggerType, rule.triggerConfig);
  let when = trigger?.label ?? "טריגר לא מוכר";
  if (trigger?.field && rule.triggerConfig.to) {
    when += ` ל"${trigger.field === "status_id" ? nameIn(lookups.statuses, rule.triggerConfig.to) : nameIn(stages, rule.triggerConfig.to)}"`;
  }
  if (trigger?.number) {
    const n = rule.triggerConfig[trigger.number.key];
    when += trigger.number.key === "days" ? ` (${n} ימים)` : ` (${n} דקות לפני)`;
  }

  const conditions = rule.conditions.map((c) => {
    const option = CONDITIONS.find((o) => o.field === c.field && o.op === c.op);
    if (!option) return "תנאי לא מוכר";
    switch (option.input) {
      case "source":
        return `${option.label} ${nameIn(lookups.sources, c.value)}`;
      case "status":
        return `${option.label} ${nameIn(lookups.statuses, c.value)}`;
      case "tag":
        return `${option.label} ${nameIn(lookups.tags, c.value)}`;
      case "pipeline":
        return `${option.label} ${nameIn(lookups.pipelines, c.value)}`;
      case "shekels":
        return `${option.label} ${(Number(c.value) / 100).toLocaleString("he-IL")}`;
      case "task_type":
        return `${option.label} ${TASK_TYPES.find((t) => t.value === c.value)?.label ?? c.value}`;
      default:
        return option.label;
    }
  });

  const actions = rule.actions.map((a) => {
    const label = ACTION_LABELS[a.type as ActionType] ?? "פעולה";
    switch (a.type) {
      case "create_task": {
        const due = a.due_in_minutes ? `, בעוד ${a.due_in_minutes} דקות` : a.due_in_days ? `, בעוד ${a.due_in_days} ימים` : "";
        const who = a.assign === "user" ? `, ל${nameIn(lookups.members, a.user_id)}` : ", לאחראי";
        return `${label}: "${a.title}"${due}${who}`;
      }
      case "notify":
        return `${label} ל${a.to === "admins" ? "מנהלי המערכת" : a.to === "user" ? nameIn(lookups.members, a.user_id) : "האחראי"}: "${a.title}"`;
      case "assign_owner":
        return a.mode === "user"
          ? `${label}: ${nameIn(lookups.members, a.user_id)}`
          : `${label} בסבב${a.team_id ? ` בצוות ${nameIn(lookups.teams, a.team_id)}` : ""}`;
      case "add_tag":
        return `${label}: ${nameIn(lookups.tags, a.tag_id)}`;
      case "set_lead_status": {
        const status = lookups.statuses.find((s) => s.id === a.status_id);
        if (status?.kind !== "disqualified") return `${label}: ${nameIn(lookups.statuses, a.status_id)}`;
        const reason = lookups.reasons.find((r) => r.id === a.reason_id)?.name;
        return `${label}: ${status.name}, ${reason ? `סיבה: ${reason}` : "בלי סיבה"}`;
      }
      case "move_deal_stage":
        return `${label}: ${nameIn(stages, a.stage_id)}`;
      default:
        return label;
    }
  });
  return { when, conditions, actions };
}

export const STEP_ERRORS: Record<string, string> = {
  "the record no longer exists": "הרשומה כבר לא קיימת",
  "nobody to notify": "אין למי לשלוח התראה (לרשומה אין אחראי)",
  "nobody is available": "אף חבר צוות לא זמין לסבב",
  "the user is not an active member": "המשתמש כבר לא פעיל",
  "the team no longer exists": "הצוות נמחק",
  "the tag no longer exists": "התגית נמחקה",
  "the status no longer exists": "הסטטוס נמחק",
  "the stage is not in this deal's pipeline": "השלב לא שייך לתהליך המכירה של העסקה",
  "daily limit for this record reached": "הגיע למגבלה של 20 הרצות ביום לרשומה",
};

/** A step that ran but with something missing (RVW-9: a "not relevant" move without a reason). */
export const STEP_WARNINGS: Record<string, string> = {
  "no reason is set": "בוצע בלי סיבה: לאוטומציה לא נבחרה סיבה",
  "the reason no longer exists": "בוצע בלי סיבה: הסיבה שנבחרה כבר לא ברשימה",
};
