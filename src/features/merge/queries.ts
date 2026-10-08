import "server-only";

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
  if (phone && /^\+\d{6,15}$/.test(phone)) ors.push(`phone_e164.eq.${phone}`);
  if (email && /^[^,()\s]+@[^,()\s]+$/.test(email)) ors.push(`email.ilike.${email}`);
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
  const [statuses, sources, companies, owners] = await Promise.all([
    type === "lead" ? supabase.from("lead_statuses").select("id, name").in("id", ids("status_id")) : Promise.resolve({ data: [] }),
    supabase.from("lead_sources").select("id, name").in("id", ids("source_id")),
    type === "contact" ? supabase.from("companies").select("id, name").in("id", ids("company_id")) : Promise.resolve({ data: [] }),
    getUserNames(ids("owner_id")),
  ]);
  const nameOf = (list: Array<{ id: string; name: string }> | null) => new Map((list ?? []).map((x) => [x.id, x.name]));
  const lookups: Record<string, Map<string, string>> = {
    status_id: nameOf(statuses.data),
    source_id: nameOf(sources.data),
    company_id: nameOf(companies.data),
    owner_id: owners,
  };

  const side = (r: Row): MergeSide => {
    const values: Record<string, string | null> = {};
    for (const { key } of MERGE_FIELDS[type]) {
      const v = r[key];
      if (v === null || v === undefined || v === "") values[key] = null;
      else if (lookups[key]) values[key] = lookups[key].get(String(v)) ?? "—";
      else if (key === "budget_agorot") values[key] = formatMoney(Number(v));
      else if (key === "birth_date") values[key] = formatDate(String(v));
      else values[key] = String(v);
    }
    return { id: String(r.id), title: recordTitle(type, r), values, raw: r, converted: Boolean(r.converted_at) };
  };
  return [side(keep), side(dup)];
}
