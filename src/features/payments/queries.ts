import "server-only";

import { cache } from "react";

import { canRecordPayments } from "@/features/permissions/keys";
import { getMyPermissions } from "@/features/permissions/queries";
import { orgHasFeature } from "@/features/settings/queries";
import { getOrgContext, getUserNames } from "@/features/shell/queries";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { isPaymentMethod, isPaymentStatus, type PaymentMethod, type PaymentStatus } from "./schema";

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
};

export type PaymentsSubject = { kind: "deal" | "contact"; id: string };

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
        "id, amount_agorot, paid_on, method, installments, reference, note, status, cancel_reason, cancelled_at, cancelled_by, created_by, updated_by, created_at, updated_at",
      )
      .eq("organization_id", orgId)
      .eq(subject.kind === "deal" ? "deal_id" : "contact_id", subject.id)
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
          },
        ]
      : [],
  );
  const names = await getUserNames(payments.flatMap((p) => [p.createdBy, p.updatedBy, p.cancelledBy]));
  return { payments, names };
}
