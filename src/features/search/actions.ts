"use server";

import { notePlainText } from "@/features/activities/markdown";
import { sessionCheck } from "@/lib/auth";
import { formatMoney } from "@/lib/format";
import { isUuid, paths } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

export type SearchHit = { key: string; group: SearchGroup; title: string; subtitle: string | null; href: string };
export type SearchGroup = "leads" | "contacts" | "companies" | "deals" | "notes";

type Row = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

const ACTIVITY_LABELS: Record<string, string> = { note: "הערה", call: "שיחה", meeting: "פגישה", email: "אימייל", whatsapp: "WhatsApp", sms: "SMS" };

/** Searches the organization's records the user may see (RLS decides, in public.search_records). */
export async function searchAction(orgId: string, query: string): Promise<SearchHit[]> {
  if (!isUuid(orgId) || typeof query !== "string" || query.trim().length < 2 || query.length > 100) return [];
  if (!(await sessionCheck()).ok) return [];
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("search_records", { p_org: orgId, p_query: query.trim(), p_limit: 6 });
  if (error || !data || typeof data !== "object" || Array.isArray(data)) return [];
  const result = data as Record<string, Row[] | undefined>;
  const hits: SearchHit[] = [];
  const add = (group: SearchGroup, rows: Row[] | undefined, make: (r: Row) => Omit<SearchHit, "key" | "group"> | null) => {
    for (const r of rows ?? []) {
      const hit = make(r);
      if (hit) hits.push({ key: `${group}:${String(r.id)}`, group, ...hit });
    }
  };
  add("leads", result.leads, (r) => ({ title: str(r.title) ?? "ליד ללא שם", subtitle: str(r.subtitle), href: paths.lead(orgId, String(r.id)) }));
  add("contacts", result.contacts, (r) => ({ title: str(r.title) ?? "איש קשר בלי שם", subtitle: str(r.subtitle), href: paths.contact(orgId, String(r.id)) }));
  add("companies", result.companies, (r) => ({ title: str(r.title) ?? "חברה", subtitle: str(r.subtitle), href: paths.company(orgId, String(r.id)) }));
  add("deals", result.deals, (r) => ({ title: str(r.title) ?? "עסקה", subtitle: formatMoney(Number(r.amount_agorot ?? 0)), href: paths.deal(orgId, String(r.id)) }));
  add("notes", result.notes, (r) => {
    const href = str(r.lead_id)
      ? paths.lead(orgId, String(r.lead_id))
      : str(r.contact_id)
        ? paths.contact(orgId, String(r.contact_id))
        : str(r.deal_id)
          ? paths.deal(orgId, String(r.deal_id))
          : str(r.company_id)
            ? paths.company(orgId, String(r.company_id))
            : null;
    // REC-04: a note's formatting marks are not shown in a one-line result
    return href ? { title: notePlainText(str(r.body) ?? ""), subtitle: ACTIVITY_LABELS[String(r.type)] ?? null, href } : null;
  });
  return hits;
}
