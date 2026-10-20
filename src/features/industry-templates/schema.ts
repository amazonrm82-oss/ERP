import { z } from "zod";

import { INDUSTRY_TEMPLATES } from "./templates";

export const templateKeyArg = z.enum(INDUSTRY_TEMPLATES.map((t) => t.industry) as [string, ...string[]]);

export type ApplyResult = {
  added: { pipelines: number; stages: number; statuses: number; sources: number; fields: number; automations: number; products: number };
  limits: string[];
};

const count = z.number().int().min(0);

/** The answer of public.apply_industry_template(), checked before it is shown. */
export const applyResultSchema = z.object({
  // products: FLD-05 sample products (0 without the product catalog in the plan)
  added: z.object({ pipelines: count, stages: count, statuses: count, sources: count, fields: count, automations: count, products: count }),
  limits: z.array(z.string()),
});

const LIMIT_NAMES: Record<string, string> = {
  "limit:max_pipelines": "תהליך המכירה",
  "limit:max_custom_fields_per_object": "חלק מהשדות",
  "limit:max_products": "חלק מהמוצרים לדוגמה",
};

/** One or two short Hebrew sentences that say what applying added, and what a plan limit left out. */
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
  ].filter((p): p is string => p !== null);
  const added = parts.length > 0 ? `נוספו: ${parts.join(", ")}.` : "לא נוסף דבר: כל מה שבתבנית כבר קיים אצלכם.";
  const missed = result.limits.map((hint) => LIMIT_NAMES[hint] ?? "פריטים נוספים");
  return missed.length > 0 ? `${added} חלק מהתבנית לא נוסף בגלל מגבלת החבילה: ${missed.join("; ")}.` : added;
}
