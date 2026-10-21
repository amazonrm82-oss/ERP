import "server-only";

import { cache } from "react";

import { canRecordDocuments } from "@/features/permissions/keys";
import { getMyPermissions } from "@/features/permissions/queries";
import { orgHasFeature } from "@/features/settings/queries";
import { getOrgContext, getUserNames } from "@/features/shell/queries";
import { MONEY_SUBJECT_COLUMN, type MoneySubject } from "@/features/payments/money-subject";
import { must } from "@/lib/db-read";
import { readAllPages, readAllPagesByIds } from "@/lib/paged-read";
import { PAGE_SIZE } from "@/lib/search";
import { createClient } from "@/lib/supabase/server";

import { DOCUMENT_DEFAULT_SORT, DOCUMENT_SORT_COLUMNS, documentTotalsByType, type DocumentListFilters } from "./list";
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

export type DocumentsSubject = MoneySubject;

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
      .eq(MONEY_SUBJECT_COLUMN[subject.kind], subject.id)
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

// ----------------------------------------------------------------------------
// LST-09: the business-wide list of documents
// ----------------------------------------------------------------------------

export type DocumentListItem = {
  id: string;
  docType: DocumentType;
  number: string;
  docDate: string;
  amountAgorot: number;
  cancelled: boolean;
  createdBy: string | null;
  createdAt: string;
  dealId: string | null;
  contactId: string | null;
  // the rule of public.sort_customer(accounting_documents): the contact's name, else the deal's
  customer: string | null;
};

/**
 * LST-09: the documents of the business the user reads (the documents of deals and contacts they read), filtered by the
 * list's selects and the advanced filter, sorted by any column; one page at a time, the picked rows, or an export chunk.
 * Read with the user's session: the accounting_documents RLS decides.
 */
export async function listDocuments(orgId: string, filters: DocumentListFilters): Promise<{ documents: DocumentListItem[]; hasMore: boolean }> {
  const supabase = await createClient();
  const size = filters.chunk?.size ?? PAGE_SIZE;
  const offset = filters.chunk?.from ?? (filters.page - 1) * PAGE_SIZE;
  let query = supabase
    .from("accounting_documents")
    .select("id, doc_type, number, doc_date, amount_agorot, status, created_by, created_at, deal_id, contact_id")
    .eq("organization_id", orgId);
  if (filters.ids) {
    query = query.in("id", filters.ids);
  } else {
    if (filters.type) query = query.eq("doc_type", filters.type);
    if (filters.status) query = query.eq("status", filters.status);
    if (filters.from) query = query.gte("doc_date", filters.from);
    if (filters.to) query = query.lte("doc_date", filters.to);
    if (filters.filter) query = query.or(filters.filter);
  }
  const sort = filters.sort ?? DOCUMENT_DEFAULT_SORT;
  const rows = must(
    await query
      .order(DOCUMENT_SORT_COLUMNS[sort.key], { ascending: sort.ascending, nullsFirst: false })
      .order("created_at", { ascending: false })
      .order("id")
      .range(offset, offset + size),
    "documents list",
  );
  const page = rows.slice(0, size);
  const customers = await customerNames(orgId, page);
  return {
    hasMore: rows.length > size,
    documents: page.flatMap((row): DocumentListItem[] =>
      isDocumentType(row.doc_type)
        ? [
            {
              id: row.id,
              docType: row.doc_type,
              number: row.number,
              docDate: row.doc_date,
              amountAgorot: Number(row.amount_agorot),
              cancelled: row.status === "cancelled",
              createdBy: row.created_by,
              createdAt: row.created_at,
              dealId: row.deal_id,
              contactId: row.contact_id,
              customer: customers(row),
            },
          ]
        : [],
    ),
  };
}

// the totals read at most this many documents; past it the screen says the totals are partial
export const DOCUMENT_TOTALS_LIMIT = 20_000;

/**
 * LST-09 (owner, 21 October 2026): the list's totals per document type, over every document the filters find (not only
 * the page), documents in force only, never netted. Read with the user's session, like the list.
 */
export async function listDocumentTotals(
  orgId: string,
  filters: DocumentListFilters,
): Promise<{ totals: Map<DocumentType, { count: number; agorot: number }>; complete: boolean }> {
  const supabase = await createClient();
  const { rows, complete } = await readAllPages(
    async (from, to) => {
      let query = supabase.from("accounting_documents").select("id, doc_type, amount_agorot, status").eq("organization_id", orgId).eq("status", "active");
      if (filters.type) query = query.eq("doc_type", filters.type);
      if (filters.status) query = query.eq("status", filters.status);
      if (filters.from) query = query.gte("doc_date", filters.from);
      if (filters.to) query = query.lte("doc_date", filters.to);
      if (filters.filter) query = query.or(filters.filter);
      return must(await query.order("id").range(from, to), "documents totals");
    },
    { limit: DOCUMENT_TOTALS_LIMIT },
  );
  return {
    complete,
    totals: documentTotalsByType(
      rows.flatMap((row) => (isDocumentType(row.doc_type) ? [{ docType: row.doc_type, amountAgorot: Number(row.amount_agorot), cancelled: row.status !== "active" }] : [])),
    ),
  };
}

/**
 * The names of the contacts and deals of a page of rows (RLS: only those the user reads): the contact's, else the deal's
 * (the rule of public.sort_customer on accounting_documents and payments). Shared with the payments list.
 */
export async function customerNames(orgId: string, rows: readonly { deal_id: string | null; contact_id: string | null }[]) {
  const supabase = await createClient();
  const contactIds = [...new Set(rows.flatMap((row) => (row.contact_id ? [row.contact_id] : [])))];
  const dealIds = [...new Set(rows.flatMap((row) => (row.deal_id ? [row.deal_id] : [])))];
  const [contacts, deals] = await Promise.all([
    contactIds.length > 0
      ? readAllPagesByIds(contactIds, async (slice, from, to) =>
          must(await supabase.from("contacts").select("id, full_name").eq("organization_id", orgId).in("id", slice).order("id").range(from, to), "list contacts"),
        )
      : [],
    dealIds.length > 0
      ? readAllPagesByIds(dealIds, async (slice, from, to) =>
          must(await supabase.from("deals").select("id, name").eq("organization_id", orgId).in("id", slice).order("id").range(from, to), "list deals"),
        )
      : [],
  ]);
  const contactNames = new Map(contacts.map((row) => [row.id, row.full_name]));
  const dealNames = new Map(deals.map((row) => [row.id, row.name]));
  return (row: { deal_id: string | null; contact_id: string | null }) =>
    (row.contact_id ? contactNames.get(row.contact_id) : undefined) ?? (row.deal_id ? dealNames.get(row.deal_id) : undefined) ?? null;
}
