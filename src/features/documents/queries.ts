import "server-only";

import { cache } from "react";

import { canRecordDocuments } from "@/features/permissions/keys";
import { getMyPermissions } from "@/features/permissions/queries";
import { orgHasFeature } from "@/features/settings/queries";
import { getOrgContext, getUserNames } from "@/features/shell/queries";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { isDocumentType, type DocumentType } from "./schema";

// DOC-01: the accounting documents recorded on a deal or a contact, read with the user's session (RLS: whoever reads the
// deal, else the contact).

export type AccountingDocument = {
  id: string;
  docType: DocumentType;
  number: string;
  docDate: string;
  amountAgorot: number;
  cancelled: boolean;
  cancelReason: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  createdBy: string | null;
  createdAt: string;
};

export type DocumentsSubject = { kind: "deal" | "contact"; id: string };

/** Whether the documents capability is in the plan, and whether the user may record (owners, admins, managers, the key). */
export const getDocumentsAccess = cache(async (orgId: string): Promise<{ inPlan: boolean; canRecord: boolean }> => {
  const [inPlan, context, granted] = await Promise.all([orgHasFeature(orgId, "documents"), getOrgContext(orgId), getMyPermissions(orgId)]);
  return { inPlan, canRecord: inPlan && context.canWrite && canRecordDocuments(context.role, granted) };
});

/** The record's documents, newest first (at most 100), with the names of who recorded or cancelled them. */
export async function listRecordDocuments(orgId: string, subject: DocumentsSubject): Promise<{ documents: AccountingDocument[]; names: Map<string, string> }> {
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("accounting_documents")
      .select("id, doc_type, number, doc_date, amount_agorot, status, cancel_reason, cancelled_at, cancelled_by, created_by, created_at")
      .eq("organization_id", orgId)
      .eq(subject.kind === "deal" ? "deal_id" : "contact_id", subject.id)
      .order("doc_date", { ascending: false })
      .order("created_at", { ascending: false })
      .order("id")
      .limit(100),
    "accounting documents",
  );
  const documents = rows.flatMap((row): AccountingDocument[] =>
    isDocumentType(row.doc_type)
      ? [
          {
            id: row.id,
            docType: row.doc_type,
            number: row.number,
            docDate: row.doc_date,
            amountAgorot: Number(row.amount_agorot),
            cancelled: row.status === "cancelled",
            cancelReason: row.cancel_reason,
            cancelledAt: row.cancelled_at,
            cancelledBy: row.cancelled_by,
            createdBy: row.created_by,
            createdAt: row.created_at,
          },
        ]
      : [],
  );
  const names = await getUserNames(documents.flatMap((d) => [d.createdBy, d.cancelledBy]));
  return { documents, names };
}
