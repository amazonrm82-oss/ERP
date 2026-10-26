import { byGender, DEFAULT_TERMS, type OrgTerms } from "@/features/terminology/terms";
import type { Json } from "@/lib/database.types";

/**
 * FLD-09 pipeline part B: the entry app.pipeline_conditions_cleanup() writes when a deleted pipeline took
 * conditions with it (action 'conditions_removed', changes {"fields": [{key, label, removed}]}), as one line
 * for the activity log. Null for any other entry or a shape it does not know.
 */
export function conditionRemovalNote(action: string, changes: Json): string | null {
  if (action !== "conditions_removed" || !changes || typeof changes !== "object" || Array.isArray(changes)) return null;
  const fields = changes.fields;
  if (!Array.isArray(fields)) return null;
  const labels = fields.flatMap((field) => {
    if (!field || typeof field !== "object" || Array.isArray(field)) return [];
    const label = typeof field.label === "string" && field.label !== "" ? field.label : typeof field.key === "string" ? field.key : null;
    return label ? [`"${label}"`] : [];
  });
  if (labels.length === 0) return null;
  return `תהליך המכירה נמחק; תנאים הוסרו משדות: ${labels.join(", ")}`;
}

/**
 * RVW-50: one line for entries whose details are not {old, new} pairs: a customer link of a quote or an order
 * (actions 'quote_link' / 'order_link', changes {"link": "created" | "revoked"}) and a person's removal (action
 * 'person_erase', changes {reason, counts}: the reason the owner or admin gave). Null for any other entry.
 */
export function auditEntryNote(action: string, changes: Json, terms: OrgTerms = DEFAULT_TERMS): string | null {
  const removal = conditionRemovalNote(action, changes);
  if (removal) return removal;
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return null;
  if (action === "quote_link" || action === "order_link") {
    if (changes.link === "created") return "נוצר קישור חדש ללקוח (קישור קודם, אם היה, הפסיק לעבוד)";
    if (changes.link === "revoked") return "הקישור ללקוח בוטל";
    return null;
  }
  if (action === "retention_policy") return retentionPolicyNote(changes);
  if (action === "retention_purge" && typeof changes.count === "number") {
    // in the business's own words (FLD-10)
    const lead = terms.lead;
    return changes.count === 1 ? `המדיניות מחקה ${lead.singular} ${byGender(lead, "אחד", "אחת")}` : `המדיניות מחקה ${changes.count} ${lead.plural}`;
  }
  if (action === "person_erase" && typeof changes.reason === "string" && changes.reason.trim() !== "") {
    return `סיבה: ${changes.reason.trim()}`;
  }
  return null;
}

/** PRV-01: what a change of the retention policy did ("הופעלה: 12 חודשים", "כובתה", "שונתה מ-12 ל-18 חודשים"). */
function retentionPolicyNote(changes: { [key: string]: Json | undefined }): string | null {
  const months = typeof changes.months === "number" ? changes.months : null;
  const before = typeof changes.previous_months === "number" ? changes.previous_months : null;
  if (changes.enabled === false) return "המדיניות כובתה";
  if (changes.enabled !== true || months === null) return null;
  if (changes.previous_enabled === true && before !== null && before !== months) return `מספר החודשים שונה מ-${before} ל-${months}`;
  return `המדיניות הופעלה: ${months} חודשים בלי קשר`;
}
