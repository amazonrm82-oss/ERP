import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

// PAY-01, and DOC-01 since RVW-45: a payment or a document recorded on a deal is also its contact's, when the user reads
// that contact (live, not in the bin; the insert policies ask for it). Then a privacy erasure of the contact reaches it
// directly (app.audit_erase_core finds them through their contact_id). Read with the user's session.

/** The deal's contact the user may link, else null; or the read error. */
export async function readableDealContact(
  supabase: SupabaseClient<Database>,
  orgId: string,
  dealId: string,
): Promise<{ contactId: string | null; error: null } | { contactId: null; error: { code?: string; message?: string; hint?: string } }> {
  const deal = await supabase.from("deals").select("contact_id").eq("organization_id", orgId).eq("id", dealId).maybeSingle();
  if (deal.error) return { contactId: null, error: deal.error };
  if (!deal.data?.contact_id) return { contactId: null, error: null };
  const contact = await supabase.from("contacts").select("id").eq("organization_id", orgId).eq("id", deal.data.contact_id).is("deleted_at", null).maybeSingle();
  if (contact.error) return { contactId: null, error: contact.error };
  return { contactId: contact.data?.id ?? null, error: null };
}

type DbError = { code?: string; message?: string; hint?: string };

/** A contact the user reads (live, not in the bin), else null; or the read error. */
async function readableContact(supabase: SupabaseClient<Database>, orgId: string, contactId: string): Promise<{ id: string | null; error: DbError | null }> {
  const contact = await supabase.from("contacts").select("id").eq("organization_id", orgId).eq("id", contactId).is("deleted_at", null).maybeSingle();
  return contact.error ? { id: null, error: contact.error } : { id: contact.data?.id ?? null, error: null };
}

/**
 * Where a new document or payment hangs (ORD-06 part two): on a deal (with its readable contact), on a contact, or on an
 * order: the order's own deal (with the order's contact when the user reads it), else the order's own contact. `missing`
 * when the order is not one the user reads; the database refuses a draft order (order_link:draft).
 */
export async function moneyRowParents(
  supabase: SupabaseClient<Database>,
  orgId: string,
  subject: { kind: "deal" | "contact" | "order"; id: string },
): Promise<{ deal_id: string | null; contact_id: string | null; order_id: string | null } | { missing: true } | { error: DbError }> {
  if (subject.kind === "contact") return { deal_id: null, contact_id: subject.id, order_id: null };
  if (subject.kind === "deal") {
    const found = await readableDealContact(supabase, orgId, subject.id);
    return found.error ? { error: found.error } : { deal_id: subject.id, contact_id: found.contactId, order_id: null };
  }
  const order = await supabase.from("orders").select("deal_id, contact_id").eq("organization_id", orgId).eq("id", subject.id).maybeSingle();
  if (order.error) return { error: order.error };
  if (!order.data) return { missing: true };
  if (order.data.deal_id) {
    const contact = order.data.contact_id ? await readableContact(supabase, orgId, order.data.contact_id) : { id: null, error: null };
    if (contact.error) return { error: contact.error };
    return { deal_id: order.data.deal_id, contact_id: contact.id, order_id: subject.id };
  }
  return { deal_id: null, contact_id: order.data.contact_id, order_id: subject.id };
}
