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

export const BREACH_ACTIONS = ["notify", "none"] as const;
export type BreachAction = (typeof BREACH_ACTIONS)[number];
export const DEFAULT_BREACH_ACTION: BreachAction = "notify";

export type ResponseSettings = { targetMinutes: number; breachAction: BreachAction };

export const DEFAULT_RESPONSE_SETTINGS: ResponseSettings = {
  targetMinutes: DEFAULT_TARGET_MINUTES,
  breachAction: DEFAULT_BREACH_ACTION,
};

export const BREACH_ACTION_OPTIONS: { value: BreachAction; label: string; description: string }[] = [
  {
    value: "notify",
    label: "התראה למנהל",
    description: "מנהל הצוות של הליד מקבל התראה, פעם אחת לכל ליד. בלי מנהל צוות: הבעלים ומנהלי המערכת.",
  },
  { value: "none", label: "בלי פעולה", description: "רק דוח זמן התגובה מראה מה נענה בזמן." },
];

export function isBreachAction(value: unknown): value is BreachAction {
  return typeof value === "string" && (BREACH_ACTIONS as readonly string[]).includes(value);
}

/** A row of the table (or none) as the screen uses it; an unknown action reads as the default. */
export function responseSettingsFrom(row: { target_minutes: number; breach_action: string } | null): ResponseSettings {
  if (!row) return DEFAULT_RESPONSE_SETTINGS;
  return {
    targetMinutes: row.target_minutes,
    breachAction: isBreachAction(row.breach_action) ? row.breach_action : DEFAULT_BREACH_ACTION,
  };
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
