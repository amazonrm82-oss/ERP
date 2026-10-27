"use server";

import { notePlainText } from "@/features/activities/markdown";
import { withOrdersPlan } from "@/features/modules/modules";
import { getOrgModules } from "@/features/modules/queries";
import { getMyPermissions } from "@/features/permissions/queries";
import { orgHasFeature } from "@/features/settings/queries";
import { settingsAccessFor } from "@/features/settings/sections";
import { getOrgContext } from "@/features/shell/queries";
import { getOrgTerms } from "@/features/terminology/queries";
import { sessionCheck } from "@/lib/auth";
import { formatMoney } from "@/lib/format";
import { isUuid, paths } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

import { buildCommands, type Command } from "./commands";

export type SearchHit = { key: string; group: SearchGroup; title: string; subtitle: string | null; href: string };
export type SearchGroup = "leads" | "contacts" | "companies" | "deals" | "notes";

type Row = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

const ACTIVITY_LABELS: Record<string, string> = { note: "הערה", call: "שיחה", meeting: "פגישה", email: "אימייל", whatsapp: "WhatsApp", sms: "SMS", import_note: "הערה מייבוא", share_note: "הערת שיתוף" };

/** Searches the organization's records the user may see (RLS decides, in public.search_records). */
export async function searchAction(orgId: string, query: string): Promise<SearchHit[]> {
  if (!isUuid(orgId) || typeof query !== "string" || query.trim().length < 2 || query.length > 100) return [];
  if (!(await sessionCheck()).ok) return [];
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("search_records", { p_org: orgId, p_query: query.trim(), p_limit: 6 });
  if (error || !data || typeof data !== "object" || Array.isArray(data)) return [];
  const result = data as Record<string, Row[] | undefined>;
  // LEAD-08: a switched-off module's records are not offered (their pages show the "module is off" screen)
  const modules = await getOrgModules(orgId);
  const hits: SearchHit[] = [];
  const add = (group: SearchGroup, rows: Row[] | undefined, make: (r: Row) => Omit<SearchHit, "key" | "group"> | null) => {
    for (const r of rows ?? []) {
      const hit = make(r);
      if (hit) hits.push({ key: `${group}:${String(r.id)}`, group, ...hit });
    }
  };
  if (modules.leads) add("leads", result.leads, (r) => ({ title: str(r.title) ?? "ליד ללא שם", subtitle: str(r.subtitle), href: paths.lead(orgId, String(r.id)) }));
  add("contacts", result.contacts, (r) => ({ title: str(r.title) ?? "איש קשר בלי שם", subtitle: str(r.subtitle), href: paths.contact(orgId, String(r.id)) }));
  if (modules.companies) add("companies", result.companies, (r) => ({ title: str(r.title) ?? "חברה", subtitle: str(r.subtitle), href: paths.company(orgId, String(r.id)) }));
  add("deals", result.deals, (r) => ({ title: str(r.title) ?? "עסקה", subtitle: formatMoney(Number(r.amount_agorot ?? 0)), href: paths.deal(orgId, String(r.id)) }));
  add("notes", result.notes, (r) => {
    const href = str(r.lead_id) && modules.leads
      ? paths.lead(orgId, String(r.lead_id))
      : str(r.contact_id)
        ? paths.contact(orgId, String(r.contact_id))
        : str(r.deal_id)
          ? paths.deal(orgId, String(r.deal_id))
          : str(r.company_id) && modules.companies
            ? paths.company(orgId, String(r.company_id))
            : null;
    // REC-04: a note's formatting marks are not shown in a one-line result
    return href ? { title: notePlainText(str(r.body) ?? ""), subtitle: ACTIVITY_LABELS[String(r.type)] ?? null, href } : null;
  });
  return hits;
}

/**
 * REC-09: the actions and places the command palette may offer this person, worked out from the same rules as the menu,
 * the "+" menu and the settings list (role, extra permissions, modules, plan, the business's words). Asked once when the
 * palette first opens; the matching happens in the browser. Any failure gives an empty list: the record search still works.
 */
export async function commandsAction(orgId: string): Promise<Command[]> {
  if (!isUuid(orgId)) return [];
  if (!(await sessionCheck()).ok) return [];
  try {
    const { role, canWrite, canDelete } = await getOrgContext(orgId);
    const [terms, storedModules, priceLists, granted] = await Promise.all([
      getOrgTerms(orgId),
      getOrgModules(orgId),
      orgHasFeature(orgId, "price_lists"),
      getMyPermissions(orgId),
    ]);
    // ORD-01: orders only while the plan holds them too, like the menu
    const ordersInPlan = storedModules.orders ? await orgHasFeature(orgId, "orders").catch(() => false) : false;
    const modules = withOrdersPlan(storedModules, ordersInPlan);
    return buildCommands(orgId, terms, modules, {
      canWrite,
      settings: settingsAccessFor({ role, canWrite, canDelete, priceLists, granted }),
    });
  } catch {
    return [];
  }
}
