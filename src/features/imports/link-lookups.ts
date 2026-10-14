import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { normalizePhone } from "@/lib/phone";
import { readAllPagesByIds } from "@/lib/paged-read";

import { nameKey, type PersonKey } from "./record-cells";
import { restorePhone } from "./server";

// IMP-03: finding the records a deal or a task row points at, with the user's session. A record
// the user cannot read is not found (RLS decides), and the database refuses such a link anyway
// (tasks_insert, can_read_task_links). One lookup per kind per chunk.

type Client = SupabaseClient<Database>;

/** A read the chunk cannot do without failed: the import stops rather than guess (FXC-02). */
export class LinkLookupFailed extends Error {}

/** What a cell found: one record, none, or more than one (the row then fails; the import never picks). */
export type Found = { id: string } | "missing" | "ambiguous";

const one = (ids: Iterable<string>): Found => {
  const set = [...new Set(ids)];
  return set.length === 1 ? { id: set[0] } : set.length === 0 ? "missing" : "ambiguous";
};

const present = (values: Array<string | null>) => [...new Set(values.filter((v): v is string => Boolean(v)))];

/** The key a person cell is looked up by: the lower-case email, or the phone in E.164. */
export function personLookupKey(key: PersonKey): string | null {
  return key.kind === "email" ? key.value : normalizePhone(restorePhone(key.value));
}

/** Active members who may own records, by lower-case email or name; null = two members share that name. */
export type Owners = Map<string, string | null>;

/** Active members who may own records (not viewers), by lower-case email and by name. */
export async function loadOwners(supabase: Client, orgId: string): Promise<Owners> {
  const { data: members, error } = await supabase.from("memberships").select("user_id").eq("organization_id", orgId).eq("status", "active").neq("role", "viewer");
  if (error) throw new LinkLookupFailed(error.message);
  const ids = members.map((m) => m.user_id);
  const owners: Owners = new Map();
  if (ids.length === 0) return owners;
  const { data: profiles, error: profileError } = await supabase.from("profiles").select("id, full_name, email").in("id", ids);
  if (profileError) throw new LinkLookupFailed(profileError.message);
  const put = (key: string, id: string) => owners.set(key, owners.has(key) && owners.get(key) !== id ? null : id);
  // names first, then emails: an email always names one person, even when it equals someone's name
  for (const p of profiles) if (p.full_name) put(p.full_name.trim().toLowerCase(), p.id);
  for (const p of profiles) if (p.email) owners.set(p.email.trim().toLowerCase(), p.id);
  return owners;
}

/** The owner a cell names (email or full name); two members with that name is an error, never a guess. */
export function ownerOf(owners: Owners, cell: string): { ok: true; id: string } | { ok: false; message: string } {
  const found = owners.get(cell.trim().toLowerCase());
  if (found === undefined) return { ok: false, message: `לא נמצא משתמש פעיל "${cell}" (לפי אימייל או שם).` };
  if (found === null) return { ok: false, message: `יש כמה משתמשים בשם "${cell}". כתבו את האימייל של האחראי.` };
  return { ok: true, id: found };
}

/** Leads or contacts by email or phone (a contact's further phones and emails count too, CON-01). */
export async function findPeople(supabase: Client, orgId: string, entity: "lead" | "contact", keys: PersonKey[]): Promise<Map<string, Found>> {
  const result = new Map<string, Found>();
  const lookup = present(keys.map(personLookupKey));
  if (lookup.length === 0) return result;
  const phones = lookup.filter((k) => k.startsWith("+"));
  const emails = lookup.filter((k) => !k.startsWith("+"));
  const { data, error } = await supabase.rpc("import_find_duplicates", { p_org: orgId, p_entity: entity, p_phones: phones, p_emails: emails, p_tax_ids: [], p_names: [] });
  if (error) throw new LinkLookupFailed(error.message);
  const hits = new Map<string, Set<string>>();
  const add = (k: string | null, id: string) => {
    if (!k) return;
    const set = hits.get(k) ?? new Set<string>();
    set.add(id);
    hits.set(k, set);
  };
  for (const r of data) {
    add(r.phone_e164, r.id);
    add(r.email?.toLowerCase() ?? null, r.id);
  }
  if (entity === "contact") {
    const { data: channels, error: channelError } = await supabase.rpc("contact_channel_matches", { p_org: orgId, p_phones: phones, p_emails: emails });
    if (channelError) throw new LinkLookupFailed(channelError.message);
    for (const c of channels) add(c.kind === "email" ? c.value.toLowerCase() : c.value, c.contact_id);
  }
  for (const k of lookup) result.set(k, one(hits.get(k) ?? []));
  return result;
}

/**
 * Companies by name (without case), else by domain (CON-09's rule: public.company_domain_matches,
 * the first tier of matches). Keys of the result: the name key, and "@<domain>".
 */
export async function findCompanies(supabase: Client, orgId: string, keys: Array<{ name: string; domain: string | null }>): Promise<Map<string, Found>> {
  const result = new Map<string, Found>();
  const names = present(keys.map((k) => k.name));
  if (names.length === 0) return result;
  const { data, error } = await supabase.rpc("import_find_duplicates", { p_org: orgId, p_entity: "company", p_phones: [], p_emails: [], p_tax_ids: [], p_names: names });
  if (error) throw new LinkLookupFailed(error.message);
  const byName = new Map<string, Set<string>>();
  for (const c of data) {
    if (!c.name) continue;
    const set = byName.get(nameKey(c.name)) ?? new Set<string>();
    set.add(c.id);
    byName.set(nameKey(c.name), set);
  }
  for (const k of keys) result.set(nameKey(k.name), one(byName.get(nameKey(k.name)) ?? []));
  const domains = present(keys.filter((k) => k.domain && result.get(nameKey(k.name)) === "missing").map((k) => k.domain));
  for (const domain of domains) {
    const { data: matches, error: domainError } = await supabase.rpc("company_domain_matches", { p_org: orgId, p_email: `x@${domain}` });
    if (domainError) throw new LinkLookupFailed(domainError.message);
    result.set(`@${domain}`, one(matches.map((m) => m.id)));
  }
  return result;
}

/** The company a cell found: by its name, else by its domain. */
export function companyFound(found: Map<string, Found>, key: { name: string; domain: string | null }): Found {
  const byName = found.get(nameKey(key.name)) ?? "missing";
  if (byName !== "missing" || !key.domain) return byName;
  return found.get(`@${key.domain}`) ?? "missing";
}

/**
 * Deals (not in the recycle bin) whose whole name equals the cell, through public.deal_name_matches
 * (security invoker, RLS decides): names travel in the request body, so quotes, commas and long
 * Hebrew names are safe (a URL filter is not).
 */
export async function findDeals(supabase: Client, orgId: string, names: string[]): Promise<Map<string, Found>> {
  const result = new Map<string, Found>();
  const wanted = present(names);
  if (wanted.length === 0) return result;
  const rows = await readAllPagesByIds(wanted, async (slice, from, to) => {
    const { data, error } = await supabase.rpc("deal_name_matches", { p_org: orgId, p_names: slice }).order("id", { ascending: true }).range(from, to);
    if (error) throw new LinkLookupFailed(error.message);
    return data;
  });
  for (const name of wanted) result.set(name, one(rows.filter((r) => r.name === name).map((r) => r.id)));
  return result;
}

const LINK_WORDS = {
  lead: { missing: "לא נמצא ליד", many: "נמצא יותר מליד אחד עם" },
  contact: { missing: "לא נמצא איש קשר", many: "נמצא יותר מאיש קשר אחד עם" },
  company: { missing: "לא נמצאה חברה", many: "נמצאה יותר מחברה אחת עם" },
  deal: { missing: "לא נמצאה עסקה בשם", many: "נמצאה יותר מעסקה אחת בשם" },
} as const;

/** The message for a link that is not one record. */
export function linkMessage(found: "missing" | "ambiguous", kind: keyof typeof LINK_WORDS, value: string): string {
  const words = LINK_WORDS[kind];
  return found === "missing"
    ? `${words.missing} "${value}" שיש לכם הרשאה לראות.`
    : `${words.many} "${value}". השורה לא יובאה, כדי לא לקשר לרשומה הלא נכונה.`;
}

/** The business's time zone, read with the user's session. */
export async function orgTimeZone(supabase: Client, orgId: string): Promise<string | undefined> {
  const { data, error } = await supabase.from("organizations").select("timezone").eq("id", orgId).maybeSingle();
  if (error) throw new LinkLookupFailed(error.message);
  return data?.timezone || undefined;
}
