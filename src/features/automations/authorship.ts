// PRM-01: who made a rule and who changed it last, for the rule page. Rules from before the
// column existed keep updated_by empty until their next edit (owner, 15 October 2026: no
// backfill, never guessed from the creator), shown as "לא ידוע".

export const UNKNOWN_PERSON = "לא ידוע";

export function ruleAuthorshipLine(createdBy: string | null, updatedBy: string | null, names: Map<string, string>): string {
  const name = (id: string | null) => (id ? (names.get(id) ?? "משתמש") : UNKNOWN_PERSON);
  const parts = createdBy ? [`נוצרה על ידי: ${name(createdBy)}`] : [];
  parts.push(`שונתה לאחרונה על ידי: ${name(updatedBy)}`);
  return parts.join(" · ");
}
