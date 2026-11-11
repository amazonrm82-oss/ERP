import type { DocumentRecordType } from "@/features/document-templates/fields";
import { byGender, withPrefixThe, type TermForms } from "@/features/terminology/terms";

// RVW-83 (interim, until a conversion moves a lead's documents): a contact's card also lists the documents for signature of
// the leads converted into it (leads.converted_contact_id), read with the user's session, so RLS still decides each row.

const COLUMN: Record<DocumentRecordType, "lead_id" | "contact_id" | "company_id" | "deal_id"> = {
  lead: "lead_id",
  contact: "contact_id",
  company: "company_id",
  deal: "deal_id",
};

/** At most this many converted leads are looked at for one contact (the newest conversions; the caller orders them). */
export const CONVERTED_LEADS_MAX = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RecordDocumentsFilter = { kind: "eq"; column: (typeof COLUMN)[DocumentRecordType]; value: string } | { kind: "or"; filter: string };

/** The PostgREST filter for a record's documents: its own column, and for a contact also its converted leads' documents. */
export function recordDocumentsFilter(kind: DocumentRecordType, recordId: string, convertedLeadIds: readonly string[] = []): RecordDocumentsFilter {
  const leads = kind === "contact" ? [...new Set(convertedLeadIds.filter((id) => UUID.test(id)))].slice(0, CONVERTED_LEADS_MAX) : [];
  if (leads.length === 0 || !UUID.test(recordId)) return { kind: "eq", column: COLUMN[kind], value: recordId };
  return { kind: "or", filter: `contact_id.eq.${recordId},lead_id.in.(${leads.join(",")})` };
}

/**
 * The note on a contact's card when more leads were converted into it than are looked at: their documents come from the
 * newest CONVERTED_LEADS_MAX converted leads (the business's words, FLD-10).
 */
export function convertedLeadsNote(lead: TermForms, contact: TermForms): string {
  return `מוצגים מסמכים של ${CONVERTED_LEADS_MAX} ${lead.thePlural} ${byGender(lead, "האחרונים", "האחרונות")} שהומרו ${withPrefixThe("ל", contact)} ${byGender(contact, "הזה", "הזאת")}`;
}

/** The line under a document that was sent while the contact was still a lead (the business's word for a lead, FLD-10). */
export function fromLeadLine(leadSingular: string): string {
  return `נשלח לפני ההמרה, כשהרשומה הייתה ${leadSingular}.`;
}
