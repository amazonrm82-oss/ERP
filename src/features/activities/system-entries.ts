// FLD-10 part three: timeline entries the app draws itself, in the business's words (pure; unit tested).

import { byGender, type OrgTerms } from "@/features/terminology/terms";
import { recordTypeNames } from "@/lib/record-types";

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

/** The record types a record link field may point at (FLD-06 part B). */
const LINK_TARGET_TYPES = ["lead", "contact", "company", "deal"] as const;

/**
 * FLD-06 part B follow-up (owner, 26 October 2026): a record link emptied because its target was purged
 * (app.record_links_clear_ids writes metadata {kind: record_link_removed, field_key, target_type}). The target's type in the
 * business's words, never the removed record's name; null = keep the stored text.
 */
export function recordLinkRemovedText(targetType: string | null, terms: OrgTerms): string | null {
  if (!targetType || !(LINK_TARGET_TYPES as readonly string[]).includes(targetType)) return null;
  const { singular } = recordTypeNames(targetType as (typeof LINK_TARGET_TYPES)[number], terms);
  return `הקישור ל-${singular} הוסר: הרשומה נמחקה`;
}
