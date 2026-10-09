import "server-only";

import type { Json } from "@/lib/database.types";

import { getUserNames } from "@/features/shell/queries";
import { PAGE_SIZE, personSearchFilter } from "@/lib/search";
import { sortColumn, type CustomSortKey, type Sort } from "@/lib/sort";
import { createClient } from "@/lib/supabase/server";

export type CompanyListItem = {
  id: string;
  name: string;
  phone: string | null;
  phoneE164: string | null;
  city: string | null;
  website: string | null;
  ownerId: string | null;
  ownerName: string | null;
  createdAt: string;
  customFields: Json;
};

// columns the company table can be sorted by (LST-02)
// owner is a computed field (migration 0032)
export const COMPANY_SORT_COLUMNS = { name: "name", phone: "phone", city: "city", website: "website", owner: "sort_owner", created: "created_at" } as const;
export type CompanySortKey = keyof typeof COMPANY_SORT_COLUMNS;
export const COMPANY_DEFAULT_SORT: Sort<CompanySortKey> = { key: "name", ascending: true };

/** One page of live companies, by name unless sorted otherwise. Fetches one extra row to know if there is a next page. */
export async function listCompanies(
  orgId: string,
  options: { search: string; tagId?: string | null; page: number; sort?: Sort<CompanySortKey | CustomSortKey>; filter?: string | null; ids?: string[]; chunk?: { from: number; size: number } },
): Promise<{ companies: CompanyListItem[]; hasMore: boolean }> {
  const supabase = await createClient();
  // an export reads the list in larger chunks (LST-08)
  const size = options.chunk?.size ?? PAGE_SIZE;
  const from = options.chunk?.from ?? (options.page - 1) * PAGE_SIZE;

  let query = supabase
    .from("companies")
    .select("id, name, phone, phone_e164, city, website, owner_id, created_at, custom_fields")
    .eq("organization_id", orgId)
    .is("deleted_at", null);
  const searchFilter = personSearchFilter(["name", "tax_id", "city"], options.search);
  if (searchFilter) {
    query = query.or(searchFilter);
  }
  if (options.tagId) {
    query = query.contains("tag_ids", [options.tagId]);
  }
  if (options.ids) {
    query = query.in("id", options.ids);
  }
  if (options.filter) {
    query = query.or(options.filter);
  }

  const sort = options.sort ?? COMPANY_DEFAULT_SORT;
  const { data, error } = await query
    .order(sortColumn(COMPANY_SORT_COLUMNS, sort.key), { ascending: sort.ascending, nullsFirst: false })
    .order("id", { ascending: sort.ascending })
    .range(from, from + size);
  if (error) {
    throw new Error(`companies query failed: ${error.message}`);
  }
  const rows = data.slice(0, size);
  const owners = await getUserNames(rows.map((row) => row.owner_id));

  return {
    hasMore: data.length > size,
    companies: rows.map((row) => ({
      id: row.id,
      name: row.name,
      phone: row.phone,
      phoneE164: row.phone_e164,
      city: row.city,
      website: row.website,
      ownerId: row.owner_id,
      ownerName: row.owner_id ? (owners.get(row.owner_id) ?? null) : null,
      createdAt: row.created_at,
      customFields: row.custom_fields,
    })),
  };
}

/** A live company with its owner's name, or null. */
export async function getCompany(orgId: string, companyId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("companies")
    .select("id, name, tax_id, industry, phone, phone_e164, email, website, city, address_line, owner_id, created_at, custom_fields, tag_ids")
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
