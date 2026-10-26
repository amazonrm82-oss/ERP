import { ACTION_LABELS, triggerOf, type ActionType, type Entity } from "./definitions";
import type { Lookups } from "./queries";
import { describeConditions } from "./conditions";
import { describeCreateDeal, describeCreateQuote } from "./create-records";
import { describeDateTrigger } from "./date-trigger";
import { describeFieldTrigger } from "./field-trigger";
import { describeScheduleTrigger } from "./schedule-trigger";
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
  if (trigger?.minAmount && typeof rule.triggerConfig.min_agorot === "number") {
    // AUT-04 (owner, answer 4 ב): a quote's minimum is before VAT
    when += ` (לפחות ₪${(rule.triggerConfig.min_agorot / 100).toLocaleString("he-IL")}${trigger.type === "quote_accepted" ? " לפני מע״מ" : ""})`;
  }
  // AUT-04 follow-up: days after the due date
  if (trigger?.overdue && typeof rule.triggerConfig.days_overdue === "number" && rule.triggerConfig.days_overdue > 0) {
    when += ` (${rule.triggerConfig.days_overdue} ימים אחרי המועד)`;
  }
  if (trigger?.date) {
    when += `: ${describeDateTrigger(trigger.entity, rule.triggerConfig, lookups)}`;
  }
  // AUT-03
  if (trigger?.anyField) {
    when += `: ${describeFieldTrigger(trigger.entity, rule.triggerConfig, lookups)}`;
  }
  if (trigger?.form) {
    when += rule.triggerConfig.form_id ? `: ${nameIn(lookups.forms ?? [], rule.triggerConfig.form_id)}` : ": כל טופס";
  }
  if (trigger?.schedule) {
    when += `: ${describeScheduleTrigger(rule.triggerConfig)}`;
  }

  // AUT-05: "or" groups, linked records and time conditions
  const conditions = describeConditions(rule.conditions, lookups);

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
      case "create_quote":
        return `${label}: ${describeCreateQuote(a, lookups)}`;
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
  // AUT-07: the run was skipped at 110% of the plan's monthly runs
  "the monthly automation runs of the plan are used up": "ההרצות החודשיות של החבילה נוצלו. האוטומציות יחזרו לרוץ בתחילת החודש הבא או אחרי הגדלת החבילה.",
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
  // AUT-02 (rest): a create_quote step
  "a quote is made on a deal or a contact": "הצעת מחיר נוצרת רק לעסקה או לאיש קשר",
  "the record is in the recycle bin": "הרשומה בסל המחזור",
  "quotes are not in the plan": "הצעות מחיר אינן כלולות בתוכנית של העסק",
  "the quote template no longer exists": "תבנית הצעת המחיר נמחקה",
  // AUT-03: a scheduled run on one record raised; the record is skipped for that scheduled time
  "the run stopped with an error": "ההרצה נעצרה בשגיאה ודולגה במועד הזה",
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
  // AUT-01 part B: a relative date the engine could not work out; the field was left as it was
  "the relative date is invalid": "השדה לא עודכן: לא ניתן לחשב את התאריך היחסי",
  // AUT-02 (rest): template lines the rules no longer let in (a product no longer offered, a feature not in the plan); {count}
  "some template lines were skipped": "הצעת המחיר נוצרה בלי {count}: מוצר שכבר לא מוצע או תכונה שאינה בחבילה",
  // AUT-02 follow-up (owner, 26 October 2026): the quote's owner and a customer on hold (COL-05)
  "the chosen owner is not usable, the quote has no owner": "הצעת המחיר נוצרה בלי אחראי: המשתמש שנבחר לא פעיל או צופה בלבד",
  "the record owner is not usable, the quote has no owner": "הצעת המחיר נוצרה בלי אחראי: לרשומה אין אחראי פעיל",
  "the customer is on hold": "הצעת המחיר נוצרה, אבל הלקוח מסומן \"לא למכור עד הסדרת חוב\"",
  "the customer's company is on hold": "הצעת המחיר נוצרה, אבל החברה של הלקוח מסומנת \"לא למכור עד הסדרת חוב\"",
};

/** "שורה אחת" / "3 שורות" / "חלק מהשורות" (no count). */
function linesText(count?: number): string {
  if (count === undefined || !Number.isInteger(count) || count < 1) return "חלק מהשורות";
  return count === 1 ? "שורה אחת" : `${count} שורות`;
}

/**
 * The Hebrew text of a step warning; `{name}` is filled from the step's `warning_name`, `{count}` from its
 * `warning_count` (AUT-02: template lines left out).
 */
export function stepWarningText(warning: string, name?: string, count?: number): string {
  const text = STEP_WARNINGS[warning];
  if (!text) {
    return warning;
  }
  const who = name?.trim() || "האחראי הנוכחי";
  return text.replace("{name}", () => who).replace("{count}", () => linesText(count));
}

/**
 * Every warning of a step, in Hebrew: a create_quote step lists them all in `warnings` (AUT-02 follow-up); any other step
 * has at most one, in `warning`.
 */
export function stepWarningTexts(step: { warning?: string; warnings?: string[]; warningName?: string; warningCount?: number }): string[] {
  const keys = step.warnings && step.warnings.length > 0 ? step.warnings : step.warning ? [step.warning] : [];
  return keys.map((key) => stepWarningText(key, step.warningName, step.warningCount));
}

/** AUT-06: the most retries of a run's failed steps (the engine's app.retry_automation_run, 3 after the first attempt). */
export const MAX_STEP_RETRIES = 3;

const RETRY_NOTES: Record<string, string> = {
  rule_changed: "לא ננסה שוב: האוטומציה נערכה או נמחקה מאז ההרצה.",
  rule_off: "לא ננסה שוב: האוטומציה כבויה.",
  record_gone: "לא ננסה שוב: הרשומה נמחקה או בסל המחזור.",
  conditions: "לא ננסה שוב: הרשומה כבר לא עומדת בתנאים של האוטומציה.",
  error: "לא ננסה שוב: הניסיונות החוזרים נכשלו בשגיאה.",
  // the owner's wording, 21 October 2026
  event_changed: "לא רץ: האירוע השתנה",
  org_closed: "לא רץ: העסק סגור",
  // AUT-04 review: the rule's trigger needs a plan flag the business no longer has
  feature_off: "לא רץ: לא כלול בתוכנית",
};

/** AUT-07: the engine's error of a run skipped because the plan's monthly runs are used up. */
export const RUN_QUOTA_ERROR = "the monthly automation runs of the plan are used up";

/** AUT-07 (7.2): the run log's short label of a run skipped by the monthly quota, or null for any other run. */
export function quotaSkipLabel(run: { status: string; steps: Array<{ error?: string | null }> }): string | null {
  return run.status === "skipped" && run.steps.some((step) => step.error === RUN_QUOTA_ERROR) ? "לא רץ: מכסה" : null;
}

/**
 * AUT-06: one line about a run's retries for the run log, or null when there is nothing to say.
 * `when` is the next retry's time, already formatted for the business.
 */
export function retryLine(run: { retryCount: number; nextRetryAt: string | null; retryNote: string | null }, when: string | null): string | null {
  if (run.retryNote) return RETRY_NOTES[run.retryNote] ?? null;
  if (run.nextRetryAt && when) {
    return `הצעדים שנכשלו ינוסו שוב ב-${when} (ניסיון חוזר ${run.retryCount + 1} מתוך ${MAX_STEP_RETRIES}).`;
  }
  if (run.retryCount > 0) {
    return run.retryCount === 1 ? "הצעדים שנכשלו נוסו שוב פעם אחת." : `הצעדים שנכשלו נוסו שוב ${run.retryCount} פעמים.`;
  }
  return null;
}
