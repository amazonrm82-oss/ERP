import "server-only";

import { contactDisplayName } from "@/features/contacts/display";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

/** CON-05: one company of a contact, as the contact page shows it. */
export type ContactCompanyItem = {
  id: string;
  companyId: string;
  name: string;
  title: string | null;
  isPrimary: boolean;
  inTrash: boolean;
};

/** One person of a company, as the company page shows it: the role there (the primary company falls back to the job title). */
export type CompanyPerson = { id: string; name: string; title: string | null; isPrimary: boolean };

/** How many people the company page lists. */
export const COMPANY_PEOPLE_SHOWN = 100;

/** The companies of a contact the user may read: the primary first, then by name. */
export async function listContactCompanies(orgId: string, contactId: string): Promise<ContactCompanyItem[]> {
  const supabase = await createClient();
  const links = must(
    await supabase
      .from("contact_companies")
      .select("id, company_id, title, is_primary")
      .eq("organization_id", orgId)
      .eq("contact_id", contactId)
      .order("id")
      .limit(200),
    "contact companies",
  );
  if (links.length === 0) {
    return [];
  }
  const companies = must(
    await supabase
      .from("companies")
      .select("id, name, deleted_at")
      .eq("organization_id", orgId)
      .in("id", links.map((link) => link.company_id)),
    "contact companies names",
  );
  const byId = new Map(companies.map((company) => [company.id, company]));
  return links
    .flatMap((link) => {
      const company = byId.get(link.company_id);
      return company
        ? [{ id: link.id, companyId: link.company_id, name: company.name, title: link.title, isPrimary: link.is_primary, inTrash: company.deleted_at !== null }]
        : [];
    })
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.name.localeCompare(b.name, "he"));
}

/** The live people of a company the user may read, with their role there; the newest first. */
export async function listCompanyPeople(orgId: string, companyId: string): Promise<CompanyPerson[]> {
  const supabase = await createClient();
  const links = must(
    await supabase
      .from("contact_companies")
      .select("contact_id, title, is_primary")
      .eq("organization_id", orgId)
      .eq("company_id", companyId)
      // the newest links; the ids go into one request, so they stay a few hundred
      .order("created_at", { ascending: false })
      .order("id")
      .limit(300),
    "company people",
  );
  if (links.length === 0) {
    return [];
  }
  const contacts = must(
    await supabase
      .from("contacts")
      .select("id, full_name, email, phone, job_title")
      .eq("organization_id", orgId)
      .in("id", links.map((link) => link.contact_id))
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .order("id")
      .limit(COMPANY_PEOPLE_SHOWN),
    "company people names",
  );
  const byContact = new Map(links.map((link) => [link.contact_id, link]));
  return contacts.map((contact) => {
    const link = byContact.get(contact.id);
    const isPrimary = link?.is_primary ?? false;
    return {
      id: contact.id,
      name: contactDisplayName({ fullName: contact.full_name, email: contact.email, phone: contact.phone }),
      title: link?.title ?? (isPrimary ? contact.job_title : null),
      isPrimary,
    };
  });
}
