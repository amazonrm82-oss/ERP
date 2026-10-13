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

export type MoneyWaiting = {
  today: string;
  summary: MoneySummary;
  // the deals to close (at most 300), each once: stuck, else overdue
  deals: CleanupDeal[];
  // the 100 newest unhandled leads
  leads: MoneyLead[];
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
  const names = await getUserNames([...data.deals.map((row) => row.owner_id), ...data.leads.map((row) => row.owner_id)]);
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
  };
}

export type RowActionSetup = {
  // who a record can be handed to: active members who write
  owners: { value: string; label: string }[];
  // per deal contact: the name and WhatsApp number (only contacts the user may read)
  contacts: Map<string, { firstName: string | null; fullName: string | null; phoneE164: string | null }>;
};

/** MNY-02: what the rows' actions need; read with the user's session. */
export async function getRowActionSetup(orgId: string, canWrite: boolean, deals: CleanupDeal[]): Promise<RowActionSetup> {
  if (!canWrite) {
    return { owners: [], contacts: new Map() };
  }
  const supabase = await createClient();
  const contactIds = [...new Set(deals.map((deal) => deal.contactId).filter((id): id is string => Boolean(id)))];
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
