import "server-only";

import { cache } from "react";

import { requestedProductNames } from "@/features/requested-product/queries";
import { getUserNames } from "@/features/shell/queries";
import type { Json, LeadStatusKind } from "@/lib/database.types";
import { PAGE_SIZE, personSearchFilter } from "@/lib/search";
import { sortColumn, type CustomSortKey, type Sort } from "@/lib/sort";
import { createClient } from "@/lib/supabase/server";

export type LeadStatusOption = { id: string; name: string; kind: LeadStatusKind; isDefault: boolean };
export type LeadSourceOption = { id: string; name: string; isActive: boolean };

/** Statuses (in their configured order) and active sources of the organization. */
// Memoized per request (FXC-09): a list page, its filter and its table cells ask for it several times.
export const getLeadLookups = cache(async (orgId: string): Promise<{ statuses: LeadStatusOption[]; sources: LeadSourceOption[] }> => {
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
    // hidden sources stay in the list so existing leads still show their source name;
    // forms offer them only to a lead that already has one
    sources: sources.data.map((s) => ({ id: s.id, name: s.name, isActive: s.is_active })),
  };
});

export type LeadListItem = {
  id: string;
  fullName: string | null;
  phone: string | null;
  phoneE164: string | null;
  email: string | null;
  companyName: string | null;
  statusId: string;
  sourceId: string | null;
  // LEAD-04: the requested product's name (listLeads only)
  requestedProductName?: string | null;
  ownerId: string | null;
  ownerName: string | null;
  // LEAD-02: the last contact entry a person logged on the lead's timeline
  lastContactedAt: string | null;
  // LEAD-05 (listLeads only)
  score?: number;
  createdAt: string;
  customFields: Json;
};

// columns the leads table can be sorted by (LST-02); "created" newest first is the default
// status, source and owner are computed fields (migration 0032): position of the status, names of the others
export const LEAD_SORT_COLUMNS = {
  name: "full_name",
  phone: "phone",
  email: "email",
  company: "company_name",
  status: "sort_status",
  source: "sort_source",
  owner: "sort_owner",
  last_contact: "last_contacted_at",
  // LEAD-04: computed field public.sort_requested_product(leads)
  product: "sort_requested_product",
  created: "created_at",
  // DQL-01: computed field public.completeness(leads)
  completeness: "completeness",
  // LEAD-05: set by the database from the score rules
  score: "score",
} as const;
export type LeadSortKey = keyof typeof LEAD_SORT_COLUMNS;
export const LEAD_DEFAULT_SORT: Sort<LeadSortKey> = { key: "created", ascending: false };

type ListOptions = {
  search: string;
  statusId: string | null;
  tagId?: string | null;
  page: number;
  sort?: Sort<LeadSortKey | CustomSortKey>;
  // the advanced filter as a PostgREST logic tree (LST-05)
  filter?: string | null;
  // only these rows (an export of the picked rows), and a chunk instead of a page
  ids?: string[];
  chunk?: { from: number; size: number };
};

/** One page of live leads, newest first unless sorted otherwise. Fetches one extra row to know if there is a next page. */
export async function listLeads(orgId: string, options: ListOptions): Promise<{ leads: LeadListItem[]; hasMore: boolean }> {
  const supabase = await createClient();
  // an export reads the list in larger chunks (LST-08)
  const size = options.chunk?.size ?? PAGE_SIZE;
  const from = options.chunk?.from ?? (options.page - 1) * PAGE_SIZE;

  let query = supabase
    .from("leads")
    .select("id, full_name, phone, phone_e164, email, company_name, status_id, source_id, requested_product_id, owner_id, last_contacted_at, score, created_at, custom_fields")
    .eq("organization_id", orgId)
    .is("deleted_at", null);

  if (options.statusId) {
    query = query.eq("status_id", options.statusId);
  }
  if (options.tagId) {
    query = query.contains("tag_ids", [options.tagId]);
  }
  const searchFilter = personSearchFilter(options.search);
  if (searchFilter) {
    query = query.or(searchFilter);
  }
  if (options.ids) {
    query = query.in("id", options.ids);
  }
  if (options.filter) {
    query = query.or(options.filter);
  }

  const sort = options.sort ?? LEAD_DEFAULT_SORT;
  const { data, error } = await query
    .order(sortColumn(LEAD_SORT_COLUMNS, sort.key), { ascending: sort.ascending, nullsFirst: false })
    .order("id", { ascending: sort.ascending })
    .range(from, from + size);
  if (error) {
    throw new Error(`leads query failed: ${error.message}`);
  }

  const rows = data.slice(0, size);
  // LEAD-04: product names only when a row has one
  const [owners, productNames] = await Promise.all([
    getUserNames(rows.map((row) => row.owner_id)),
    requestedProductNames(orgId, rows.map((row) => row.requested_product_id)),
  ]);

  return {
    hasMore: data.length > size,
    leads: rows.map((row) => ({
      id: row.id,
      fullName: row.full_name,
      phone: row.phone,
      phoneE164: row.phone_e164,
      email: row.email,
      companyName: row.company_name,
      statusId: row.status_id,
      sourceId: row.source_id,
      requestedProductName: row.requested_product_id ? (productNames.get(row.requested_product_id) ?? null) : null,
      ownerId: row.owner_id,
      ownerName: row.owner_id ? (owners.get(row.owner_id) ?? null) : null,
      lastContactedAt: row.last_contacted_at,
      score: row.score,
      createdAt: row.created_at,
      customFields: row.custom_fields,
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
      "id, full_name, phone, phone_e164, email, company_name, job_title, status_id, source_id, requested_product_id, preferred_channel, preferred_channel_source, preferred_locale, message, disqualify_reason, owner_id, last_contacted_at, created_at, converted_at, converted_contact_id, converted_deal_id, custom_fields, tag_ids, campaign, utm, budget_agorot, referrer_url, landing_url, gclid, fbclid, ctwa_clid, meta_lead_id",
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

// how many leads a board column shows; the column header has the exact count
export const LEAD_COLUMN_LIMIT = 50;

export type LeadBoardCard = { id: string; fullName: string | null; companyName: string | null; phone: string | null; statusId: string; ownerName: string | null };
export type LeadBoard = {
  // every status a lead can be moved to by hand ("converted" is set by the conversion)
  statuses: LeadStatusOption[];
  cards: LeadBoardCard[];
  counts: Record<string, number>;
};

/** Live leads that were not converted, by status: the newest per column, and exact counts. */
export async function getLeadBoard(orgId: string, options: { search: string; tagId: string | null; filter?: string | null }): Promise<LeadBoard> {
  const supabase = await createClient();
  const { statuses: all } = await getLeadLookups(orgId);
  const statuses = all.filter((status) => status.kind !== "converted");
  const searchFilter = personSearchFilter(options.search);

  // the same filters on the rows and on the count of each column
  type Filterable<Q> = {
    eq(column: string, value: string): Q;
    is(column: string, value: null): Q;
    contains(column: string, value: string[]): Q;
    or(filters: string): Q;
  };
  const filtered = <Q extends Filterable<Q>>(query: Q, statusId: string): Q => {
    let next = query.eq("organization_id", orgId).eq("status_id", statusId).is("deleted_at", null).is("converted_at", null);
    if (options.tagId) next = next.contains("tag_ids", [options.tagId]);
    if (searchFilter) next = next.or(searchFilter);
    if (options.filter) next = next.or(options.filter);
    return next;
  };

  const columns = await Promise.all(
    statuses.map(async (status) => {
      const [rows, count] = await Promise.all([
        filtered(supabase.from("leads").select("id, full_name, company_name, phone, status_id, owner_id"), status.id)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(LEAD_COLUMN_LIMIT),
        filtered(supabase.from("leads").select("id", { count: "exact", head: true }), status.id),
      ]);
      if (rows.error) throw new Error(`lead board query failed: ${rows.error.message}`);
      return { statusId: status.id, rows: rows.data, count: count.count ?? 0 };
    }),
  );

  const owners = await getUserNames(columns.flatMap((c) => c.rows.map((row) => row.owner_id)));
  return {
    statuses,
    cards: columns.flatMap((c) =>
      c.rows.map((row) => ({
        id: row.id,
        fullName: row.full_name,
        companyName: row.company_name,
        phone: row.phone,
        statusId: row.status_id,
        ownerName: row.owner_id ? (owners.get(row.owner_id) ?? null) : null,
      })),
    ),
    counts: Object.fromEntries(columns.map((c) => [c.statusId, c.count])),
  };
}
