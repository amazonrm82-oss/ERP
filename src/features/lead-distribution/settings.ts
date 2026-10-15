import { localeLabel } from "@/features/contacts/preferences";

// Lead distribution (CAP-08), as public.lead_distribution_settings and
// public.lead_routing_rules hold it. Keep the methods, the weight range and the rule cap in
// step with migration lead_distribution (a unit test reads it).

export const DISTRIBUTION_METHODS = ["round_robin", "weighted", "load"] as const;
export type DistributionMethod = (typeof DISTRIBUTION_METHODS)[number];
export const DEFAULT_METHOD: DistributionMethod = "round_robin";

export const WEIGHT_MIN = 1;
export const WEIGHT_MAX = 10;
export const DEFAULT_WEIGHT = 1;

export const RULES_MAX = 50;

// A rule's target in the form: "team:<id>" or "user:<id>"; a field condition: "<key>|<option>".
export const TARGET_TEAM = "team:";
export const TARGET_USER = "user:";
export const FIELD_SEPARATOR = "|";

// The plan key that opens weights, load and rules (from "בסיס" up, owner 14 October 2026).
export const DISTRIBUTION_FEATURE = "lead_distribution";

export type Weights = Record<string, number>;
export type DistributionSettings = { method: DistributionMethod; weights: Weights };

export const DEFAULT_DISTRIBUTION: DistributionSettings = { method: DEFAULT_METHOD, weights: {} };

export const METHOD_OPTIONS: { value: DistributionMethod; label: string; description: string }[] = [
  {
    value: "round_robin",
    label: "סבב שווה",
    description: "כל ליד הולך למי שקיבל ליד הכי מזמן. כולם מקבלים בערך אותו מספר לידים.",
  },
  {
    value: "weighted",
    label: "לפי משקל",
    description: "מי שהמשקל שלו 2 מקבל פי שניים לידים ממי שהמשקל שלו 1. מי שחוזר מחופשה או מצטרף לא מקבל את כל הלידים כדי \"להשלים\".",
  },
  {
    value: "load",
    label: "לפי עומס פתוח",
    description: "כל ליד הולך למי שיש לו הכי מעט לידים פתוחים ביחס למשקל שלו. ליד פתוח: בסטטוס פתוח, לא הומר ולא בסל המחזור.",
  },
];

export function isDistributionMethod(value: unknown): value is DistributionMethod {
  return typeof value === "string" && (DISTRIBUTION_METHODS as readonly string[]).includes(value);
}

export function isWeight(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= WEIGHT_MIN && value <= WEIGHT_MAX;
}

/** A row of the table (or none) as the screen uses it; an unknown method or weight reads as the default. */
export function distributionSettingsFrom(row: { method: string; weights: unknown } | null): DistributionSettings {
  if (!row) return DEFAULT_DISTRIBUTION;
  const weights: Weights = {};
  if (row.weights && typeof row.weights === "object" && !Array.isArray(row.weights)) {
    for (const [userId, weight] of Object.entries(row.weights as Record<string, unknown>)) {
      if (isWeight(weight)) weights[userId] = weight;
    }
  }
  return { method: isDistributionMethod(row.method) ? row.method : DEFAULT_METHOD, weights };
}

/** A member's weight: their entry, else 1 (app.distribution_weight). */
export function weightOf(weights: Weights, userId: string): number {
  return isWeight(weights[userId]) ? weights[userId] : DEFAULT_WEIGHT;
}

/** What is saved: only weights other than the default, for the members on the screen. */
export function weightsToSave(entries: [string, number][]): Weights {
  const weights: Weights = {};
  for (const [userId, weight] of entries) {
    if (isWeight(weight) && weight !== DEFAULT_WEIGHT) weights[userId] = weight;
  }
  return weights;
}

/** The method the distribution really uses: without the plan key, the plain round robin. */
export function effectiveMethod(method: DistributionMethod, hasFeature: boolean): DistributionMethod {
  return hasFeature ? method : DEFAULT_METHOD;
}

export function methodLabel(method: DistributionMethod): string {
  return METHOD_OPTIONS.find((option) => option.value === method)?.label ?? "";
}

export type RoutingRule = {
  id: string;
  position: number;
  isActive: boolean;
  sourceId: string | null;
  productId: string | null;
  // follow-ups (owner, 14 October 2026): a language, and a list field of leads with one of its options
  locale: string | null;
  fieldKey: string | null;
  fieldValue: string | null;
  // a team or one person, exactly one of the two
  teamId: string | null;
  userId: string | null;
};

type ConditionNames = { source?: string; product?: string; field?: string };

/** "ליד מהמקור X שמבקש את המוצר Y" in words; a missing name reads as "שנמחק". */
export function ruleConditionText(
  rule: Pick<RoutingRule, "sourceId" | "productId"> & Partial<Pick<RoutingRule, "locale" | "fieldKey" | "fieldValue">>,
  names: ConditionNames = {},
): string {
  const parts: string[] = [];
  if (rule.sourceId) parts.push(`מהמקור "${names.source ?? "שנמחק"}"`);
  if (rule.productId) parts.push(`שמבקש את המוצר "${names.product ?? "שנמחק"}"`);
  if (rule.locale) parts.push(`שמעדיף ${localeLabel(rule.locale) ?? rule.locale}`);
  if (rule.fieldKey) parts.push(`שב"${names.field ?? "שדה שנמחק"}" נבחר "${rule.fieldValue ?? ""}"`);
  return `ליד ${parts.join(" ו")}`;
}

/** Where the rule sends the lead, in words. */
export function ruleTargetText(rule: Pick<RoutingRule, "teamId" | "userId">, names: { team?: string; user?: string }): string {
  return rule.userId ? `הולך ל${names.user ?? "משתמש שעזב"}` : `נכנס לצוות "${names.team ?? "שנמחק"}"`;
}

/** Who may get leads at all (the round robin's own rule; app.lead_distribution_pick). */
export function takesLeads(member: { role: string; seatType: string; status: string }): boolean {
  return member.status === "active" && member.role !== "viewer" && member.seatType === "full";
}

/** Where the rules apply, in plain words. */
export const RULES_SCOPE_NOTE =
  "הכללים חלים על לידים שמחולקים אוטומטית: מטופס או חיבור שמחלק בסבב, ומאוטומציה שמשייכת בסבב. הכלל הראשון ברשימה שמתאים לליד קובע לאן הוא הולך: לצוות, ובתוכו לפי השיטה שנבחרה, או לאדם אחד. אם האדם נעדר, הליד הולך לממלא המקום שלו, ואם אין, הוא נשאר בלי אחראי וכל הצוות מקבל התראה. ליד שאף כלל לא מתאים לו מחולק כמו היום, בצוות של הטופס.";

// Forms do not send a requested product yet (a LEAD-04 follow-up), so a product rule matches
// only leads that an automation distributes.
export const RULES_PRODUCT_NOTE = "כלל לפי מוצר חל רק על לידים מאוטומציות.";

// A person rule asks neither the person's seat type, availability nor working hours: like a
// form's fixed owner and HEB-08's automatic assignment of a fixed person, only an active member
// who is not a viewer, and the leave rules (a deputy, else no owner).
