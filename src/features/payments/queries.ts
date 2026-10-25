import "server-only";

import { cache } from "react";

import { canRecordPayments } from "@/features/permissions/keys";
import { getMyPermissions } from "@/features/permissions/queries";
import { orgHasFeature } from "@/features/settings/queries";
import { getOrgContext, getUserNames } from "@/features/shell/queries";
import { customerNames } from "@/features/documents/queries";
import { must } from "@/lib/db-read";

import { MONEY_SUBJECT_COLUMN, type MoneySubject } from "./money-subject";
import { readAllPages } from "@/lib/paged-read";
import { PAGE_SIZE } from "@/lib/search";
import { createClient } from "@/lib/supabase/server";

import { isChequeStatus, type ChequeStatus } from "./cheques";
import { PAYMENT_DEFAULT_SORT, PAYMENT_SORT_COLUMNS, type PaymentListFilters } from "./list";
import { isPaymentMethod, isPaymentStatus, receivedTotal, type PaymentMethod, type PaymentStatus } from "./schema";

// PAY-01: the payments recorded on a deal or a contact, read with the user's session (RLS: whoever reads the deal, else
// the contact).

export type Payment = {
  id: string;
  amountAgorot: number;
  paidOn: string;
  method: PaymentMethod;
  installments: number | null;
  reference: string | null;
  note: string | null;
  status: PaymentStatus;
  cancelReason: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  // PAY-04: a cheque's details (null on any other method, and on a cheque recorded before PAY-04)
  cheque: {
    number: string | null;
    bank: string | null;
    bankName: string | null;
    branch: string | null;
    dueDate: string | null;
    status: ChequeStatus;
    unbounceReason: string | null;
  } | null;
};

export type PaymentsSubject = MoneySubject;

export type PaymentsAccess = {
  inPlan: boolean;
  // PAY-06: owners, admins and managers, or the personal key record_payments
  canRecord: boolean;
  // PAY-06: correcting, cancelling and marking refunded are for owners and admins
  canCorrect: boolean;
};

/** Whether payments are in the plan, and what the user may do with them. */
export const getPaymentsAccess = cache(async (orgId: string): Promise<PaymentsAccess> => {
  const [inPlan, context, granted] = await Promise.all([orgHasFeature(orgId, "payments"), getOrgContext(orgId), getMyPermissions(orgId)]);
  const canRecord = inPlan && context.canWrite && canRecordPayments(context.role, granted);
  return {
    inPlan,
    canRecord,
    canCorrect: canRecord && (context.role === "owner" || context.role === "admin"),
  };
});

/** The record's payments, newest first (at most 200), with the names of who recorded or last changed them. */
export async function listRecordPayments(orgId: string, subject: PaymentsSubject): Promise<{ payments: Payment[]; names: Map<string, string> }> {
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("payments")
      .select(
        "id, amount_agorot, paid_on, method, installments, reference, note, status, cancel_reason, cancelled_at, cancelled_by, created_by, updated_by, created_at, updated_at, cheque_number, cheque_bank, cheque_bank_name, cheque_branch, cheque_due_date, cheque_status, cheque_unbounce_reason",
      )
      .eq("organization_id", orgId)
      .eq(MONEY_SUBJECT_COLUMN[subject.kind], subject.id)
      .order("paid_on", { ascending: false })
      .order("created_at", { ascending: false })
      .order("id")
      .limit(200),
    "payments",
  );
  const payments = rows.flatMap((row): Payment[] =>
    isPaymentMethod(row.method) && isPaymentStatus(row.status)
      ? [
          {
            id: row.id,
            amountAgorot: Number(row.amount_agorot),
            paidOn: row.paid_on,
            method: row.method,
            installments: row.installments,
            reference: row.reference,
            note: row.note,
            status: row.status,
            cancelReason: row.cancel_reason,
            cancelledAt: row.cancelled_at,
            cancelledBy: row.cancelled_by,
            createdBy: row.created_by,
            updatedBy: row.updated_by,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            cheque: isChequeStatus(row.cheque_status)
              ? {
                  number: row.cheque_number,
                  bank: row.cheque_bank,
                  bankName: row.cheque_bank_name,
                  branch: row.cheque_branch,
                  dueDate: row.cheque_due_date,
                  status: row.cheque_status,
                  unbounceReason: row.cheque_unbounce_reason,
                }
              : null,
          },
        ]
      : [],
  );
  const names = await getUserNames(payments.flatMap((p) => [p.createdBy, p.updatedBy, p.cancelledBy]));
  return { payments, names };
}

// ----------------------------------------------------------------------------
// LST-09: the business-wide list of payments
// ----------------------------------------------------------------------------

export type PaymentListItem = {
  id: string;
  amountAgorot: number;
  paidOn: string;
  method: PaymentMethod;
  installments: number | null;
  reference: string | null;
  status: PaymentStatus;
  createdBy: string | null;
  createdAt: string;
  dealId: string | null;
  contactId: string | null;
  // the rule of public.sort_customer(payments): the contact's name, else the deal's
  customer: string | null;
};

/**
 * LST-09: the payments of the business the user reads (the payments of deals and contacts they read), filtered by the
 * list's selects and the advanced filter, sorted by any column; one page at a time, the picked rows, or an export chunk.
 * Read with the user's session: the payments RLS decides. The note is not read: it stays on the record's card.
 */
export async function listPayments(orgId: string, filters: PaymentListFilters): Promise<{ payments: PaymentListItem[]; hasMore: boolean }> {
  const supabase = await createClient();
  const size = filters.chunk?.size ?? PAGE_SIZE;
  const offset = filters.chunk?.from ?? (filters.page - 1) * PAGE_SIZE;
  let query = supabase
    .from("payments")
    .select("id, amount_agorot, paid_on, method, installments, reference, status, created_by, created_at, deal_id, contact_id")
    .eq("organization_id", orgId);
  if (filters.ids) {
    query = query.in("id", filters.ids);
  } else {
    if (filters.status) query = query.eq("status", filters.status);
    if (filters.method) query = query.eq("method", filters.method);
    if (filters.from) query = query.gte("paid_on", filters.from);
    if (filters.to) query = query.lte("paid_on", filters.to);
    if (filters.filter) query = query.or(filters.filter);
  }
  const sort = filters.sort ?? PAYMENT_DEFAULT_SORT;
  const rows = must(
    await query
      .order(PAYMENT_SORT_COLUMNS[sort.key], { ascending: sort.ascending, nullsFirst: false })
      .order("created_at", { ascending: false })
      .order("id")
      .range(offset, offset + size),
    "payments list",
  );
  const page = rows.slice(0, size);
  const customers = await customerNames(orgId, page);
  return {
    hasMore: rows.length > size,
    payments: page.flatMap((row): PaymentListItem[] =>
      isPaymentMethod(row.method) && isPaymentStatus(row.status)
        ? [
            {
              id: row.id,
              amountAgorot: Number(row.amount_agorot),
              paidOn: row.paid_on,
              method: row.method,
              installments: row.installments,
              reference: row.reference,
              status: row.status,
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

// the total reads at most this many payments; past it the screen says the total is partial
export const PAYMENT_TOTALS_LIMIT = 20_000;

/**
 * LST-09 (owner, 21 October 2026): the list's total received, over every payment the filters find (not only the page):
 * recorded and confirmed payments only, as everywhere (receivedTotal). Read with the user's session, like the list.
 */
export async function listPaymentTotal(orgId: string, filters: PaymentListFilters): Promise<{ count: number; agorot: number; complete: boolean }> {
  const supabase = await createClient();
  const { rows, complete } = await readAllPages(
    async (from, to) => {
      let query = supabase.from("payments").select("id, amount_agorot, status").eq("organization_id", orgId).in("status", ["recorded", "confirmed"]);
      if (filters.status) query = query.eq("status", filters.status);
      if (filters.method) query = query.eq("method", filters.method);
      if (filters.from) query = query.gte("paid_on", filters.from);
      if (filters.to) query = query.lte("paid_on", filters.to);
      if (filters.filter) query = query.or(filters.filter);
      return must(await query.order("id").range(from, to), "payments total");
    },
    { limit: PAYMENT_TOTALS_LIMIT },
  );
  const counted = rows.flatMap((row) => (isPaymentStatus(row.status) ? [{ amountAgorot: Number(row.amount_agorot), status: row.status }] : []));
  return { count: counted.length, agorot: receivedTotal(counted), complete };
}

// ----------------------------------------------------------------------------
// PAY-04 answer 7: the deferred cheques (in hand or deposited), by due date
// ----------------------------------------------------------------------------

export type DeferredCheque = {
  id: string;
  amountAgorot: number;
  number: string | null;
  bank: string | null;
  bankName: string | null;
  branch: string | null;
  dueDate: string;
  status: ChequeStatus;
  dealId: string | null;
  contactId: string | null;
  customer: string | null;
};

// the screen reads at most this many cheques; past it the screen says the list is partial
export const DEFERRED_CHEQUES_LIMIT = 2000;

/** The cheques of the business the user reads that are not cashed yet (in hand or deposited), earliest due date first. */
export async function listDeferredCheques(orgId: string): Promise<{ cheques: DeferredCheque[]; complete: boolean }> {
  const supabase = await createClient();
  const { rows, complete } = await readAllPages(
    async (from, to) =>
      must(
        await supabase
          .from("payments")
          .select("id, amount_agorot, cheque_number, cheque_bank, cheque_bank_name, cheque_branch, cheque_due_date, cheque_status, deal_id, contact_id")
          .eq("organization_id", orgId)
          .eq("method", "cheque")
          .in("cheque_status", ["in_hand", "deposited"])
          .in("status", ["recorded", "confirmed"])
          .order("cheque_due_date")
          .order("id")
          .range(from, to),
        "deferred cheques",
      ),
    { limit: DEFERRED_CHEQUES_LIMIT },
  );
  const customers = await customerNames(orgId, rows);
  return {
    complete,
    cheques: rows.flatMap((row): DeferredCheque[] =>
      isChequeStatus(row.cheque_status) && row.cheque_due_date
        ? [
            {
              id: row.id,
              amountAgorot: Number(row.amount_agorot),
              number: row.cheque_number,
              bank: row.cheque_bank,
              bankName: row.cheque_bank_name,
              branch: row.cheque_branch,
              dueDate: row.cheque_due_date,
              status: row.cheque_status,
              dealId: row.deal_id,
              contactId: row.contact_id,
              customer: customers(row),
            },
          ]
        : [],
    ),
  };
}
