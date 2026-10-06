import "server-only";

import { getUserNames } from "@/features/shell/queries";
import { PAGE_SIZE, personSearchFilter } from "@/lib/search";
import { createClient } from "@/lib/supabase/server";

export type ContactListItem = {
  id: string;
  fullName: string | null;
  phone: string | null;
  email: string | null;
  jobTitle: string | null;
  companyName: string | null;
  ownerName: string | null;
  createdAt: string;
};

/** Names of live companies by id (for list rows and cards). */
async function getCompanyNames(orgId: string, companyIds: Array<string | null>): Promise<Map<string, string>> {
  const ids = [...new Set(companyIds.filter((id): id is string => Boolean(id)))];
  const names = new Map<string, string>();
  if (ids.length === 0) {
    return names;
  }
  const supabase = await createClient();
  const { data } = await supabase.from("companies").select("id, name").eq("organization_id", orgId).in("id", ids);
  for (const company of data ?? []) {
    names.set(company.id, company.name);
  }
  return names;
}

/** One page of live contacts, newest first. Fetches one extra row to know if there is a next page. */
export async function listContacts(
  orgId: string,
  options: { search: string; page: number },
): Promise<{ contacts: ContactListItem[]; hasMore: boolean }> {
  const supabase = await createClient();
  const from = (options.page - 1) * PAGE_SIZE;

  let query = supabase
    .from("contacts")
    .select("id, full_name, phone, email, job_title, company_id, owner_id, created_at")
    .eq("organization_id", orgId)
    .is("deleted_at", null);

  const searchFilter = personSearchFilter(["full_name"], options.search);
  if (searchFilter) {
    query = query.or(searchFilter);
  }

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, from + PAGE_SIZE);
  if (error) {
    throw new Error(`contacts query failed: ${error.message}`);
  }

  const rows = data.slice(0, PAGE_SIZE);
  const [owners, companies] = await Promise.all([
    getUserNames(rows.map((row) => row.owner_id)),
    getCompanyNames(
      orgId,
      rows.map((row) => row.company_id),
    ),
  ]);

  return {
    hasMore: data.length > PAGE_SIZE,
    contacts: rows.map((row) => ({
      id: row.id,
      fullName: row.full_name,
      phone: row.phone,
      email: row.email,
      jobTitle: row.job_title,
      companyName: row.company_id ? (companies.get(row.company_id) ?? null) : null,
      ownerName: row.owner_id ? (owners.get(row.owner_id) ?? null) : null,
      createdAt: row.created_at,
    })),
  };
}

/** A live contact with its company and owner names, or null. */
export async function getContact(orgId: string, contactId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("contacts")
    .select("id, full_name, phone, phone_e164, email, job_title, company_id, source_id, owner_id, created_at")
    .eq("organization_id", orgId)
    .eq("id", contactId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    throw new Error(`contact query failed: ${error.message}`);
  }
  if (!data) {
    return null;
  }

  const [owners, companies, source] = await Promise.all([
    getUserNames([data.owner_id]),
    getCompanyNames(orgId, [data.company_id]),
    data.source_id
      ? supabase.from("lead_sources").select("name").eq("organization_id", orgId).eq("id", data.source_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  return {
    ...data,
    ownerName: data.owner_id ? (owners.get(data.owner_id) ?? null) : null,
    companyName: data.company_id ? (companies.get(data.company_id) ?? null) : null,
    sourceName: source.data?.name ?? null,
  };
}

export type ContactOption = { id: string; name: string };

/** Recent contacts for a "pick a contact" select (latest 200). */
export async function listContactOptions(orgId: string): Promise<ContactOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("contacts")
    .select("id, full_name, email, phone")
    .eq("organization_id", orgId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) {
    throw new Error(`contact options query failed: ${error.message}`);
  }
  return data.map((row) => ({ id: row.id, name: row.full_name || row.email || row.phone || "איש קשר ללא שם" }));
}
