import "server-only";

import { toCleanupDeal } from "@/features/pipeline-cleanup/queries";
import type { CleanupDeal } from "@/features/pipeline-cleanup/rules";
import { parseReportData } from "@/features/reports/schemas";
import { listMembers } from "@/features/settings/queries";
import { getUserNames } from "@/features/shell/queries";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { moneySummary, type MoneySummary } from "./groups";

export type MoneyLead = {
  id: string;
  name: string;
  // the lead's own full name (for a template's {שם פרטי}); null when it has none
  fullName: string | null;
  phone: string | null;
  phoneE164: string | null;
  ownerId: string | null;
  ownerName: string | null;
  createdAt: string;
};

export type MoneyQuote = {
  id: string;
  number: string | null;
  title: string | null;
  status: "sent" | "viewed";
  sentAt: string;
  validUntil: string | null;
  // before VAT (the measure of the deals beside it); totalWithVat for the line
  amount: number;
  totalWithVat: number;
  dealId: string | null;
  contactId: string | null;
  ownerId: string | null;
  ownerName: string | null;
  customerName: string | null;
};

export type MoneyDebt = {
  id: string;
  docType: "tax_invoice" | "proforma" | "opening_balance";
  number: string | null;
  dueDate: string;
  daysOverdue: number;
  amount: number;
  balance: number;
  dealId: string | null;
  contactId: string | null;
  companyId: string | null;
  ownerId: string | null;
  ownerName: string | null;
  customerName: string | null;
};

export type MoneyRenewal = {
  id: string;
  name: string | null;
  status: "open" | "won";
  billingKind: "monthly" | "yearly";
  // one period of the recurring amount
  amount: number | null;
  renewalDate: string;
  contactId: string | null;
  ownerId: string | null;
  ownerName: string | null;
};

export type MoneyWaiting = {
  today: string;
  summary: MoneySummary;
  // the deals to close (at most 300), each once: stuck, else overdue
  deals: CleanupDeal[];
  // the 100 newest unhandled leads
  leads: MoneyLead[];
  // at most 300 each; null: the group's module is not in the business's plan
  quotes: MoneyQuote[] | null;
  debts: MoneyDebt[] | null;
  renewals: MoneyRenewal[];
};

/**
 * MNY-01: money waiting, read through public.report_money_waiting (security invoker: every
 * user counts only the records they may see). null when the organization is not visible.
 */
export async function getMoneyWaiting(orgId: string, ownerId: string | null): Promise<MoneyWaiting | null> {
  const supabase = await createClient();
  const raw = must(await supabase.rpc("report_money_waiting", { p_org: orgId, p_owner: ownerId }), "money waiting");
  if (raw === null) return null;
  // FXC-12: the result is checked before it is read; a mismatch throws
  const data = parseReportData("report_money_waiting", raw);
  const names = await getUserNames([
    ...data.deals.map((row) => row.owner_id),
    ...data.leads.map((row) => row.owner_id),
    ...(data.quotes?.rows ?? []).map((row) => row.owner_id),
    ...(data.debts?.rows ?? []).map((row) => row.owner_id),
    ...data.renewals.rows.map((row) => row.owner_id),
  ]);
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? null) : null);
  return {
    today: data.today,
    summary: moneySummary(data),
    deals: data.deals.map((row) => toCleanupDeal(row, names)),
    leads: data.leads.map((row) => ({
      id: row.id,
      // as the waiting-leads screen names them
      name: row.full_name || row.company_name || row.phone || row.email || "ליד ללא שם",
      fullName: row.full_name,
      phone: row.phone,
      phoneE164: row.phone_e164,
      ownerId: row.owner_id,
      ownerName: row.owner_id ? (names.get(row.owner_id) ?? null) : null,
      createdAt: row.created_at,
    })),
    quotes:
      data.quotes?.rows.map((row) => ({
        id: row.id,
        number: row.number,
        title: row.title,
        status: row.status,
        sentAt: row.sent_at,
        validUntil: row.valid_until,
        amount: row.amount_agorot,
        totalWithVat: row.total_agorot,
        dealId: row.deal_id,
        contactId: row.contact_id,
        ownerId: row.owner_id,
        ownerName: nameOf(row.owner_id),
        customerName: row.customer_name,
      })) ?? null,
    debts:
      data.debts?.rows.map((row) => ({
        id: row.id,
        docType: row.doc_type,
        number: row.number,
        dueDate: row.due_date,
        daysOverdue: row.days_overdue,
        amount: row.amount_agorot,
        balance: row.balance,
        dealId: row.deal_id,
        contactId: row.contact_id,
        companyId: row.company_id,
        ownerId: row.owner_id,
        ownerName: nameOf(row.owner_id),
        customerName: row.customer_name,
      })) ?? null,
    renewals: data.renewals.rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      billingKind: row.billing_kind,
      amount: row.amount_agorot,
      renewalDate: row.renewal_date,
      contactId: row.contact_id,
      ownerId: row.owner_id,
      ownerName: nameOf(row.owner_id),
    })),
  };
}

export type RowActionSetup = {
  // who a record can be handed to: active members who write
  owners: { value: string; label: string }[];
  // per deal contact: the name and WhatsApp number (only contacts the user may read)
  contacts: Map<string, { firstName: string | null; fullName: string | null; phoneE164: string | null }>;
};

/**
 * MNY-02: what the rows' actions need; read with the user's session. contactIds: the contacts the rows reach
 * (deals' contacts, debts' contacts), so WhatsApp can go to them.
 */
export async function getRowActionSetup(orgId: string, canWrite: boolean, contactIdsOfRows: Array<string | null>): Promise<RowActionSetup> {
  if (!canWrite) {
    return { owners: [], contacts: new Map() };
  }
  const supabase = await createClient();
  const contactIds = [...new Set(contactIdsOfRows.filter((id): id is string => Boolean(id)))];
  const [members, contacts] = await Promise.all([
    listMembers(orgId),
    contactIds.length > 0
      ? supabase.from("contacts").select("id, first_name, full_name, phone_e164").eq("organization_id", orgId).in("id", contactIds).is("deleted_at", null)
      : Promise.resolve({ data: [], error: null }),
  ]);
  return {
    owners: members.filter((m) => m.status === "active" && m.role !== "viewer").map((m) => ({ value: m.userId, label: m.name })),
    contacts: new Map(
      (must(contacts, "deal contacts") ?? []).map((row) => [row.id, { firstName: row.first_name, fullName: row.full_name, phoneE164: row.phone_e164 }]),
    ),
  };
}
