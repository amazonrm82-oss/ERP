import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { must } from "@/lib/db-read";
import { paths } from "@/lib/paths";
import { normalizePhone } from "@/lib/phone";

import { companyNamePattern, sameCompanyName } from "./company-name";

// The "this already exists" check before a new record is saved: first built for the lead form,
// shared with the contact and company forms (DQL-02). Reads with the user's session, so only
// records the user can see are pointed out.

type Supabase = SupabaseClient<Database>;

export type Existing = { kind: "lead" | "contact" | "company"; name: string; href: string };

const KIND_NOUN: Record<Existing["kind"], string> = { lead: "ליד", contact: "איש קשר", company: "חברה" };

/** "כבר קיים ליד עם …: name." */
export function duplicateMessage(existing: Existing, what: string): string {
  const verb = existing.kind === "company" ? "קיימת" : "קיים";
  return `כבר ${verb} ${KIND_NOUN[existing.kind]} עם ${what}: ${existing.name}.`;
}

/** The newest live, unconverted lead, else contact, with one of these phones (normalized) or emails. */
export async function findPersonDuplicate(supabase: Supabase, orgId: string, phones: Array<string | null>, emails: Array<string | null>): Promise<Existing | null> {
  const e164s = [...new Set(phones.map((p) => normalizePhone(p)).filter((p): p is string => Boolean(p)))].slice(0, 20);
  const lowered = [...new Set(emails.filter((e): e is string => Boolean(e)).map((e) => e.toLowerCase().replace(/["\\]/g, "")))].slice(0, 20);
  // emails are stored lower-cased; quoting keeps "," and ")" in a value harmless, and '"' and "\" are
  // removed (the LST-05 rule for values inside a PostgREST logic tree)
  const filters = [...e164s.map((p) => `phone_e164.eq."${p}"`), ...lowered.map((e) => `email.eq."${e}"`)];
  if (filters.length === 0) {
    return null;
  }
  for (const kind of ["lead", "contact"] as const) {
    let query = supabase
      .from(kind === "lead" ? "leads" : "contacts")
      .select("id, full_name, phone, email")
      .eq("organization_id", orgId)
      .is("deleted_at", null);
    // a converted lead lives on as its contact, which is the record to open
    if (kind === "lead") {
      query = query.is("converted_at", null);
    }
    const data = must(await query.or(filters.join(",")).order("created_at", { ascending: false }).limit(1), "duplicate search");
    const row = data?.[0];
    if (row) {
      return {
        kind,
        name: row.full_name || row.email || row.phone || "ללא שם",
        href: kind === "lead" ? paths.lead(orgId, row.id) : paths.contact(orgId, row.id),
      };
    }
  }
  // CON-01: a contact's further phone or email counts too
  const { data: matches, error } = await supabase.rpc("contact_channel_matches", { p_org: orgId, p_phones: e164s, p_emails: lowered });
  if (error) {
    throw new Error(`duplicate search: ${error.message}`);
  }
  const ids = [...new Set(matches.map((m) => m.contact_id))];
  if (ids.length > 0) {
    const contact = must(
      await supabase
        .from("contacts")
        .select("id, full_name, phone, email")
        .eq("organization_id", orgId)
        .is("deleted_at", null)
        .in("id", ids)
        .order("created_at", { ascending: false })
        .limit(1),
      "duplicate search",
    )?.[0];
    if (contact) {
      return { kind: "contact", name: contact.full_name || contact.email || contact.phone || "ללא שם", href: paths.contact(orgId, contact.id) };
    }
  }
  return null;
}

/** The newest live company with this tax id, this name (ignoring case and outer spaces) or this phone. */
export async function findCompanyDuplicate(
  supabase: Supabase,
  orgId: string,
  company: { name: string; taxId: string | null; phone: string | null },
): Promise<Existing | null> {
  const base = () => supabase.from("companies").select("id, name").eq("organization_id", orgId).is("deleted_at", null);
  const e164 = normalizePhone(company.phone);
  const found = (row: { id: string; name: string }): Existing => ({ kind: "company", name: row.name, href: paths.company(orgId, row.id) });
  if (company.taxId) {
    const row = must(await base().eq("tax_id", company.taxId).order("created_at", { ascending: false }).limit(1), "duplicate search")?.[0];
    if (row) return found(row);
  }
  // the pattern may bring back a few near names ("*" matches one character); the exact check picks
  const named = must(await base().ilike("name", companyNamePattern(company.name)).order("created_at", { ascending: false }).limit(50), "duplicate search");
  const same = named.find((row) => sameCompanyName(row.name, company.name));
  if (same) return found(same);
  if (e164) {
    const row = must(await base().eq("phone_e164", e164).order("created_at", { ascending: false }).limit(1), "duplicate search")?.[0];
    if (row) return found(row);
  }
  return null;
}
