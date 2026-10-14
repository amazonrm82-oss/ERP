import "server-only";

import { createClient } from "@/lib/supabase/server";
import { must } from "@/lib/db-read";

import { companyMatchDomain, companyOwnDomain, domainChoices } from "./domains";

export type DomainCompany = { id: string; name: string };

/**
 * CON-09: what the contact card says about the company link.
 * - linked: the database linked the contact to this company by its email domain, and nobody changed it since;
 * - choices: "דומיין שמתאים לכמה חברות": the contact has no company and the first tier that matched
 *   (owner's order: own domain, then contact-derived, level by level) holds two or more companies the
 *   user reads, so nothing was linked; the user may pick one.
 */
export type MatchKind = "exact" | "parent" | "contacts";

export type DomainLinkInfo =
  | { kind: "linked"; domain: string; via: MatchKind; company: DomainCompany }
  | { kind: "choices"; domain: string; companies: DomainCompany[]; more: boolean }
  | null;

export async function getDomainLinkInfo(
  orgId: string,
  contact: {
    email: string | null;
    company_id: string | null;
    company_matched_domain: string | null;
    company_match_kind: string | null;
    companyName: string | null;
  },
): Promise<DomainLinkInfo> {
  if (contact.company_id) {
    return contact.company_matched_domain && contact.companyName
      ? {
          kind: "linked",
          domain: contact.company_matched_domain,
          via: contact.company_match_kind === "parent" || contact.company_match_kind === "contacts" ? contact.company_match_kind : "exact",
          company: { id: contact.company_id, name: contact.companyName },
        }
      : null;
  }
  const domain = companyMatchDomain(contact.email);
  if (!domain) return null;
  const supabase = await createClient();
  const rows = must(await supabase.rpc("company_domain_matches", { p_org: orgId, p_email: contact.email ?? "" }), "company domain matches");
  // all rows come from one tier; the function returns up to 7, so 6 and "more" can be told apart
  const choices = domainChoices(rows);
  return choices
    ? { kind: "choices", domain: rows[0].domain, companies: choices.companies.map((row) => ({ id: row.id, name: row.name })), more: choices.more }
    : null;
}

/**
 * CON-09 on the company card: the domain its contacts give it ("(לפי אנשי הקשר)"), shown only when the
 * company has no website or email domain of its own (those always win). off = switched off for this company.
 */
export type ContactDomainInfo = { domain: string; off: boolean } | null;

export async function getContactDomainInfo(
  orgId: string,
  company: { id: string; website: string | null; email: string | null; contact_domain_off: boolean | null },
): Promise<ContactDomainInfo> {
  if (companyOwnDomain(company.website, company.email)) return null;
  const supabase = await createClient();
  const domain = must(await supabase.rpc("company_contact_domain", { p_org: orgId, p_company: company.id }), "company contact domain");
  return domain ? { domain, off: company.contact_domain_off === true } : null;
}
