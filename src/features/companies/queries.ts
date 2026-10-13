import "server-only";

import type { Json } from "@/lib/database.types";

import { recordTypeNames } from "@/features/record-type-options/queries";
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
  // CON-02: the type from the list, else the older free-text type
  typeId: string | null;
  typeName: string | null;
  ownerId: string | null;
  ownerName: string | null;
  createdAt: string;
  customFields: Json;
};

// columns the company table can be sorted by (LST-02)
// owner and type are computed fields (migration 0032, record_types)
export const COMPANY_SORT_COLUMNS = {
  name: "name",
  phone: "phone",
  city: "city",
  website: "website",
  type: "sort_type",
  owner: "sort_owner",
  created: "created_at",
} as const;
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
    .select("id, name, phone, phone_e164, city, website, type_id, company_type, owner_id, created_at, custom_fields")
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
  const [owners, types] = await Promise.all([getUserNames(rows.map((row) => row.owner_id)), recordTypeNames(orgId, "company")]);

  return {
    hasMore: data.length > size,
    companies: rows.map((row) => ({
      id: row.id,
      name: row.name,
      phone: row.phone,
      phoneE164: row.phone_e164,
      city: row.city,
      website: row.website,
      typeId: row.type_id,
      typeName: (row.type_id ? types.get(row.type_id) : null) ?? row.company_type,
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
    .select("id, name, country, tax_id, industry, phone, phone_e164, email, website, city, address_line, type_id, company_type, owner_id, created_at, custom_fields, tag_ids, parent_company_id")
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
  const [owners, types] = await Promise.all([getUserNames([data.owner_id]), recordTypeNames(orgId, "company")]);
  return {
    ...data,
    ownerName: data.owner_id ? (owners.get(data.owner_id) ?? null) : null,
    typeName: data.type_id ? (types.get(data.type_id) ?? null) : null,
  };
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

/** How many child companies the company page lists (CON-07). */
export const CHILD_COMPANIES_SHOWN = 20;

export type CompanyLink = { id: string; name: string; city: string | null };
export type CompanyParent =
  // a live company the user reads
  | { state: "live"; id: string; name: string }
  // the parent is in the recycle bin (the link stays until it is purged)
  | { state: "trashed"; id: string; name: string }
  // set, but the user may not read it
  | { state: "hidden"; id: string };

/**
 * CON-07: the company's parent and its child companies, read with the user's rights:
 * children the user may not read are not listed and not counted.
 */
export async function getCompanyFamily(
  orgId: string,
  companyId: string,
  parentId: string | null,
): Promise<{ parent: CompanyParent | null; children: CompanyLink[]; childCount: number }> {
  const supabase = await createClient();
  const [parentResult, childResult] = await Promise.all([
    parentId
      ? supabase.from("companies").select("id, name, deleted_at").eq("organization_id", orgId).eq("id", parentId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabase
      .from("companies")
      .select("id, name, city", { count: "exact" })
      .eq("organization_id", orgId)
      .eq("parent_company_id", companyId)
      .is("deleted_at", null)
      .order("name", { ascending: true })
      .order("id", { ascending: true })
      .limit(CHILD_COMPANIES_SHOWN),
  ]);
  if (parentResult.error) {
    throw new Error(`parent company query failed: ${parentResult.error.message}`);
  }
  if (childResult.error) {
    throw new Error(`child companies query failed: ${childResult.error.message}`);
  }
  const row = parentResult.data;
  const parent: CompanyParent | null = !parentId
    ? null
    : !row
      ? { state: "hidden", id: parentId }
      : { state: row.deleted_at ? "trashed" : "live", id: row.id, name: row.name };
  return { parent, children: childResult.data, childCount: childResult.count ?? childResult.data.length };
}
