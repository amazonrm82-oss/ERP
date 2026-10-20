// FLD-10 part three: timeline entries the app draws itself, in the business's words (pure; unit tested).

import { byGender, type OrgTerms } from "@/features/terminology/terms";

/**
 * SPD-03: a lead nobody answered in time went to the next rep (app.check_lead_responses writes the entry with
 * metadata {from_user_id, to_user_id, target_minutes}). Drawn from the metadata; null = keep the stored text.
 */
export function responsePassText(
  meta: { fromUserId: string | null; toUserId: string | null; targetMinutes: number | null },
  names: ReadonlyMap<string, string>,
  terms: OrgTerms,
): string | null {
  const target = meta.targetMinutes;
  if (target === null || !Number.isInteger(target) || target <= 0) return null;
  const from = meta.fromUserId ? names.get(meta.fromUserId) : undefined;
  const to = meta.toUserId ? names.get(meta.toUserId) : undefined;
  const lead = terms.lead;
  return `${lead.theSingular} ${byGender(lead, "הועבר", "הועברה")}${from ? ` מ${from}` : ""}${to ? ` ל${to}` : ""} כי לא נוצר קשר בתוך ${target} דקות`;
}

/** A lead converted to a contact. */
export function conversionText(terms: OrgTerms): string {
  return `${terms.lead.theSingular} ${byGender(terms.lead, "הומר", "הומרה")} ל${terms.contact.singular}.`;
}

/** A deal moved to another stage (the stage names when both are known). */
export function stageChangeText(from: string | undefined, to: string | undefined, terms: OrgTerms): string {
  const moved = `${terms.deal.theSingular} ${byGender(terms.deal, "עבר", "עברה")}`;
  return from && to ? `${moved} מהשלב "${from}" לשלב "${to}".` : `${moved} שלב.`;
}
