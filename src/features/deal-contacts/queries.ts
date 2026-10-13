import "server-only";

import { contactDisplayName } from "@/features/contacts/display";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { dealContactRoleLabel } from "./roles";

// A deal holds a handful of contacts; this cap only keeps a broken row count from
// flooding the card.
const MAX_LINKS = 100;

export type DealContactItem = {
  contactId: string;
  role: string | null;
  roleLabel: string | null;
  // null: the caller may not read this contact (visibility "own" / "team")
  name: string | null;
  inTrash: boolean;
};

/** CON-03: the contacts linked to a deal, in the order they were added. */
export async function listDealContacts(orgId: string, dealId: string): Promise<DealContactItem[]> {
  const supabase = await createClient();
  const links = must(
    await supabase
      .from("deal_contacts")
      .select("contact_id, role, created_at")
      .eq("organization_id", orgId)
      .eq("deal_id", dealId)
      .order("created_at", { ascending: true })
      .order("contact_id", { ascending: true })
      .limit(MAX_LINKS),
    "deal contacts",
  );
  if (links.length === 0) {
    return [];
  }
  const contacts = must(
    await supabase
      .from("contacts")
      .select("id, full_name, email, phone, deleted_at")
      .eq("organization_id", orgId)
      .in(
        "id",
        links.map((link) => link.contact_id),
      ),
    "deal contact names",
  );
  const byId = new Map(contacts.map((contact) => [contact.id, contact]));
  return links.map((link) => {
    const contact = byId.get(link.contact_id);
    return {
      contactId: link.contact_id,
      role: link.role,
      roleLabel: dealContactRoleLabel(link.role),
      name: contact ? contactDisplayName({ fullName: contact.full_name, email: contact.email, phone: contact.phone }) : null,
      inTrash: Boolean(contact?.deleted_at),
    };
  });
}

export type ContactDealRole = { dealId: string; role: string | null };

/** CON-03: the deals a contact takes part in (newest link first), with the role in each. */
export async function listContactDealRoles(orgId: string, contactId: string): Promise<ContactDealRole[]> {
  const supabase = await createClient();
  const links = must(
    await supabase
      .from("deal_contacts")
      .select("deal_id, role, created_at")
      .eq("organization_id", orgId)
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .order("deal_id", { ascending: true })
      .limit(MAX_LINKS),
    "contact deal roles",
  );
  return links.map((link) => ({ dealId: link.deal_id, role: link.role }));
}
