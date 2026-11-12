import "server-only";

import { cache } from "react";

import { contactPickerName } from "@/features/contacts/picker";
import { DOCUMENT_TYPE_LABELS } from "@/features/documents/schema";
import { canRecordPayments } from "@/features/permissions/keys";
import { getMyPermissions } from "@/features/permissions/queries";
import { orgHasFeature } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { isBillingStatus, type BillingStatus } from "./schema";
import { isCycle, type Cycle } from "./schedule";

// SUB-01..SUB-04: recurring billings read with the user's session (RLS: whoever reads the customer).

export type RecurringAccess = {
  inPlan: boolean;
  // make and change billings, link a cycle's document: whoever records payments in a writable business (app.recurring_billing_writer)
  canManage: boolean;
  // review L7: pause or cancel, also without the plan key (whoever records payments in a writable business)
  canStop: boolean;
};

export const getRecurringAccess = cache(async (orgId: string): Promise<RecurringAccess> => {
  const [inPlan, context, granted] = await Promise.all([orgHasFeature(orgId, "recurring_billing"), getOrgContext(orgId), getMyPermissions(orgId)]);
  const recorder = context.canWrite && canRecordPayments(context.role, granted);
  return { inPlan, canManage: inPlan && recorder, canStop: recorder };
});

export type BillingSummary = {
  id: string;
  name: string;
  cycle: Cycle;
  status: BillingStatus;
  startDate: string;
  billingDay: number;
  endDate: string | null;
  commitmentMonths: number;
  amountAgorot: number;
  pricesIncludeVat: boolean;
  nextCycleOn: string | null;
  contactId: string | null;
  companyId: string | null;
  dealId: string | null;
  cancelReason: string | null;
  customerName: string;
};

const BILLING_COLUMNS =
  "id, name, cycle, status, start_date, billing_day, end_date, commitment_months, amount_agorot, prices_include_vat, next_cycle_on, contact_id, company_id, deal_id, cancel_reason";

type BillingRowLike = {
  id: string;
  name: string;
  cycle: string;
  status: string;
  start_date: string;
  billing_day: number;
  end_date: string | null;
  commitment_months: number;
  amount_agorot: number;
  prices_include_vat: boolean;
  next_cycle_on: string | null;
  contact_id: string | null;
  company_id: string | null;
  deal_id: string | null;
  cancel_reason: string | null;
};

async function customerNames(orgId: string, rows: BillingRowLike[]): Promise<Map<string, string>> {
  const supabase = await createClient();
  const contactIds = [...new Set(rows.flatMap((r) => (r.contact_id ? [r.contact_id] : [])))];
  const companyIds = [...new Set(rows.flatMap((r) => (r.company_id ? [r.company_id] : [])))];
  const names = new Map<string, string>();
  if (contactIds.length) {
    const data = must(await supabase.from("contacts").select("id, full_name, email, phone").eq("organization_id", orgId).in("id", contactIds), "contacts");
    for (const c of data) names.set(c.id, contactPickerName(c));
  }
  if (companyIds.length) {
    const data = must(await supabase.from("companies").select("id, name").eq("organization_id", orgId).in("id", companyIds), "companies");
    for (const c of data) names.set(c.id, c.name);
  }
  return names;
}

function toSummary(row: BillingRowLike, names: Map<string, string>): BillingSummary {
  return {
    id: row.id,
    name: row.name,
    cycle: isCycle(row.cycle) ? row.cycle : "monthly",
    status: isBillingStatus(row.status) ? row.status : "active",
    startDate: row.start_date,
    billingDay: row.billing_day,
    endDate: row.end_date,
    commitmentMonths: row.commitment_months,
    amountAgorot: Number(row.amount_agorot),
    pricesIncludeVat: row.prices_include_vat,
    nextCycleOn: row.next_cycle_on,
    contactId: row.contact_id,
    companyId: row.company_id,
    dealId: row.deal_id,
    cancelReason: row.cancel_reason,
    customerName: names.get(row.contact_id ?? row.company_id ?? "") ?? "",
  };
}

/** The billings the user reads: of one customer, or all (newest first, at most 500). */
export async function listBillings(orgId: string, customer: { contactId?: string; companyId?: string } = {}): Promise<BillingSummary[]> {
  const supabase = await createClient();
  let query = supabase.from("recurring_billings").select(BILLING_COLUMNS).eq("organization_id", orgId);
  if (customer.contactId) query = query.eq("contact_id", customer.contactId);
  if (customer.companyId) query = query.eq("company_id", customer.companyId);
  const rows = must(await query.order("created_at", { ascending: false }).order("id").limit(500), "recurring billings");
  const names = await customerNames(orgId, rows);
  return rows.map((row) => toSummary(row, names));
}

export type BillingLine = {
  id: string;
  position: number;
  productId: string | null;
  description: string;
  quantity: number;
  unitPriceAgorot: number;
  discountBp: number | null;
  discountAgorot: number | null;
  totalAgorot: number;
  vatExempt: boolean;
  priceSource: string;
  priceListName: string | null;
};

export type BillingCycle = {
  id: string;
  cycleOn: string;
  periodEnd: string;
  netAgorot: number;
  vatAgorot: number;
  totalAgorot: number;
  status: string;
  documentId: string | null;
  taskId: string | null;
  orderId: string | null;
};

export type BillingEvent = {
  id: string;
  kind: string;
  oldAmount: number | null;
  newAmount: number | null;
  skippedCycles: number | null;
  reason: string | null;
  inCommitment: boolean | null;
  makeUp: boolean | null;
  effectiveOn: string | null;
  actorId: string | null;
  createdAt: string;
};

export type DocumentChoice = { id: string; label: string };

export type BillingDetail = {
  billing: BillingSummary;
  lines: BillingLine[];
  cycles: BillingCycle[];
  events: BillingEvent[];
  documents: DocumentChoice[];
};

/** One billing with its lines, cycles, history and the customer's documents a cycle may name; null when not readable. */
export async function getBilling(orgId: string, billingId: string): Promise<BillingDetail | null> {
  const supabase = await createClient();
  const row = must(await supabase.from("recurring_billings").select(BILLING_COLUMNS).eq("organization_id", orgId).eq("id", billingId).maybeSingle(), "recurring billing");
  if (!row) return null;
  const names = await customerNames(orgId, [row]);
  const [lines, cycles, events] = await Promise.all([
    supabase
      .from("recurring_billing_lines")
      .select("id, position, product_id, description, quantity, unit_price_agorot, discount_bp, discount_agorot, total_agorot, vat_exempt, price_source, price_list_name")
      .eq("organization_id", orgId)
      .eq("billing_id", billingId)
      .order("position")
      .order("id"),
    supabase
      .from("recurring_billing_cycles")
      .select("id, cycle_on, period_end, net_agorot, vat_agorot, total_agorot, status, accounting_document_id, task_id, order_id")
      .eq("organization_id", orgId)
      .eq("billing_id", billingId)
      .order("cycle_on", { ascending: false })
      .limit(120),
    supabase
      .from("recurring_billing_events")
      .select("id, kind, old_amount_agorot, new_amount_agorot, skipped_cycles, reason, in_commitment, make_up, effective_on, actor_id, created_at")
      .eq("organization_id", orgId)
      .eq("billing_id", billingId)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);
  // the customer's active invoices and receipts a cycle may name (the database judges the link again)
  let docQuery = supabase
    .from("accounting_documents")
    .select("id, doc_type, number, doc_date")
    .eq("organization_id", orgId)
    .eq("status", "active")
    .in("doc_type", ["tax_invoice", "tax_invoice_receipt", "receipt", "proforma"]);
  docQuery = row.contact_id ? docQuery.eq("contact_id", row.contact_id) : docQuery.eq("company_id", row.company_id ?? "");
  const docs = must(await docQuery.order("doc_date", { ascending: false }).limit(200), "documents");
  return {
    billing: toSummary(row, names),
    lines: must(lines, "recurring billing lines").map((l) => ({
      id: l.id,
      position: l.position,
      productId: l.product_id,
      description: l.description,
      quantity: Number(l.quantity),
      unitPriceAgorot: Number(l.unit_price_agorot),
      discountBp: l.discount_bp,
      discountAgorot: l.discount_agorot === null ? null : Number(l.discount_agorot),
      totalAgorot: Number(l.total_agorot),
      vatExempt: l.vat_exempt,
      priceSource: l.price_source,
      priceListName: l.price_list_name,
    })),
    cycles: must(cycles, "recurring billing cycles").map((c) => ({
      id: c.id,
      cycleOn: c.cycle_on,
      periodEnd: c.period_end,
      netAgorot: Number(c.net_agorot),
      vatAgorot: Number(c.vat_agorot),
      totalAgorot: Number(c.total_agorot),
      status: c.status,
      documentId: c.accounting_document_id,
      taskId: c.task_id,
      orderId: c.order_id,
    })),
    events: must(events, "recurring billing events").map((e) => ({
      id: e.id,
      kind: e.kind,
      oldAmount: e.old_amount_agorot === null ? null : Number(e.old_amount_agorot),
      newAmount: e.new_amount_agorot === null ? null : Number(e.new_amount_agorot),
      skippedCycles: e.skipped_cycles,
      reason: e.reason,
      inCommitment: e.in_commitment,
      makeUp: e.make_up,
      effectiveOn: e.effective_on,
      actorId: e.actor_id,
      createdAt: e.created_at,
    })),
    documents: docs.map((d) => ({
      id: d.id,
      label: `${DOCUMENT_TYPE_LABELS[d.doc_type as keyof typeof DOCUMENT_TYPE_LABELS] ?? d.doc_type} ${d.number ?? ""}`.trim(),
    })),
  };
}

/** The offerable products a line may take (at most 300, by name). */
export async function listOfferableProducts(orgId: string): Promise<{ id: string; name: string }[]> {
  const supabase = await createClient();
  return must(
    await supabase.from("products").select("id, name").eq("organization_id", orgId).eq("is_active", true).is("archived_at", null).order("name").limit(300),
    "products",
  );
}

/** SUB-03: the live (not cancelled) billing made from a deal, if any. */
export async function getDealBillingId(orgId: string, dealId: string): Promise<string | null> {
  const supabase = await createClient();
  const row = must(
    await supabase.from("recurring_billings").select("id").eq("organization_id", orgId).eq("deal_id", dealId).neq("status", "cancelled").limit(1).maybeSingle(),
    "deal recurring billing",
  );
  return row?.id ?? null;
}
