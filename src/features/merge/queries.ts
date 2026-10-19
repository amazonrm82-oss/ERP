import "server-only";

import { paymentTermsOf, paymentTermsText } from "@/features/billing/terms";
import { countryName, ISRAEL } from "@/features/companies/countries";
import { channelTypeLabel } from "@/features/contacts/channels";
import { channelDetail, localeLabel } from "@/features/contacts/preferences";
import { getUserNames } from "@/features/shell/queries";
import { formatDate, formatMoney } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

import { MERGE_FIELDS, MERGE_TABLE, type MergeType } from "./fields";
import { must } from "@/lib/db-read";

export type Candidate = { id: string; title: string; subtitle: string | null };
type Row = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export function recordTitle(type: MergeType, row: Row): string {
  if (type === "company") return str(row.name) ?? "חברה";
  return str(row.full_name) ?? str(row.email) ?? str(row.phone) ?? "בלי שם";
}

/** Records of the same type with the same phone, email (or a company's tax id). What the user may see only. */
export async function findDuplicateCandidates(orgId: string, type: MergeType, id: string): Promise<Candidate[]> {
  const supabase = await createClient();
  const table = MERGE_TABLE[type];
  const self = must(await supabase.from(table).select("*").eq("organization_id", orgId).eq("id", id).maybeSingle(), "self");
  if (!self) return [];
  const row = self as Row;
  const ors: string[] = [];
  const phone = str(row.phone_e164);
  const email = str(row.email);
  const taxId = type === "company" ? str(row.tax_id) : null;
  if (type === "contact") {
    // CON-01: every phone and email of the contact, against every phone and email of the others
    const own = must(
      await supabase.from("contact_channels").select("kind, value, value_e164").eq("organization_id", orgId).eq("contact_id", id),
      "channels",
    );
    const phones = [...new Set([phone, ...own.map((c) => c.value_e164)].filter((p): p is string => Boolean(p && /^\+\d{6,15}$/.test(p))))];
    const emails = [
      ...new Set([email, ...own.filter((c) => c.kind === "email").map((c) => c.value)].filter((e): e is string => Boolean(e && /^[^,()"\\\s]+@[^,()"\\\s]+$/.test(e)))),
    ].map((e) => e.toLowerCase());
    if (phones.length) ors.push(`phone_e164.in.(${phones.join(",")})`);
    if (emails.length) ors.push(`email.in.(${emails.map((e) => `"${e}"`).join(",")})`);
    if (phones.length || emails.length) {
      const { data: matches, error } = await supabase.rpc("contact_channel_matches", { p_org: orgId, p_phones: phones, p_emails: emails });
      if (error) throw new Error(`duplicate candidates: ${error.message}`);
      const ids = [...new Set(matches.map((m) => m.contact_id))].filter((x) => x !== id);
      if (ids.length) ors.push(`id.in.(${ids.join(",")})`);
    }
  } else {
    if (phone && /^\+\d{6,15}$/.test(phone)) ors.push(`phone_e164.eq.${phone}`);
    if (email && /^[^,()\s]+@[^,()\s]+$/.test(email)) ors.push(`email.ilike.${email}`);
  }
  if (taxId && /^\d{5,12}$/.test(taxId)) ors.push(`tax_id.eq.${taxId}`);
  if (ors.length === 0) return [];
  const data = must(await supabase
    .from(table)
    .select("*")
    .eq("organization_id", orgId)
    .is("deleted_at", null)
    .neq("id", id)
    .or(ors.join(","))
    .limit(5), "data");
  return ((data ?? []) as Row[]).map((r) => ({
    id: String(r.id),
    title: recordTitle(type, r),
    subtitle: str(r.phone) ?? str(r.email),
  }));
}

/**
 * A field as the merge screen shows it, together with the columns that are taken with it (MERGE_COMPANIONS), so a
 * difference in a companion alone (the phone's type, the payment days) shows as a difference to pick.
 */
function companionText(type: MergeType, key: string, value: string, r: Row): string {
  if (type === "contact" && key === "phone") return withNote(value, channelTypeLabel("phone", str(r.phone_type)));
  if (type === "contact" && key === "email") return withNote(value, channelTypeLabel("email", str(r.email_type)));
  if (key === "preferred_locale") return localeLabel(value) ?? value;
  if (key === "preferred_channel") return channelDetail(value, str(r.preferred_channel_source)) ?? value;
  if (key === "payment_terms") return paymentTermsText(paymentTermsOf(value, typeof r.payment_days === "number" ? r.payment_days : null)) ?? value;
  if (type === "company" && key === "tax_id") {
    const country = str(r.country) ?? ISRAEL;
    return country === ISRAEL ? value : withNote(value, countryName(country));
  }
  return value;
}

const withNote = (value: string, note: string | null) => (note ? `${value} (${note})` : value);

export type MergeSide = { id: string; title: string; values: Record<string, string | null>; raw: Record<string, unknown>; converted: boolean };

/** Both records, with each mergeable field as the text the user sees. Null when one is missing or hidden. */
export async function loadMergePair(orgId: string, type: MergeType, keepId: string, mergeId: string): Promise<[MergeSide, MergeSide] | null> {
  const supabase = await createClient();
  const table = MERGE_TABLE[type];
  const data = must(await supabase.from(table).select("*").eq("organization_id", orgId).is("deleted_at", null).in("id", [keepId, mergeId]), "data");
  const rows = (data ?? []) as Row[];
  const keep = rows.find((r) => r.id === keepId);
  const dup = rows.find((r) => r.id === mergeId);
  if (!keep || !dup) return null;

  const ids = (key: string) => [keep[key], dup[key]].filter((v): v is string => typeof v === "string");
  const none = Promise.resolve({ data: [] as Array<{ id: string; name: string }>, error: null });
  const [statuses, sources, companies, owners, recordTypes, priceLists, products] = await Promise.all([
    type === "lead" ? supabase.from("lead_statuses").select("id, name, kind").in("id", ids("status_id")) : Promise.resolve({ data: [] }),
    supabase.from("lead_sources").select("id, name").in("id", ids("source_id")),
    type === "contact" ? supabase.from("companies").select("id, name").in("id", ids("company_id")) : Promise.resolve({ data: [] }),
    getUserNames(ids("owner_id")),
    type === "lead" ? none : supabase.from("record_type_options").select("id, name").eq("organization_id", orgId).in("id", ids("type_id")),
    type === "lead" ? none : supabase.from("price_lists").select("id, name").eq("organization_id", orgId).in("id", ids("price_list_id")),
    type === "lead" ? supabase.from("products").select("id, name").eq("organization_id", orgId).in("id", ids("requested_product_id")) : none,
  ]);
  const nameOf = (list: Array<{ id: string; name: string }> | null) => new Map((list ?? []).map((x) => [x.id, x.name]));
  const lookups: Record<string, Map<string, string>> = {
    status_id: nameOf(statuses.data),
    source_id: nameOf(sources.data),
    company_id: nameOf(companies.data),
    owner_id: owners,
    type_id: nameOf(must(recordTypes, "record types")),
    price_list_id: nameOf(must(priceLists, "price lists")),
    requested_product_id: nameOf(must(products, "products")),
  };

  // a "not relevant" status is shown with its reason, which is merged with it (RVW-9)
  const disqualified = new Set(((statuses.data ?? []) as Array<{ id: string; kind?: string }>).filter((s) => s.kind === "disqualified").map((s) => s.id));

  const side = (r: Row): MergeSide => {
    const values: Record<string, string | null> = {};
    for (const { key } of MERGE_FIELDS[type]) {
      const v = r[key];
      if (v === null || v === undefined || v === "") values[key] = null;
      else if (key === "status_id" && disqualified.has(String(v)) && str(r.disqualify_reason))
        values[key] = `${lookups[key].get(String(v)) ?? "—"}: ${str(r.disqualify_reason)}`;
      else if (lookups[key]) values[key] = lookups[key].get(String(v)) ?? "—";
      else if (key === "budget_agorot") values[key] = formatMoney(Number(v));
      else if (key === "birth_date") values[key] = formatDate(String(v));
      else values[key] = companionText(type, key, String(v), r);
    }
    return { id: String(r.id), title: recordTitle(type, r), values, raw: r, converted: Boolean(r.converted_at) };
  };
  return [side(keep), side(dup)];
}
