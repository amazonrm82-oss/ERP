import { ACTION_LABELS, CONDITIONS, TASK_TYPES, triggerOf, type ActionType, type Entity } from "./definitions";
import type { Lookups } from "./queries";
import { describeCreateDeal } from "./create-records";
import { describeDateTrigger } from "./date-trigger";
import { describeSetField } from "./set-field";

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
  if (trigger?.date) {
    when += `: ${describeDateTrigger(trigger.entity, rule.triggerConfig, lookups)}`;
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
        const due =
          typeof a.due_in_business_days === "number"
            ? a.due_in_business_days === 0
              ? ", ביום העבודה הקרוב"
              : `, בעוד ${a.due_in_business_days} ימי עסקים`
            : a.due_in_minutes
              ? `, בעוד ${a.due_in_minutes} דקות`
              : a.due_in_days
                ? `, בעוד ${a.due_in_days} ימים`
                : "";
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
      case "set_field":
        return `${label}: ${describeSetField(rule.entity as Entity, String(a.field ?? ""), a.value, lookups)}`;
      case "create_deal":
        return `${label}: ${describeCreateDeal(a, lookups)}`;
      case "create_note":
        return `${label}: "${String(a.body ?? "")}"`;
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
  // AUT-01: a set_field step
  "the field does not fit this record": "השדה לא מתאים לסוג הרשומה",
  "the field no longer exists": "השדה נמחק או הוסתר",
  "the value does not fit the field": "הערך לא מתאים לשדה",
  "the field is read-only": "השדה לקריאה בלבד וכבר מלא",
  "the value is already on another record": "הערך כבר קיים ברשומה אחרת, והשדה ייחודי",
  "the source no longer exists": "המקור נמחק או הוסתר",
  // AUT-02: create_deal and create_note steps
  "a lead becomes a deal by conversion": "ליד הופך לעסקה בהמרה, לא באוטומציה",
  "the pipeline no longer exists": "תהליך המכירה נמחק",
  "the stage is not an open stage of the pipeline": "השלב נמחק, נסגר או לא שייך לתהליך המכירה",
  "the pipeline has no open stage": "בתהליך המכירה אין שלב פתוח",
  "the amount is invalid": "סכום העסקה לא תקין",
  "the plan record limit is reached": "הגעתם למספר הרשומות שהחבילה מאפשרת",
  "the note is empty": "ההערה ריקה",
  "the task is not linked to a record": "המשימה לא מקושרת לרשומה פעילה",
};

/** A step that ran but with something missing (RVW-9: a "not relevant" move without a reason). */
export const STEP_WARNINGS: Record<string, string> = {
  "no reason is set": "בוצע בלי סיבה: לאוטומציה לא נבחרה סיבה",
  "the reason no longer exists": "בוצע בלי סיבה: הסיבה שנבחרה כבר לא ברשימה",
  "the business-day offset is invalid": "המשימה נוצרה בלי מועד: מספר ימי העסקים לא תקין",
  // HEB-08: an automation gave the lead to someone away with no deputy
  "the owner is away, the lead has no owner": "האחראי נעדר, הליד נכנס בלי אחראי",
  // HEB-08 (owner, 14 October 2026): the lead had an owner and keeps it; {name} = that owner
  "the requested owner is away, the lead stays with its owner": "האחראי המבוקש נעדר, הליד נשאר אצל {name}",
  // DEAL-08 follow-up: a line of the source deal the rules no longer let in
  "some lines were not copied": "העסקה נוצרה בלי חלק מהשורות: מוצר שכבר לא מוצע או תכונה שאינה בחבילה",
};

/** The Hebrew text of a step warning; `{name}` is filled from the step's `warning_name`. */
export function stepWarningText(warning: string, name?: string): string {
  const text = STEP_WARNINGS[warning];
  if (!text) {
    return warning;
  }
  const who = name?.trim() || "האחראי הנוכחי";
  return text.replace("{name}", () => who);
}
