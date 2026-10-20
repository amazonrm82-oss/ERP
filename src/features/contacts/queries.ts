import "server-only";

import type { Json } from "@/lib/database.types";

import { recordTypeNames } from "@/features/record-type-options/queries";
import { getUserNames } from "@/features/shell/queries";
import { PAGE_SIZE, personSearchFilter } from "@/lib/search";
import { sortColumn, type CustomSortKey, type Sort } from "@/lib/sort";
import { createClient } from "@/lib/supabase/server";
import { must } from "@/lib/db-read";
import { isUuid } from "@/lib/paths";

import { contactPickerName } from "./picker";

import type { StoredChannel } from "./channels";

export type ContactListItem = {
  id: string;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  phoneE164: string | null;
  email: string | null;
  jobTitle: string | null;
  companyName: string | null;
  // CON-02: the type from the list, else the older free-text type
  typeId: string | null;
  typeName: string | null;
  // CON-10: stored codes (src/features/contacts/preferences.ts)
  preferredLocale: string | null;
  preferredChannel: string | null;
  ownerId: string | null;
  ownerName: string | null;
  createdAt: string;
  customFields: Json;
};

/** Names of live companies by id (for list rows and cards). */
async function getCompanyNames(orgId: string, companyIds: Array<string | null>): Promise<Map<string, string>> {
  const ids = [...new Set(companyIds.filter((id): id is string => Boolean(id)))];
  const names = new Map<string, string>();
  if (ids.length === 0) {
    return names;
  }
  const supabase = await createClient();
  const data = must(await supabase.from("companies").select("id, name").eq("organization_id", orgId).in("id", ids), "companies");
  for (const company of data ?? []) {
    names.set(company.id, company.name);
  }
  return names;
}

// columns the contact table can be sorted by (LST-02)
// company and owner are computed fields (migration 0032)
export const CONTACT_SORT_COLUMNS = {
  name: "full_name",
  phone: "phone",
  email: "email",
  job_title: "job_title",
  company: "sort_company",
  // the type's position in the settings (CON-02)
  type: "sort_type",
  // CON-10: by the stored code, so equal choices sit together
  locale: "preferred_locale",
  channel: "preferred_channel",
  owner: "sort_owner",
  created: "created_at",
  // DQL-01: computed field public.completeness(contacts)
  completeness: "completeness",
} as const;
export type ContactSortKey = keyof typeof CONTACT_SORT_COLUMNS;
export const CONTACT_DEFAULT_SORT: Sort<ContactSortKey> = { key: "created", ascending: false };

/** One page of live contacts, newest first unless sorted otherwise. Fetches one extra row to know if there is a next page. */
export async function listContacts(
  orgId: string,
  options: { search: string; tagId?: string | null; page: number; sort?: Sort<ContactSortKey | CustomSortKey>; filter?: string | null; ids?: string[]; chunk?: { from: number; size: number } },
): Promise<{ contacts: ContactListItem[]; hasMore: boolean }> {
  const supabase = await createClient();
  // an export reads the list in larger chunks (LST-08)
  const size = options.chunk?.size ?? PAGE_SIZE;
  const from = options.chunk?.from ?? (options.page - 1) * PAGE_SIZE;

  let query = supabase
    .from("contacts")
    .select("id, full_name, first_name, last_name, phone, phone_e164, email, job_title, company_id, type_id, contact_type, preferred_locale, preferred_channel, owner_id, created_at, custom_fields")
    .eq("organization_id", orgId)
    .is("deleted_at", null);

  const searchFilter = personSearchFilter(options.search);
  if (searchFilter) {
    // CON-01: a further phone or email finds its contact too
    const byChannel = await contactIdsByChannelSearch(orgId, options.search);
    query = query.or(byChannel.length ? `${searchFilter},id.in.(${byChannel.join(",")})` : searchFilter);
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

  const sort = options.sort ?? CONTACT_DEFAULT_SORT;
  const { data, error } = await query
    .order(sortColumn(CONTACT_SORT_COLUMNS, sort.key), { ascending: sort.ascending, nullsFirst: false })
    .order("id", { ascending: sort.ascending })
    .range(from, from + size);
  if (error) {
    throw new Error(`contacts query failed: ${error.message}`);
  }

  const rows = data.slice(0, size);
  const [owners, companies, types] = await Promise.all([
    getUserNames(rows.map((row) => row.owner_id)),
    getCompanyNames(
      orgId,
      rows.map((row) => row.company_id),
    ),
    recordTypeNames(orgId, "contact"),
  ]);

  return {
    hasMore: data.length > size,
    contacts: rows.map((row) => ({
      id: row.id,
      fullName: row.full_name,
      firstName: row.first_name,
      lastName: row.last_name,
      phone: row.phone,
      phoneE164: row.phone_e164,
      email: row.email,
      jobTitle: row.job_title,
      companyName: row.company_id ? (companies.get(row.company_id) ?? null) : null,
      typeId: row.type_id,
      typeName: (row.type_id ? types.get(row.type_id) : null) ?? row.contact_type,
      preferredLocale: row.preferred_locale,
      preferredChannel: row.preferred_channel,
      ownerId: row.owner_id,
      ownerName: row.owner_id ? (owners.get(row.owner_id) ?? null) : null,
      createdAt: row.created_at,
      customFields: row.custom_fields,
    })),
  };
}

/** A live contact with its company and owner names, or null. */
export async function getContact(orgId: string, contactId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, full_name, phone, phone_e164, phone_type, email, email_type, job_title, company_id, company_matched_domain, company_match_kind, type_id, contact_type, source_id, owner_id, birth_date, preferred_locale, preferred_channel, preferred_channel_source, created_at, custom_fields, tag_ids")
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

  const [owners, companies, types, source, channels] = await Promise.all([
    getUserNames([data.owner_id]),
    getCompanyNames(orgId, [data.company_id]),
    recordTypeNames(orgId, "contact"),
    data.source_id
      ? supabase.from("lead_sources").select("name").eq("organization_id", orgId).eq("id", data.source_id).maybeSingle()
      : Promise.resolve({ data: null }),
    listContactChannels(orgId, contactId),
  ]);

  return {
    ...data,
    channels,
    ownerName: data.owner_id ? (owners.get(data.owner_id) ?? null) : null,
    companyName: data.company_id ? (companies.get(data.company_id) ?? null) : null,
    sourceName: source.data?.name ?? null,
    typeName: data.type_id ? (types.get(data.type_id) ?? null) : null,
  };
}

export type ContactChoice = { id: string; label: string };

/**
 * A contact the user may read and that is not in the bin, named for a picker's starting value (a deal opened from a
 * contact's page); null otherwise.
 */
export async function getContactChoice(orgId: string, contactId: string): Promise<ContactChoice | null> {
  if (!isUuid(contactId)) return null;
  const supabase = await createClient();
  const row = must(
    await supabase.from("contacts").select("id, full_name, email, phone").eq("organization_id", orgId).eq("id", contactId).is("deleted_at", null).maybeSingle(),
    "contact choice",
  );
  return row ? { id: row.id, label: contactPickerName(row) } : null;
}

/** CON-01: a contact's further phones and emails, in their order. */
export async function listContactChannels(orgId: string, contactId: string): Promise<StoredChannel[]> {
  const supabase = await createClient();
  const data = must(
    await supabase
      .from("contact_channels")
      .select("id, kind, label, value, value_e164, position")
      .eq("organization_id", orgId)
      .eq("contact_id", contactId)
      .order("position")
      .order("id"),
    "contact channels",
  );
  return data as StoredChannel[];
}

/**
 * CON-01: ids of contacts whose further phones or emails contain the search term, for the
 * list's search box (the primary ones are searched on the contact row itself).
 */
export async function contactIdsByChannelSearch(orgId: string, term: string): Promise<string[]> {
  const clean = term.replace(/["\\]/g, "").trim().slice(0, 100);
  if (clean.length < 2) return [];
  const digits = clean.replace(/\D/g, "").replace(/^0+/, "");
  const ors = [`value.ilike."%${clean}%"`];
  if (digits.length >= 3) ors.push(`value_e164.ilike."%${digits}%"`);
  const supabase = await createClient();
  const data = must(
    // at most 200 rows: a search term that matches more further values than that is too wide to be
    // useful, and the contact row's own phone and email are searched without this cap
    await supabase.from("contact_channels").select("contact_id").eq("organization_id", orgId).or(ors.join(",")).limit(200),
    "contact channel search",
  );
  return [...new Set(data.map((row) => row.contact_id))];
}
