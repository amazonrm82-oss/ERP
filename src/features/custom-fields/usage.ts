/**
 * FLD (owner, 9 November 2026): why a custom field cannot be deleted. The reasons are the codes of
 * app.custom_field_uses / public.custom_field_usage (migration custom_field_delete); the database refuses
 * a person's delete while any of them holds (hint custom_field:in_use). This file only words them.
 */

export const FIELD_USE_REASONS = [
  "values",
  "files",
  "condition",
  "lead_score",
  "automation",
  "conversion",
  "form",
  "card_layout",
  "completeness",
  "saved_view",
  "segment",
  "routing_rule",
] as const;
export type FieldUseReason = (typeof FIELD_USE_REASONS)[number];

export const VALUES_LINE = "אי אפשר למחוק: יש ערכים שמורים — אפשר להסתיר";
export const FILES_LINE = "אי אפשר למחוק: יש קבצים שמורים בשדה — אפשר להסתיר";
const HIDE_HINT = " — אפשר להסתיר";
/** The page could not read what the fields are used for: every "מחיקה" is off. */
export const USAGE_UNKNOWN_LINE = "לא הצלחנו לבדוק אם השדה בשימוש, ולכן אי אפשר למחוק כרגע. רעננו את הדף.";

/** Where the field is used, each written with its "ב" prefix. */
export const FIELD_USE_PLACES: Record<Exclude<FieldUseReason, "values" | "files">, string> = {
  condition: "בתנאי של שדה אחר",
  lead_score: "בניקוד לידים",
  automation: "באוטומציה",
  conversion: "בהעברת שדות בהמרת ליד",
  form: "בטופס לידים",
  card_layout: "בסידור הכרטיס",
  completeness: "בהגדרת שלמות הרשומה",
  saved_view: "בתצוגה שמורה",
  segment: "בפילוח",
  routing_rule: "בכלל חלוקת לידים",
};

export function isFieldUseReason(value: unknown): value is FieldUseReason {
  return typeof value === "string" && (FIELD_USE_REASONS as readonly string[]).includes(value);
}

/** "א", "א וב", "א, ב וג" (Hebrew "ו" sticks to the last word). */
function joinPlaces(places: string[]): string {
  if (places.length <= 1) return places.join("");
  return `${places.slice(0, -1).join(", ")} ו${places[places.length - 1]}`;
}

/**
 * The line under a disabled "מחיקה": stored values first (the most common case, and the owner's wording),
 * then stored files, then every other place the field is used. Null = the field may be deleted.
 * Unknown codes (a newer database) still block, with a general line. A field that is already hidden is not told
 * it may be hidden.
 */
export function fieldDeleteBlockedText(reasons: readonly string[], options: { hidden?: boolean } = {}): string | null {
  if (reasons.length === 0) return null;
  const line = (text: string) => (options.hidden && text.endsWith(HIDE_HINT) ? text.slice(0, -HIDE_HINT.length) : text);
  if (reasons.includes("values")) return line(VALUES_LINE);
  if (reasons.includes("files")) return line(FILES_LINE);
  const places = FIELD_USE_REASONS.filter((r): r is keyof typeof FIELD_USE_PLACES => r in FIELD_USE_PLACES && reasons.includes(r)).map(
    (r) => FIELD_USE_PLACES[r],
  );
  if (places.length === 0) return line(`אי אפשר למחוק: השדה בשימוש${HIDE_HINT}`);
  return line(`אי אפשר למחוק: השדה משמש ${joinPlaces(places)}${HIDE_HINT}`);
}

/** The reasons of public.custom_field_usage's answer, by field id. A malformed answer gives nothing. */
export function parseFieldUsage(data: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!data || typeof data !== "object" || Array.isArray(data)) return out;
  for (const [fieldId, list] of Object.entries(data as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const reasons = list
      .map((item) => (item && typeof item === "object" ? (item as { reason?: unknown }).reason : null))
      .filter((r): r is string => typeof r === "string");
    if (reasons.length > 0) out[fieldId] = reasons;
  }
  return out;
}
