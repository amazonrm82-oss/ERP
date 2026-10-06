import "server-only";

import { getUserNames } from "@/features/shell/queries";
import { PAGE_SIZE, personSearchFilter } from "@/lib/search";
import { createClient } from "@/lib/supabase/server";

export type CompanyListItem = {
  id: string;
  name: string;
  phone: string | null;
  city: string | null;
  website: string | null;
  ownerName: string | null;
  createdAt: string;
};

/** One page of live companies, by name. Fetches one extra row to know if there is a next page. */
export async function listCompanies(
  orgId: string,
  options: { search: string; page: number },
): Promise<{ companies: CompanyListItem[]; hasMore: boolean }> {
  const supabase = await createClient();
  const from = (options.page - 1) * PAGE_SIZE;

  let query = supabase
    .from("companies")
    .select("id, name, phone, city, website, owner_id, created_at")
    .eq("organization_id", orgId)
    .is("deleted_at", null);
  const searchFilter = personSearchFilter(["name", "tax_id", "city"], options.search);
  if (searchFilter) {
    query = query.or(searchFilter);
  }

  const { data, error } = await query
    .order("name", { ascending: true })
    .order("id", { ascending: true })
    .range(from, from + PAGE_SIZE);
  if (error) {
    throw new Error(`companies query failed: ${error.message}`);
  }
  const rows = data.slice(0, PAGE_SIZE);
  const owners = await getUserNames(rows.map((row) => row.owner_id));

  return {
    hasMore: data.length > PAGE_SIZE,
    companies: rows.map((row) => ({
      id: row.id,
      name: row.name,
      phone: row.phone,
      city: row.city,
      website: row.website,
      ownerName: row.owner_id ? (owners.get(row.owner_id) ?? null) : null,
      createdAt: row.created_at,
    })),
  };
}

/** A live company with its owner's name, or null. */
export async function getCompany(orgId: string, companyId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("companies")
    .select("id, name, tax_id, industry, phone, phone_e164, email, website, city, address_line, owner_id, created_at")
    .eq("organization_id", orgId)
    .eq("id", companyId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    throw new Error(`company query failed: ${error.message}`);
  }
  if (!data) {
    return null;
  }
  const owners = await getUserNames([data.owner_id]);
  return { ...data, ownerName: data.owner_id ? (owners.get(data.owner_id) ?? null) : null };
}

export type CompanyOption = { id: string; name: string };

/** Companies for a "pick a company" select, by name (first 500). */
export async function listCompanyOptions(orgId: string): Promise<CompanyOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("companies")
    .select("id, name")
    .eq("organization_id", orgId)
    .is("deleted_at", null)
    .order("name", { ascending: true })
    .limit(500);
  if (error) {
    throw new Error(`company options query failed: ${error.message}`);
  }
  return data;
}

export type CompanyContact = { id: string; name: string; jobTitle: string | null; phone: string | null };

/** Live contacts that belong to the company (latest 100). */
export async function listContactsOfCompany(orgId: string, companyId: string): Promise<CompanyContact[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("contacts")
    .select("id, full_name, email, phone, job_title")
    .eq("organization_id", orgId)
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) {
    throw new Error(`company contacts query failed: ${error.message}`);
  }
  return data.map((row) => ({
    id: row.id,
    name: row.full_name || row.email || row.phone || "איש קשר ללא שם",
    jobTitle: row.job_title,
    phone: row.phone,
  }));
}
