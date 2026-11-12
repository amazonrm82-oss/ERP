import { z } from "zod";

import { ALL_TEMPLATES } from "./kits";

export const templateKeyArg = z.enum(ALL_TEMPLATES.map((t) => t.industry) as [string, ...string[]]);

export type ApplyResult = {
  added: {
    pipelines: number;
    stages: number;
    statuses: number;
    sources: number;
    fields: number;
    automations: number;
    products: number;
    // VRT-01: a kit's extras (0 for an FLD-05 template)
    meeting_types: number;
    message_templates: number;
    whatsapp_templates: number;
    forms: number;
    views: number;
  };
  limits: string[];
};

const count = z.number().int().min(0);

/** The answer of public.apply_industry_template(), checked before it is shown. */
export const applyResultSchema = z.object({
  // products: FLD-05 sample products (0 without the product catalog in the plan)
  added: z.object({
    pipelines: count,
    stages: count,
    statuses: count,
    sources: count,
    fields: count,
    automations: count,
    products: count,
    // VRT-01: a kit's extras
    meeting_types: count.default(0),
    message_templates: count.default(0),
    whatsapp_templates: count.default(0),
    forms: count.default(0),
    views: count.default(0),
  }),
  limits: z.array(z.string()),
});

const LIMIT_NAMES: Record<string, string> = {
  "limit:max_pipelines": "תהליך המכירה",
  "limit:max_custom_fields_per_object": "חלק מהשדות",
  "limit:max_products": "חלק מהמוצרים לדוגמה",
  // VRT-01: a kit's extras
  "limit:max_forms": "טופס הלידים",
};

// VRT-01, owner (351) ב: a business list of at most 50 that is full is not a plan limit
const FULL_LIST_NAMES: Record<string, string> = {
  "meeting_types:max": "סוגי הפגישות",
  "message_templates:max": "תבניות ההודעה",
  "whatsapp_templates:max": "תבניות הוואטסאפ",
};

/** Short Hebrew sentences that say what applying added, what a plan limit left out, and which full list took nothing more. */
export function describeApplyResult(result: ApplyResult): string {
  const a = result.added;
  const n = (value: number, one: string, many: string) => (value === 0 ? null : value === 1 ? one : `${value} ${many}`);
  const parts = [
    a.pipelines > 0 ? "תהליך מכירה" : null,
    n(a.stages, "שלב אחד", "שלבים"),
    n(a.statuses, "סטטוס אחד", "סטטוסים"),
    n(a.sources, "מקור אחד", "מקורות"),
    n(a.fields, "שדה אחד", "שדות"),
    a.automations > 0 ? `${n(a.automations, "אוטומציה אחת", "אוטומציות")} (כבויות, מפעילים אותן בהגדרות)` : null,
    a.products > 0 ? `${n(a.products, "מוצר אחד לדוגמה", "מוצרים לדוגמה")} (משנים מחיר או מעבירים לארכיון בקטלוג)` : null,
    n(a.meeting_types, "סוג פגישה אחד", "סוגי פגישות"),
    n(a.message_templates, "תבנית הודעה אחת", "תבניות הודעה"),
    n(a.whatsapp_templates, "תבנית וואטסאפ אחת", "תבניות וואטסאפ"),
    a.forms > 0 ? "טופס לידים (כבוי, מפעילים אותו בהגדרות הטפסים)" : null,
    n(a.views, "תצוגה שמורה אחת", "תצוגות שמורות"),
  ].filter((p): p is string => p !== null);
  const added = parts.length > 0 ? `נוספו: ${parts.join(", ")}.` : "לא נוסף דבר: כל מה שבתבנית כבר קיים אצלכם.";
  const full = result.limits.filter((hint) => hint in FULL_LIST_NAMES).map((hint) => FULL_LIST_NAMES[hint]);
  const missed = result.limits.filter((hint) => !(hint in FULL_LIST_NAMES)).map((hint) => LIMIT_NAMES[hint] ?? "פריטים נוספים");
  const sentences = [added];
  if (missed.length > 0) sentences.push(`חלק מהתבנית לא נוסף בגלל מגבלת החבילה: ${missed.join("; ")}.`);
  if (full.length > 0) sentences.push(`לא נוסף: הרשימה מלאה (50) ב${full.join(", ב")}.`);
  return sentences.join(" ");
}
