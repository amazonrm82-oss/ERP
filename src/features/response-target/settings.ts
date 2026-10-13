import { formatNumber } from "@/lib/format";

/**
 * The response target of a new lead (CAP-10), as public.lead_response_settings
 * holds it. No row = the defaults: 60 minutes (owner's decision for SPD-06,
 * the initial value of every business) and "notify the manager".
 * Keep the range and the actions in step with the table's checks.
 */
export const TARGET_MIN = 5;
export const TARGET_MAX = 1440;
export const DEFAULT_TARGET_MINUTES = 60;

export const BREACH_ACTIONS = ["notify", "pass_on", "none"] as const;
export type BreachAction = (typeof BREACH_ACTIONS)[number];
export const DEFAULT_BREACH_ACTION: BreachAction = "notify";

// SPD-03: how many times one lead may be passed on, then the managers are only notified
export const PASSES_MIN = 1;
export const PASSES_MAX = 5;
export const DEFAULT_MAX_PASSES = 2;

export type ResponseSettings = { targetMinutes: number; breachAction: BreachAction; maxPasses: number };

export const DEFAULT_RESPONSE_SETTINGS: ResponseSettings = {
  targetMinutes: DEFAULT_TARGET_MINUTES,
  breachAction: DEFAULT_BREACH_ACTION,
  maxPasses: DEFAULT_MAX_PASSES,
};

export const BREACH_ACTION_OPTIONS: { value: BreachAction; label: string; description: string }[] = [
  {
    value: "notify",
    label: "התראה למנהל",
    description: "מנהל הצוות של הליד מקבל התראה, פעם אחת לכל ליד. בלי מנהל צוות: הבעלים ומנהלי המערכת.",
  },
  {
    value: "pass_on",
    label: "העברה לנציג הבא",
    description:
      "הליד עובר לנציג הבא בתור שזמין ובשעות העבודה, והנציג הקודם והמנהל מקבלים התראה. ליד שמישהו לחץ עליו \"לקחתי\" לא עובר, ואז רק המנהל מקבל התראה.",
  },
  { value: "none", label: "בלי פעולה", description: "רק דוח זמן התגובה מראה מה נענה בזמן." },
];

export function isBreachAction(value: unknown): value is BreachAction {
  return typeof value === "string" && (BREACH_ACTIONS as readonly string[]).includes(value);
}

/** A row of the table (or none) as the screen uses it; an unknown action reads as the default. */
export function responseSettingsFrom(row: { target_minutes: number; breach_action: string; max_passes: number } | null): ResponseSettings {
  if (!row) return DEFAULT_RESPONSE_SETTINGS;
  return {
    targetMinutes: row.target_minutes,
    breachAction: isBreachAction(row.breach_action) ? row.breach_action : DEFAULT_BREACH_ACTION,
    maxPasses: row.max_passes,
  };
}

/** The action the job really runs: passing on needs the plan flag, else the managers are notified. */
export function effectiveBreachAction(action: BreachAction, canPassOn: boolean): BreachAction {
  return action === "pass_on" && !canPassOn ? "notify" : action;
}

/** The target in words: minutes under two hours, else hours (and minutes). */
export function targetText(minutes: number): string {
  if (minutes < 120) return `${formatNumber(minutes)} דקות`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${formatNumber(hours)} שעות` : `${formatNumber(hours)} שעות ו-${formatNumber(rest)} דקות`;
}

export function breachActionLabel(action: BreachAction): string {
  return BREACH_ACTION_OPTIONS.find((option) => option.value === action)?.label ?? "";
}

/** How the clock counts (app.response_deadline): the business's hours when set, never its rest days. */
export function clockNote(hasHours: boolean): string {
  return hasHours
    ? "הזמן נספר רק בשעות העבודה של העסק, ולא בימי המנוחה ובחגים."
    : "לעסק לא הוגדרו שעות עבודה, ולכן נספרות כל שעות היום בימי העבודה. ימי המנוחה והחגים לא נספרים.";
}

/** What the target applies to (SPEC-ADDITIONS 18.3). */
export const TARGET_SCOPE_NOTE =
  "חל על לידים שנכנסו מטופס או מחיבור (webhook). השעון מתחיל כשהליד נכנס, ומתחיל מחדש כשהליד עובר לנציג אחר. מענה הוא פעילות שנרשמה בציר הזמן: שיחה, הערה, פגישה, אימייל, WhatsApp או SMS (הערה פרטית לא נחשבת).";
