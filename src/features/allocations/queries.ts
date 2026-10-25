import "server-only";

import { cache } from "react";

import { getDocumentsAccess } from "@/features/documents/queries";
import { isDocumentType, type DocumentType } from "@/features/documents/schema";
import { getPaymentsAccess } from "@/features/payments/queries";
import { isPaymentMethod, type PaymentMethod } from "@/features/payments/schema";
import { moneyRowParents } from "@/features/payments/deal-contact";
import type { MoneySubject } from "@/features/payments/money-subject";
import { getOrgContext } from "@/features/shell/queries";
import { DbReadError, must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { NO_CREDIT, parseCustomerCredit, type CustomerCredit } from "./credit";
import { parseCandidates, parseMoneyState, type AllocationCandidates, type DocumentMoneyState, type PaymentMoneyState } from "./state";

// PAY-02: allocations of payments to documents, read with the user's session (RLS: whoever reads the document or the payment).

export type AllocationAccess = {
  // both plan keys (the lead's call 1)
  inPlan: boolean;
  // whoever records payments (app.can_record_payments)
  canAllocate: boolean;
  // owners and admins change the amount or undo (answer 4)
  canChange: boolean;
};

export const getAllocationAccess = cache(async (orgId: string): Promise<AllocationAccess> => {
  const [payments, documents] = await Promise.all([getPaymentsAccess(orgId), getDocumentsAccess(orgId)]);
  const inPlan = payments.inPlan && documents.inPlan;
  return { inPlan, canAllocate: inPlan && payments.canRecord, canChange: inPlan && payments.canCorrect };
});

/**
 * PAY-03: whether the contacts' and companies' lists offer the credit column, its sort and its filter: owners and admins
 * (the database's app.customer_credit_of answers null to anyone else, since the kept totals count every payment) of a
 * business with both money keys (payments and documents), the rule of the cards. Nobody else is offered them at all.
 */
export async function moneyColumnsEnabled(orgId: string): Promise<boolean> {
  const [access, context] = await Promise.all([getAllocationAccess(orgId), getOrgContext(orgId)]);
  return access.inPlan && (context.role === "owner" || context.role === "admin");
}

/** PAY-03: the credit column's values for one page of contacts or companies (public.credit_balance, the cards' rule). */
export async function getCreditNumbers(orgId: string, table: "contacts" | "companies", ids: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (ids.length === 0) return result;
  const supabase = await createClient();
  for (let i = 0; i < ids.length; i += 200) {
    const rows = must(await supabase.from(table).select("id, credit_balance").eq("organization_id", orgId).in("id", ids.slice(i, i + 200)), "credit balance");
    for (const row of rows as unknown as Array<{ id: string; credit_balance: number | string | null }>) {
      if (row.credit_balance !== null) result.set(row.id, Number(row.credit_balance));
    }
  }
  return result;
}

/** Each document's paid amount, balance and state, and each payment's allocated amount and credit (the database's rule). */
export async function getMoneyState(
  orgId: string,
  documentIds: string[],
  paymentIds: string[],
): Promise<{ documents: Map<string, DocumentMoneyState>; payments: Map<string, PaymentMoneyState> }> {
  if (documentIds.length === 0 && paymentIds.length === 0) return { documents: new Map(), payments: new Map() };
  const supabase = await createClient();
  const raw = must(await supabase.rpc("money_allocation_state", { p_org: orgId, p_documents: documentIds, p_payments: paymentIds }), "allocation state");
  return parseMoneyState(raw);
}

/**
 * PAY-03: the credit a document recorded here could use: the same customer's recorded and confirmed payments, the parts not
 * allocated yet (the database's rule; RLS decides which payments count). `where` is where such a document hangs (a deal and
 * its readable contact, a contact), or a company for its card.
 */
export async function getCustomerCredit(orgId: string, where: { deal: string | null; contact: string | null; company: string | null }): Promise<CustomerCredit> {
  if (!where.deal && !where.contact && !where.company) return NO_CREDIT;
  const supabase = await createClient();
  const raw = must(
    await supabase.rpc("money_customer_credit", { p_org: orgId, p_deal: where.deal, p_contact: where.contact, p_company: where.company }),
    "customer credit",
  );
  return parseCustomerCredit(raw);
}

/** PAY-03: the credit a document recorded on this card's deal, contact or order would be offered. */
export async function getSubjectCredit(orgId: string, subject: MoneySubject): Promise<CustomerCredit> {
  const supabase = await createClient();
  const parents = await moneyRowParents(supabase, orgId, subject);
  if ("error" in parents) throw new DbReadError("credit parents", { message: parents.error.message ?? "", code: parents.error.code ?? null });
  if ("missing" in parents) return NO_CREDIT;
  return getCustomerCredit(orgId, { deal: parents.deal_id, contact: parents.contact_id, company: null });
}

/** What the allocation window offers for a payment (documents) or a document (payments, and proformas to bill). */
export async function getAllocationCandidates(orgId: string, from: { kind: "payment" | "document"; id: string }): Promise<AllocationCandidates> {
  const supabase = await createClient();
  const raw = must(
    await supabase.rpc("money_allocation_candidates", {
      p_org: orgId,
      p_payment: from.kind === "payment" ? from.id : null,
      p_document: from.kind === "document" ? from.id : null,
    }),
    "allocation candidates",
  );
  return parseCandidates(raw);
}

export type Allocation = {
  id: string;
  paymentId: string;
  documentId: string;
  amountAgorot: number;
  // counted: neither released nor undone
  counted: boolean;
  released: boolean;
  removedAt: string | null;
  removedBy: string | null;
  // the other side, when the user reads it
  document: { docType: DocumentType; number: string } | null;
  payment: { paidOn: string; method: PaymentMethod; amountAgorot: number } | null;
};

/** The allocations of these payments or of these documents (at most 500), the counted ones first. */
export async function listAllocations(orgId: string, by: { payments?: string[]; documents?: string[] }): Promise<Allocation[]> {
  const payments = by.payments ?? [];
  const documents = by.documents ?? [];
  if (payments.length === 0 && documents.length === 0) return [];
  const supabase = await createClient();
  let query = supabase
    .from("payment_allocations")
    .select("id, payment_id, document_id, amount_agorot, released_at, removed_at, removed_by, created_at")
    .eq("organization_id", orgId);
  query = payments.length > 0 ? query.in("payment_id", payments) : query.in("document_id", documents);
  const rows = must(await query.order("created_at").order("id").limit(500), "allocations");
  const docIds = [...new Set(rows.map((r) => r.document_id))];
  const payIds = [...new Set(rows.map((r) => r.payment_id))];
  const [docRows, payRows] = await Promise.all([
    docIds.length > 0
      ? supabase.from("accounting_documents").select("id, doc_type, number").eq("organization_id", orgId).in("id", docIds)
      : Promise.resolve({ data: [] as { id: string; doc_type: string; number: string }[], error: null }),
    payIds.length > 0
      ? supabase.from("payments").select("id, paid_on, method, amount_agorot").eq("organization_id", orgId).in("id", payIds)
      : Promise.resolve({ data: [] as { id: string; paid_on: string; method: string; amount_agorot: number }[], error: null }),
  ]);
  const docsById = new Map(must(docRows, "allocation documents").flatMap((d) => (isDocumentType(d.doc_type) ? [[d.id, { docType: d.doc_type, number: d.number }] as const] : [])));
  const paysById = new Map(
    must(payRows, "allocation payments").flatMap((p) =>
      isPaymentMethod(p.method) ? [[p.id, { paidOn: p.paid_on, method: p.method, amountAgorot: Number(p.amount_agorot) }] as const] : [],
    ),
  );
  return rows
    .map((r) => ({
      id: r.id,
      paymentId: r.payment_id,
      documentId: r.document_id,
      amountAgorot: Number(r.amount_agorot),
      counted: r.released_at === null && r.removed_at === null,
      released: r.released_at !== null,
      removedAt: r.removed_at,
      removedBy: r.removed_by,
      document: docsById.get(r.document_id) ?? null,
      payment: paysById.get(r.payment_id) ?? null,
    }))
    .sort((a, b) => Number(b.counted) - Number(a.counted));
}
