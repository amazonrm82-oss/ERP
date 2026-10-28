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

import { z } from "zod";


import {
  DOCUMENT_DEFAULT_SORT,
  DOCUMENT_SORT_COLUMNS,
  DOCUMENT_TOTAL_KEYS,
  needsPayStateRead,
  type DocumentListFilters,
  type DocumentListSummary,
  type DocumentTotalKey,
} from "./list";
import { DOCUMENT_PAY_STATES, type DocumentPayState } from "./pay-state";
import { documentTitle, isDocumentType, type DocumentType } from "./schema";

// DOC-01: the accounting documents recorded on a deal or a contact, read with the user's session (RLS: whoever reads the
// deal, else the contact).

export type AccountingDocument = {
  id: string;
  docType: DocumentType;
  // GAP-12: null on an opening balance
  number: string | null;
  docDate: string;
  amountAgorot: number;
  // PAY-02: on a tax invoice, the proforma it bills
  proformaId: string | null;
  // PAY-02 answer 7
  dueDate: string | null;
  cancelled: boolean;
  cancelReason: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  createdBy: string | null;
  createdAt: string;
  // DOC-02 (null on documents recorded before it, or left empty)
  provider: string | null;
  allocationNumber: string | null;
  netAgorot: number | null;
  vatAgorot: number | null;
  vatRateBp: number | null;
  quoteId: string | null;
  originalDocumentId: string | null;
};

export type DocumentsSubject = MoneySubject;

const RECORD_COLUMNS =
  "id, doc_type, number, doc_date, amount_agorot, proforma_id, due_date, status, cancel_reason, cancelled_at, cancelled_by, created_by, created_at, provider, allocation_number, net_agorot, vat_agorot, vat_rate_bp, quote_id, original_document_id";

type RecordRow = {
  id: string;
  doc_type: string;
  number: string | null;
  doc_date: string;
  amount_agorot: number;
  proforma_id: string | null;
  due_date: string | null;
  status: string;
  cancel_reason: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  created_by: string | null;
  created_at: string;
  provider: string | null;
  allocation_number: string | null;
  net_agorot: number | null;
  vat_agorot: number | null;
  vat_rate_bp: number | null;
  quote_id: string | null;
  original_document_id: string | null;
};

const num = (value: number | null) => (value === null ? null : Number(value));

function documentFromRow(row: RecordRow, docType: DocumentType): AccountingDocument {
  return {
    id: row.id,
    docType,
    number: row.number,
    docDate: row.doc_date,
    amountAgorot: Number(row.amount_agorot),
    proformaId: row.proforma_id,
    dueDate: row.due_date,
    cancelled: row.status === "cancelled",
    cancelReason: row.cancel_reason,
    cancelledAt: row.cancelled_at,
    cancelledBy: row.cancelled_by,
    createdBy: row.created_by,
    createdAt: row.created_at,
    provider: row.provider,
    allocationNumber: row.allocation_number,
    netAgorot: num(row.net_agorot),
    vatAgorot: num(row.vat_agorot),
    vatRateBp: row.vat_rate_bp,
    quoteId: row.quote_id,
    originalDocumentId: row.original_document_id,
  };
}

/** DOC-02: a line of a recorded document, as stored. */
export type DocumentLine = {
  documentId: string;
  position: number;
  description: string;
  quantity: number;
  unitPriceAgorot: number;
  discountAgorot: number;
  vatExempt: boolean;
  totalAgorot: number;
};

/** DOC-02: the lines of these documents (RLS: whoever reads the document), in their order. */
export async function listDocumentLines(orgId: string, documentIds: string[]): Promise<Map<string, DocumentLine[]>> {
  const lines = new Map<string, DocumentLine[]>();
  if (documentIds.length === 0) return lines;
  const supabase = await createClient();
  const rows = await readAllPagesByIds(documentIds, async (slice, from, to) =>
    must(
      await supabase
        .from("accounting_document_lines")
        .select("id, document_id, position, description, quantity, unit_price_agorot, discount_agorot, vat_exempt, total_agorot")
        .eq("organization_id", orgId)
        .in("document_id", slice)
        .order("document_id")
        .order("position")
        .order("id")
        .range(from, to),
      "document lines",
    ),
  );
  for (const row of rows) {
    const list = lines.get(row.document_id) ?? [];
    list.push({
      documentId: row.document_id,
      position: row.position,
      description: row.description,
      quantity: Number(row.quantity),
      unitPriceAgorot: Number(row.unit_price_agorot),
      discountAgorot: Number(row.discount_agorot),
      vatExempt: row.vat_exempt,
      totalAgorot: Number(row.total_agorot),
    });
    lines.set(row.document_id, list);
  }
  for (const list of lines.values()) list.sort((a, b) => a.position - b.position);
  return lines;
}

/**
 * DOC-02: what a new document on this record may name: its accepted quotes (the source; a deal's or a contact's, at most 50)
 * and its tax invoices (a credit invoice's original), read with the user's session.
 */
export async function listDocumentSources(
  orgId: string,
  subject: DocumentsSubject,
  documents: readonly AccountingDocument[],
): Promise<{ quotes: { id: string; label: string }[]; originals: { id: string; label: string }[] }> {
  const originals = documents
    .filter((doc) => !doc.cancelled && (doc.docType === "tax_invoice" || doc.docType === "tax_invoice_receipt"))
    .map((doc) => ({ id: doc.id, label: documentTitle(doc) }));
  if (subject.kind === "order") return { quotes: [], originals };
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("quotes")
      .select("id, number_display, title")
      .eq("organization_id", orgId)
      .eq(subject.kind === "deal" ? "deal_id" : "contact_id", subject.id)
      .eq("status", "accepted")
      .order("created_at", { ascending: false })
      .order("id")
      .limit(50),
    "accepted quotes",
  );
  return {
    quotes: rows.map((row) => ({ id: row.id, label: `הצעה ${row.number_display ?? ""} ${row.title ? `· ${row.title}` : ""}`.replace(/\s+/g, " ").trim() })),
    originals,
  };
}

/**
 * Whether the documents capability is in the plan, whether the user may record (owners, admins, managers, the key), and
 * whether they may record and change an opening balance (GAP-12: owners and admins only).
 */
export const getDocumentsAccess = cache(async (orgId: string): Promise<{ inPlan: boolean; canRecord: boolean; canOpening: boolean }> => {
  const [inPlan, context, granted] = await Promise.all([orgHasFeature(orgId, "documents"), getOrgContext(orgId), getMyPermissions(orgId)]);
  const canRecord = inPlan && context.canWrite && canRecordDocuments(context.role, granted);
  return { inPlan, canRecord, canOpening: canRecord && (context.role === "owner" || context.role === "admin") };
});

/** The record's documents, newest first (at most 100), with the names of who recorded or cancelled them. */
export async function listRecordDocuments(orgId: string, subject: DocumentsSubject): Promise<{ documents: AccountingDocument[]; names: Map<string, string> }> {
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("accounting_documents")
      .select(RECORD_COLUMNS)
      .eq("organization_id", orgId)
      .eq(MONEY_SUBJECT_COLUMN[subject.kind], subject.id)
      .order("doc_date", { ascending: false })
      .order("created_at", { ascending: false })
      .order("id")
      .limit(100),
    "accounting documents",
  );
  const documents = rows.flatMap((row): AccountingDocument[] => (isDocumentType(row.doc_type) ? [documentFromRow(row, row.doc_type)] : []));
  const names = await getUserNames(documents.flatMap((d) => [d.createdBy, d.cancelledBy]));
  return { documents, names };
}

// ----------------------------------------------------------------------------
// LST-09: the business-wide list of documents
// ----------------------------------------------------------------------------

export type DocumentListItem = {
  id: string;
  docType: DocumentType;
  // GAP-12: null on an opening balance
  number: string | null;
  docDate: string;
  // PAY-02 answer 7 (DOC-03's overdue)
  dueDate: string | null;
  amountAgorot: number;
  cancelled: boolean;
  createdBy: string | null;
  createdAt: string;
  dealId: string | null;
  contactId: string | null;
  // GAP-12: a company's opening balance
  companyId: string | null;
  // the rule of public.sort_customer(accounting_documents): the contact's name, else the deal's, else the company's
  customer: string | null;
};

/**
 * LST-09: the documents of the business the user reads (the documents of deals and contacts they read), filtered by the
 * list's selects and the advanced filter, sorted by any column; one page at a time, the picked rows, or an export chunk.
 * Read with the user's session: the accounting_documents RLS decides.
 */
type Client = Awaited<ReturnType<typeof createClient>>;

/**
 * The list's rows with its selects applied: the table, or (DOC-03) the set public.documents_by_pay_state returns when a
 * payment state or a customer is asked (invoker: RLS decides; PostgREST filters, orders and pages it like the table).
 */
function documentsQuery(supabase: Client, orgId: string, filters: DocumentListFilters, columns: string) {
  const base = supabase.from("accounting_documents").select(columns);
  let query = (
    needsPayStateRead(filters)
      ? (supabase
          .rpc("documents_by_pay_state", {
            p_org: orgId,
            p_states: filters.pay ? [filters.pay] : null,
            p_contact: filters.customer?.kind === "contact" ? filters.customer.id : null,
            p_company: filters.customer?.kind === "company" ? filters.customer.id : null,
          })
          .select(columns) as unknown as typeof base)
      : base
  ).eq("organization_id", orgId);
  if (filters.type) query = query.eq("doc_type", filters.type);
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.from) query = query.gte("doc_date", filters.from);
  if (filters.to) query = query.lte("doc_date", filters.to);
  if (filters.filter) query = query.or(filters.filter);
  return query;
}

const LIST_COLUMNS = "id, doc_type, number, doc_date, due_date, amount_agorot, status, created_by, created_at, deal_id, contact_id, company_id";
type ListRow = {
  id: string;
  doc_type: string;
  number: string | null;
  doc_date: string;
  due_date: string | null;
  amount_agorot: number;
  status: string;
  created_by: string | null;
  created_at: string;
  deal_id: string | null;
  contact_id: string | null;
  company_id: string | null;
};

export async function listDocuments(orgId: string, filters: DocumentListFilters): Promise<{ documents: DocumentListItem[]; hasMore: boolean }> {
  const supabase = await createClient();
  const size = filters.chunk?.size ?? PAGE_SIZE;
  const offset = filters.chunk?.from ?? (filters.page - 1) * PAGE_SIZE;
  const query = filters.ids
    ? supabase.from("accounting_documents").select(LIST_COLUMNS).eq("organization_id", orgId).in("id", filters.ids)
    : documentsQuery(supabase, orgId, filters, LIST_COLUMNS);
  const sort = filters.sort ?? DOCUMENT_DEFAULT_SORT;
  const rows = must(
    await query
      .order(DOCUMENT_SORT_COLUMNS[sort.key], { ascending: sort.ascending, nullsFirst: false })
      .order("created_at", { ascending: false })
      .order("id")
      .range(offset, offset + size),
    "documents list",
  ) as unknown as ListRow[];
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
              dueDate: row.due_date,
              amountAgorot: Number(row.amount_agorot),
              cancelled: row.status === "cancelled",
              createdBy: row.created_by,
              createdAt: row.created_at,
              dealId: row.deal_id,
              contactId: row.contact_id,
              companyId: row.company_id,
              customer: customers(row),
            },
          ]
        : [],
    ),
  };
}

// with an advanced filter, the summary reads the matching ids first, at most this many; past it the screen says so
export const DOCUMENT_TOTALS_LIMIT = 20_000;

const summarySchema = z.object({
  count: z.coerce.number(),
  by_type: z.record(z.string(), z.object({ count: z.coerce.number(), agorot: z.coerce.number() })),
  partial: z.boolean(),
  open: z.coerce.number().nullable(),
  overdue: z.coerce.number().nullable(),
});

/**
 * LST-09 + DOC-03: the summary line, over every document in force the filters find (not only the page), in ONE call to
 * public.documents_pay_summary (invoker: RLS decides; COL-01's partial rule for the balances): the count, per type (never
 * netted; an opening balance as debt and credit) and, with the payments key, the open balance and its overdue part. The
 * list's advanced filter cannot travel to SQL, so with one the matching ids are read first (at most DOCUMENT_TOTALS_LIMIT;
 * `complete` says whether all were).
 */
export async function listDocumentTotals(
  orgId: string,
  filters: DocumentListFilters,
): Promise<{ totals: Map<DocumentTotalKey, { count: number; agorot: number }>; complete: boolean; summary: DocumentListSummary }> {
  const supabase = await createClient();
  let ids: string[] | null = null;
  let complete = true;
  if (filters.filter) {
    const read = await readAllPages(
      async (from, to) =>
        must(await documentsQuery(supabase, orgId, filters, "id").eq("status", "active").order("id").range(from, to), "documents totals") as unknown as { id: string }[],
      { limit: DOCUMENT_TOTALS_LIMIT },
    );
    ids = read.rows.map((row) => row.id);
    complete = read.complete;
  }
  const raw = must(
    await supabase.rpc("documents_pay_summary", {
      p_org: orgId,
      p_states: filters.pay ? [filters.pay] : null,
      p_contact: filters.customer?.kind === "contact" ? filters.customer.id : null,
      p_company: filters.customer?.kind === "company" ? filters.customer.id : null,
      p_type: filters.type,
      p_status: filters.status,
      p_from: filters.from,
      p_to: filters.to,
      p_ids: ids,
    }),
    "documents summary",
  );
  const parsed = summarySchema.parse(raw);
  const totals = new Map<DocumentTotalKey, { count: number; agorot: number }>();
  for (const key of DOCUMENT_TOTAL_KEYS) {
    const line = parsed.by_type[key];
    if (line) totals.set(key, { count: line.count, agorot: line.agorot });
  }
  return { complete, totals, summary: { count: parsed.count, open: parsed.open, overdue: parsed.overdue, partial: parsed.partial } };
}

// public.documents_pay_rows takes at most this many ids in one call
const PAY_ROWS_CHUNK = 2_000;
const payRowsSchema = z.array(z.object({ id: z.string(), pay_state: z.enum(DOCUMENT_PAY_STATES), balance: z.coerce.number().nullable() }));

/**
 * DOC-03: the payment state and open balance of the page's (or an export's) documents, from public.documents_pay_rows (the
 * same rule as the filter, invoker), in chunks; only with the payments key.
 */
export async function listDocumentPayStates(
  orgId: string,
  documents: readonly Pick<DocumentListItem, "id">[],
): Promise<Map<string, { payState: DocumentPayState; balance: number | null }>> {
  const supabase = await createClient();
  const states = new Map<string, { payState: DocumentPayState; balance: number | null }>();
  for (let start = 0; start < documents.length; start += PAY_ROWS_CHUNK) {
    const raw = must(
      await supabase.rpc("documents_pay_rows", { p_org: orgId, p_ids: documents.slice(start, start + PAY_ROWS_CHUNK).map((doc) => doc.id) }),
      "documents pay states",
    );
    for (const row of payRowsSchema.parse(raw)) states.set(row.id, { payState: row.pay_state, balance: row.balance });
  }
  return states;
}

/**
 * The names of the contacts and deals of a page of rows (RLS: only those the user reads): the contact's, else the deal's,
 * else (GAP-12, a company's opening balance) the company's (the rule of public.sort_customer on accounting_documents and
 * payments). Shared with the payments list.
 */
type CustomerRow = { deal_id: string | null; contact_id: string | null; company_id?: string | null };
export async function customerNames(orgId: string, rows: readonly CustomerRow[]) {
  const supabase = await createClient();
  const contactIds = [...new Set(rows.flatMap((row) => (row.contact_id ? [row.contact_id] : [])))];
  const dealIds = [...new Set(rows.flatMap((row) => (row.deal_id ? [row.deal_id] : [])))];
  const companyIds = [...new Set(rows.flatMap((row) => (row.company_id ? [row.company_id] : [])))];
  const [contacts, deals, companies] = await Promise.all([
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
    companyIds.length > 0
      ? readAllPagesByIds(companyIds, async (slice, from, to) =>
          must(await supabase.from("companies").select("id, name").eq("organization_id", orgId).in("id", slice).order("id").range(from, to), "list companies"),
        )
      : [],
  ]);
  const contactNames = new Map(contacts.map((row) => [row.id, row.full_name]));
  const dealNames = new Map(deals.map((row) => [row.id, row.name]));
  const companyNames = new Map(companies.map((row) => [row.id, row.name]));
  return (row: CustomerRow) =>
    (row.contact_id ? contactNames.get(row.contact_id) : undefined) ??
    (row.deal_id ? dealNames.get(row.deal_id) : undefined) ??
    (row.company_id ? companyNames.get(row.company_id) : undefined) ??
    null;
}

/** GAP-12: a company's opening balances, newest first (at most 20), with who recorded or cancelled them. */
export async function listCompanyOpeningBalances(orgId: string, companyId: string): Promise<{ documents: AccountingDocument[]; names: Map<string, string> }> {
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("accounting_documents")
      .select(RECORD_COLUMNS)
      .eq("organization_id", orgId)
      .eq("company_id", companyId)
      .eq("doc_type", "opening_balance")
      .order("created_at", { ascending: false })
      .order("id")
      .limit(20),
    "company opening balances",
  );
  const documents: AccountingDocument[] = rows.map((row) => documentFromRow(row, "opening_balance"));
  const names = await getUserNames(documents.flatMap((d) => [d.createdBy, d.cancelledBy]));
  return { documents, names };
}
