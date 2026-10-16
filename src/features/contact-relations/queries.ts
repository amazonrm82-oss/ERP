import "server-only";

import { contactDisplayName } from "@/features/contacts/display";
import { leadDisplayName } from "@/features/leads/display";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { relationPhrase, type ContactRelationType } from "./types";

/** CON-06: the business's types of relation, hidden ones too, in their order. */
export async function listRelationTypes(orgId: string): Promise<ContactRelationType[]> {
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("contact_relation_types")
      .select("id, name, reverse_name, key, is_active")
      .eq("organization_id", orgId)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true }),
    "contact relation types",
  );
  return rows.map((row) => ({ id: row.id, name: row.name, reverseName: row.reverse_name, key: row.key, isActive: row.is_active }));
}

/** One relation as a card shows it: this record's phrase and the other side (a contact, or a referring lead). */
export type ContactRelationItem = {
  id: string;
  phrase: string;
  otherKind: "contact" | "lead";
  otherId: string;
  otherName: string;
  otherInTrash: boolean;
};

/** The relations of a contact the user may see (RLS: both sides readable), on either side. */
export async function listContactRelations(orgId: string, contactId: string, types: ContactRelationType[]): Promise<ContactRelationItem[]> {
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("contact_relations")
      .select("id, contact_id, lead_id, related_contact_id, type_id")
      .eq("organization_id", orgId)
      .or(`contact_id.eq.${contactId},related_contact_id.eq.${contactId}`)
      .order("created_at", { ascending: true })
      .order("id")
      .limit(200),
    "contact relations",
  );
  if (rows.length === 0) {
    return [];
  }
  // a lead is always on the first side, so a row with a lead is seen from its contact's side ("in")
  const contactIds = rows.flatMap((row) => (row.contact_id === contactId ? [row.related_contact_id] : row.contact_id ? [row.contact_id] : []));
  const leadIds = rows.flatMap((row) => (row.lead_id ? [row.lead_id] : []));
  const [contacts, leads] = await Promise.all([
    contactIds.length === 0
      ? []
      : must(
          await supabase.from("contacts").select("id, full_name, email, phone, deleted_at").eq("organization_id", orgId).in("id", contactIds),
          "contact relations people",
        ),
    leadIds.length === 0
      ? []
      : must(
          await supabase.from("leads").select("id, full_name, email, phone, deleted_at").eq("organization_id", orgId).in("id", leadIds),
          "contact relations leads",
        ),
  ]);
  const contactById = new Map(contacts.map((other) => [other.id, other]));
  const leadById = new Map(leads.map((other) => [other.id, other]));
  const typeById = new Map(types.map((type) => [type.id, type]));
  return rows.flatMap((row): ContactRelationItem[] => {
    const side = row.contact_id === contactId ? "out" : "in";
    const type = typeById.get(row.type_id);
    if (!type) return [];
    if (side === "in" && row.lead_id) {
      const lead = leadById.get(row.lead_id);
      if (!lead) return [];
      return [
        {
          id: row.id,
          phrase: relationPhrase(type, side),
          otherKind: "lead",
          otherId: lead.id,
          otherName: leadDisplayName({ fullName: lead.full_name, email: lead.email, phone: lead.phone }),
          otherInTrash: lead.deleted_at !== null,
        },
      ];
    }
    const otherId = side === "out" ? row.related_contact_id : row.contact_id;
    const other = otherId ? contactById.get(otherId) : undefined;
    if (!other) return [];
    return [
      {
        id: row.id,
        phrase: relationPhrase(type, side),
        otherKind: "contact",
        otherId: other.id,
        otherName: contactDisplayName({ fullName: other.full_name, email: other.email, phone: other.phone }),
        otherInTrash: other.deleted_at !== null,
      },
    ];
  });
}

/** CON-06: the contacts a lead referred, as the user may see them (RLS: the lead and the contact readable). */
export async function listLeadReferrals(orgId: string, leadId: string, types: ContactRelationType[]): Promise<ContactRelationItem[]> {
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("contact_relations")
      .select("id, related_contact_id, type_id")
      .eq("organization_id", orgId)
      .eq("lead_id", leadId)
      .order("created_at", { ascending: true })
      .order("id")
      .limit(200),
    "lead referrals",
  );
  if (rows.length === 0) {
    return [];
  }
  const others = must(
    await supabase
      .from("contacts")
      .select("id, full_name, email, phone, deleted_at")
      .eq("organization_id", orgId)
      .in("id", rows.map((row) => row.related_contact_id)),
    "lead referrals people",
  );
  const byId = new Map(others.map((other) => [other.id, other]));
  const typeById = new Map(types.map((type) => [type.id, type]));
  return rows.flatMap((row): ContactRelationItem[] => {
    const other = byId.get(row.related_contact_id);
    const type = typeById.get(row.type_id);
    if (!other || !type) return [];
    return [
      {
        id: row.id,
        phrase: relationPhrase(type, "out"),
        otherKind: "contact",
        otherId: other.id,
        otherName: contactDisplayName({ fullName: other.full_name, email: other.email, phone: other.phone }),
        otherInTrash: other.deleted_at !== null,
      },
    ];
  });
}
