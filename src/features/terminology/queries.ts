import "server-only";

import { cache } from "react";

import { createClient } from "@/lib/supabase/server";

import { DEFAULT_TERMS, resolveTerms, termKeys, type OrgTermKeys, type OrgTerms } from "./terms";

/** FLD-10: the stored choices of a business (null = today's word). A failed read is today's words: wording never takes a page down. */
export const getOrgTermKeys = cache(async (orgId: string): Promise<OrgTermKeys> => {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.from("org_terms").select("contact_term, lead_term, deal_term").eq("organization_id", orgId).maybeSingle();
    return termKeys(error ? null : data);
  } catch {
    return termKeys(null);
  }
});

/** FLD-10: the business's words, with every form, for titles, the menu, buttons and empty states. */
export async function getOrgTerms(orgId: string): Promise<OrgTerms> {
  try {
    return resolveTerms(await getOrgTermKeys(orgId));
  } catch {
    return DEFAULT_TERMS;
  }
}
