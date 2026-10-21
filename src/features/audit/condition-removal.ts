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
export function auditEntryNote(action: string, changes: Json): string | null {
  const removal = conditionRemovalNote(action, changes);
  if (removal) return removal;
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return null;
  if (action === "quote_link" || action === "order_link") {
    if (changes.link === "created") return "נוצר קישור חדש ללקוח (קישור קודם, אם היה, הפסיק לעבוד)";
    if (changes.link === "revoked") return "הקישור ללקוח בוטל";
    return null;
  }
  if (action === "person_erase" && typeof changes.reason === "string" && changes.reason.trim() !== "") {
    return `סיבה: ${changes.reason.trim()}`;
  }
  return null;
}
