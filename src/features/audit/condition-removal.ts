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
