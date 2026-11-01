import "server-only";

import { createClient } from "@/lib/supabase/server";

import type { StatementCustomer } from "./link-actions";

/** BAL-04: whether the customer has a working statement link, and since when; null for someone who may not manage it. */
export async function getStatementLinkStatus(orgId: string, customer: StatementCustomer): Promise<{ active: boolean; createdAt: string | null } | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("statement_link_status", {
    p_org: orgId,
    p_contact: customer.kind === "contact" ? customer.id : null,
    p_company: customer.kind === "company" ? customer.id : null,
  });
  if (error) {
    // not someone who records payments: no link card
    if (error.code === "42501") return null;
    throw new Error(`statement_link_status failed: ${error.code} ${error.message}`);
  }
  const value = data as { active?: unknown; created_at?: unknown } | null;
  return { active: value?.active === true, createdAt: typeof value?.created_at === "string" ? value.created_at : null };
}
