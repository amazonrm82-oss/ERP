import { z } from "zod";

// MNY-04, owner (285) ג (11 November 2026): a switch and a threshold per anomaly alert, every alert on by default with the
// numbers of migration anomaly_alerts. Stored in public.anomaly_alert_settings (no row = these defaults; the table's column
// defaults and app.anomaly_settings_of hold the same numbers, a unit test reads the migration). Owner (286) ב: the idle
// alert counts owners and admins too, and a notice about one of them goes to the other owners and admins only.

export type AnomalyKind = "lead_drop" | "idle_rep" | "quiet_form" | "campaign_jump";

export type AnomalyAlertSettings = {
  leadDropOn: boolean;
  leadDropPercent: number;
  idleRepOn: boolean;
  idleRepDays: number;
  quietFormOn: boolean;
  quietFormMinInquiries: number;
  campaignJumpOn: boolean;
  campaignJumpPercent: number;
};

export const ANOMALY_ALERT_DEFAULTS: AnomalyAlertSettings = {
  leadDropOn: true,
  leadDropPercent: 50,
  idleRepOn: true,
  idleRepDays: 3,
  quietFormOn: true,
  quietFormMinInquiries: 4,
  campaignJumpOn: true,
  campaignJumpPercent: 100,
};

/** The bounds of each number (= the table's check constraints). */
export const ANOMALY_BOUNDS = {
  lead_drop_percent: { min: 10, max: 90 },
  idle_rep_days: { min: 1, max: 10 },
  quiet_form_min_inquiries: { min: 1, max: 500 },
  campaign_jump_percent: { min: 20, max: 1000 },
} as const;

export const ANOMALY_FIELD_NAMES = [
  "lead_drop_on",
  "lead_drop_percent",
  "idle_rep_on",
  "idle_rep_days",
  "quiet_form_on",
  "quiet_form_min_inquiries",
  "campaign_jump_on",
  "campaign_jump_percent",
] as const;

const wholeNumber = (missing: string, key: keyof typeof ANOMALY_BOUNDS, unit: string) => {
  const { min, max } = ANOMALY_BOUNDS[key];
  const range = `בין ${min} ל-${max} ${unit}.`;
  return z.preprocess(
    (value) => (typeof value === "string" && value.trim() !== "" ? Number(value.trim()) : undefined),
    z.number({ error: missing }).int({ error: `מספר שלם של ${unit}.` }).min(min, { error: range }).max(max, { error: range }),
  );
};

// a checkbox: "on" when ticked, missing otherwise
const ticked = z.preprocess((value) => value === "on", z.boolean());

/** The form's values, in the table's column names. */
export const anomalyAlertSettingsSchema = z.object({
  lead_drop_on: ticked,
  lead_drop_percent: wholeNumber("יש לכתוב בכמה אחוזים הפניות צריכות לרדת.", "lead_drop_percent", "אחוזים"),
  idle_rep_on: ticked,
  idle_rep_days: wholeNumber("יש לכתוב אחרי כמה ימי עבודה בלי עדכון.", "idle_rep_days", "ימים"),
  quiet_form_on: ticked,
  quiet_form_min_inquiries: wholeNumber("יש לכתוב כמה פניות טופס צריך לקבל כדי להיחשב קבוע.", "quiet_form_min_inquiries", "פניות"),
  campaign_jump_on: ticked,
  campaign_jump_percent: wholeNumber("יש לכתוב בכמה אחוזים העלות לפנייה צריכה לעלות.", "campaign_jump_percent", "אחוזים"),
});

export type AnomalyAlertSettingsInput = z.infer<typeof anomalyAlertSettingsSchema>;

type Row = {
  lead_drop_on: boolean;
  lead_drop_percent: number;
  idle_rep_on: boolean;
  idle_rep_days: number;
  quiet_form_on: boolean;
  quiet_form_min_inquiries: number;
  campaign_jump_on: boolean;
  campaign_jump_percent: number;
};

/** A stored row as settings; no row = the defaults. */
export function anomalySettingsFromRow(row: Row | null | undefined): AnomalyAlertSettings {
  if (!row) return ANOMALY_ALERT_DEFAULTS;
  return {
    leadDropOn: row.lead_drop_on,
    leadDropPercent: row.lead_drop_percent,
    idleRepOn: row.idle_rep_on,
    idleRepDays: row.idle_rep_days,
    quietFormOn: row.quiet_form_on,
    quietFormMinInquiries: row.quiet_form_min_inquiries,
    campaignJumpOn: row.campaign_jump_on,
    campaignJumpPercent: row.campaign_jump_percent,
  };
}

/** The weeks condition of a regular form (= app.anomaly_quiet_forms: least(3, the number) of the 4 weeks). */
export function quietFormWeeksText(minInquiries: number): string {
  const weeks = Math.min(3, minInquiries);
  return weeks === 1 ? "לפחות בשבוע אחד מתוך ה-4" : `לפחות ב-${weeks} מתוך 4 השבועות`;
}

/** What each alert looks for, in plain Hebrew, with the business's numbers (the settings page; the notices say the same). */
export function anomalyRuleText(kind: AnomalyKind, settings: AnomalyAlertSettings): string {
  switch (kind) {
    case "lead_drop":
      return `מקור לידים קבוע שב-7 הימים האחרונים הביא פחות מ-${100 - settings.leadDropPercent}% מהממוצע השבועי של 4 השבועות שלפניהם (ירידה של יותר מ-${settings.leadDropPercent}%).`;
    case "idle_rep":
      return settings.idleRepDays === 1
        ? "מישהו בצוות, כולל בעלים ומנהלי מערכת, שלא עדכן אף רשומה ביום העבודה האחרון שלו. ההתראה על בעלים או מנהל מערכת נשלחת לשאר הבעלים והמנהלים."
        : `מישהו בצוות, כולל בעלים ומנהלי מערכת, שלא עדכן אף רשומה ב-${settings.idleRepDays} ימי העבודה האחרונים שלו. ההתראה על בעלים או מנהל מערכת נשלחת לשאר הבעלים והמנהלים.`;
    case "quiet_form":
      return `טופס שקיבל לפחות ${settings.quietFormMinInquiries} פניות ב-4 השבועות שלפני השבוע האחרון, ${quietFormWeeksText(settings.quietFormMinInquiries)}, ובשבוע האחרון לא קיבל אף פנייה.`;
    case "campaign_jump":
      return `קמפיין או מקור שבחודש שעבר העלות לפנייה שלו עלתה לפחות ב-${settings.campaignJumpPercent}% לעומת 3 החודשים שלפניו. רק בחבילה עם עלויות קמפיין.`;
  }
}
