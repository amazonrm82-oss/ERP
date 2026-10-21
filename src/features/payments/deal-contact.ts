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
