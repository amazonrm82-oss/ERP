import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { isDocumentRecordType, type DocumentRecordType } from "./fields";
import { isDocumentKind, type DocumentKind } from "./templates";

export type DocumentTemplate = {
  id: string;
  name: string;
  kind: DocumentKind;
  recordType: DocumentRecordType;
  body: string;
  isActive: boolean;
  /** a seeded default whose wording no person changed: shown as a draft */
  draftWording: boolean;
  /** SGN-04: months a signed document is valid (null = none) */
  defaultValidityMonths: number | null;
};

/** Every document template of the business (SGN-01), by name, with the user's session (members read). */
export async function listDocumentTemplates(orgId: string): Promise<DocumentTemplate[]> {
  const supabase = await createClient();
  const rows =
    must(
      await supabase
        .from("document_templates")
        .select("id, name, kind, record_type, body, is_active, draft_wording, default_validity_months")
        .eq("organization_id", orgId)
        .order("name", { ascending: true })
        .order("id", { ascending: true }),
      "document templates",
    ) ?? [];
  // the table's checks hold the same closed lists; a row outside them (none can exist) is skipped
  return rows.flatMap((row) => {
    if (!isDocumentKind(row.kind) || !isDocumentRecordType(row.record_type)) return [];
    return [
      {
        id: row.id,
        name: row.name,
        kind: row.kind,
        recordType: row.record_type,
        body: row.body,
        isActive: row.is_active,
        draftWording: row.draft_wording,
        defaultValidityMonths: row.default_validity_months,
      },
    ];
  });
}
