import "server-only";

import { contactDisplayName } from "@/features/contacts/display";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { linkRole, type DealContactRoleOption } from "./roles";

// A deal holds a handful of contacts; this cap only keeps a broken row count from
// flooding the card.
const MAX_LINKS = 100;

export type DealContactItem = {
  contactId: string;
  // the link's role on the list (also for a link saved before the list), null for none
  roleId: string | null;
  roleLabel: string | null;
  // null: the caller may not read this contact (visibility "own" / "team")
  name: string | null;
  inTrash: boolean;
};

/** CON-03 follow-up: the organization's list of roles, hidden ones included, in the order the admin set. */
export async function listDealContactRoles(orgId: string): Promise<DealContactRoleOption[]> {
  const supabase = await createClient();
  const rows =
    must(
      await supabase
        .from("deal_contact_roles")
        .select("id, name, key, position, is_active, created_at")
        .eq("organization_id", orgId)
        .order("position", { ascending: true })
        .order("created_at", { ascending: true }),
      "deal contact roles",
    ) ?? [];
  return rows.map((row) => ({ id: row.id, name: row.name, key: row.key, isActive: row.is_active }));
}

/** CON-03: the contacts linked to a deal, in the order they were added, with the role from the list. */
export async function listDealContacts(orgId: string, dealId: string, roles: DealContactRoleOption[]): Promise<DealContactItem[]> {
  const supabase = await createClient();
  const links = must(
    await supabase
      .from("deal_contacts")
      .select("contact_id, role, role_id, created_at")
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
    const role = linkRole({ roleId: link.role_id, role: link.role }, roles);
    return {
      contactId: link.contact_id,
      roleId: role?.id ?? null,
      roleLabel: role?.name ?? null,
      name: contact ? contactDisplayName({ fullName: contact.full_name, email: contact.email, phone: contact.phone }) : null,
      inTrash: Boolean(contact?.deleted_at),
    };
  });
}

export type ContactDealRole = { dealId: string; roleLabel: string | null };

/** CON-03: the deals a contact takes part in (newest link first), with the role's current name in each. */
export async function listContactDealRoles(orgId: string, contactId: string): Promise<ContactDealRole[]> {
  const supabase = await createClient();
  const [linksResult, roles] = await Promise.all([
    supabase
      .from("deal_contacts")
      .select("deal_id, role, role_id, created_at")
      .eq("organization_id", orgId)
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .order("deal_id", { ascending: true })
      .limit(MAX_LINKS),
    listDealContactRoles(orgId),
  ]);
  const links = must(linksResult, "contact deal roles");
  return links.map((link) => ({ dealId: link.deal_id, roleLabel: linkRole({ roleId: link.role_id, role: link.role }, roles)?.name ?? null }));
}
