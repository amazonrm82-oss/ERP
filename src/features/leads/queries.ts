import "server-only";

import { getUserNames } from "@/features/shell/queries";
import type { LeadStatusKind } from "@/lib/database.types";
import { PAGE_SIZE, personSearchFilter } from "@/lib/search";
import { createClient } from "@/lib/supabase/server";

export type LeadStatusOption = { id: string; name: string; kind: LeadStatusKind; isDefault: boolean };
export type LeadSourceOption = { id: string; name: string };

/** Statuses (in their configured order) and active sources of the organization. */
export async function getLeadLookups(orgId: string): Promise<{ statuses: LeadStatusOption[]; sources: LeadSourceOption[] }> {
  const supabase = await createClient();
  const [statuses, sources] = await Promise.all([
    supabase
      .from("lead_statuses")
      .select("id, name, kind, is_default, position")
      .eq("organization_id", orgId)
      .order("position", { ascending: true }),
    supabase
      .from("lead_sources")
      .select("id, name, is_active")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: true })
      .order("name", { ascending: true }),
  ]);
  if (statuses.error) {
    throw new Error(`lead statuses query failed: ${statuses.error.message}`);
  }
  if (sources.error) {
    throw new Error(`lead sources query failed: ${sources.error.message}`);
  }
  return {
    statuses: statuses.data.map((s) => ({ id: s.id, name: s.name, kind: s.kind, isDefault: s.is_default })),
    // inactive sources stay in the list so existing leads still show their source name
    sources: sources.data.map((s) => ({ id: s.id, name: s.is_active ? s.name : `${s.name} (לא פעיל)` })),
  };
}

export type LeadListItem = {
  id: string;
  fullName: string | null;
  phone: string | null;
  phoneE164: string | null;
  email: string | null;
  companyName: string | null;
  statusId: string;
  sourceId: string | null;
  ownerName: string | null;
  createdAt: string;
};

type ListOptions = { search: string; statusId: string | null; page: number };

/** One page of live leads, newest first. Fetches one extra row to know if there is a next page. */
export async function listLeads(orgId: string, options: ListOptions): Promise<{ leads: LeadListItem[]; hasMore: boolean }> {
  const supabase = await createClient();
  const from = (options.page - 1) * PAGE_SIZE;

  let query = supabase
    .from("leads")
    .select("id, full_name, phone, phone_e164, email, company_name, status_id, source_id, owner_id, created_at")
    .eq("organization_id", orgId)
    .is("deleted_at", null);

  if (options.statusId) {
    query = query.eq("status_id", options.statusId);
  }
  const searchFilter = personSearchFilter(["full_name", "company_name"], options.search);
  if (searchFilter) {
    query = query.or(searchFilter);
  }

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, from + PAGE_SIZE);
  if (error) {
    throw new Error(`leads query failed: ${error.message}`);
  }

  const rows = data.slice(0, PAGE_SIZE);
  const owners = await getUserNames(rows.map((row) => row.owner_id));

  return {
    hasMore: data.length > PAGE_SIZE,
    leads: rows.map((row) => ({
      id: row.id,
      fullName: row.full_name,
      phone: row.phone,
      phoneE164: row.phone_e164,
      email: row.email,
      companyName: row.company_name,
      statusId: row.status_id,
      sourceId: row.source_id,
      ownerName: row.owner_id ? (owners.get(row.owner_id) ?? null) : null,
      createdAt: row.created_at,
    })),
  };
}

export type LeadDetails = NonNullable<Awaited<ReturnType<typeof getLead>>>;

/** A live lead of the organization, or null (missing, in the recycle bin, or not visible to the user). */
export async function getLead(orgId: string, leadId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("leads")
    .select(
      "id, full_name, phone, phone_e164, email, company_name, job_title, status_id, source_id, message, disqualify_reason, owner_id, created_at, converted_at, converted_contact_id, converted_deal_id",
    )
    .eq("organization_id", orgId)
    .eq("id", leadId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    throw new Error(`lead query failed: ${error.message}`);
  }
  return data;
}
