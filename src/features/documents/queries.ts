import "server-only";

import { cache } from "react";

import { canRecordDocuments } from "@/features/permissions/keys";
import { getMyPermissions } from "@/features/permissions/queries";
import { orgHasFeature } from "@/features/settings/queries";
import { versionGroups } from "@/features/files/versions";
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

/** DOC-01 follow-up: a document's file, as shown. */
export type DocumentFile = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string | null;
  createdAt: string;
};

/** A document's current file (null while its only upload still waits) and its earlier versions, newest first. */
export type DocumentFiles = { current: DocumentFile | null; earlier: DocumentFile[]; latestId: string };

/**
 * The files of these documents that the user may see (RLS follows each document). The history is read from every row,
 * a waiting upload included, so the line never breaks; only confirmed files are shown. `latestId` is the newest row of the
 * line (it may still be waiting): a new file names it, and the database links the new one after it.
 */
export async function listDocumentFiles(orgId: string, documentIds: string[]): Promise<{ files: Map<string, DocumentFiles>; names: Map<string, string> }> {
  const files = new Map<string, DocumentFiles>();
  if (documentIds.length === 0) return { files, names: new Map() };
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("files")
      .select("id, name, mime_type, size_bytes, uploaded_by, created_at, previous_id, accounting_document_id, unconfirmed_since")
      .eq("organization_id", orgId)
      .in("accounting_document_id", documentIds)
      .order("created_at", { ascending: true })
      .order("id")
      .limit(1000),
    "document files",
  );
  for (const documentId of documentIds) {
    const own = rows.filter((r) => r.accounting_document_id === documentId);
    const [group] = versionGroups(own.map((r) => ({ ...r, previousId: r.previous_id, createdAt: r.created_at })));
    if (!group) continue;
    const line = [group.current, ...group.earlier];
    const shown = line
      .filter((r) => r.unconfirmed_since === null)
      .map((r): DocumentFile => ({ id: r.id, name: r.name, mimeType: r.mime_type, sizeBytes: r.size_bytes, uploadedBy: r.uploaded_by, createdAt: r.created_at }));
    files.set(documentId, { current: shown[0] ?? null, earlier: shown.slice(1), latestId: group.current.id });
  }
  const names = await getUserNames(rows.map((r) => r.uploaded_by));
  return { files, names };
}

