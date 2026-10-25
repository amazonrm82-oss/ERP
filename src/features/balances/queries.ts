import "server-only";

import { cache } from "react";

import { orgHasFeature } from "@/features/settings/queries";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { parseLedger, type Ledger } from "./ledger";

/** BAL-01: the ledger needs the `balances` key and the money it shows (`documents`, `payments`). */
export const ledgerInPlan = cache(async (orgId: string): Promise<boolean> => {
  const [balances, documents, payments] = await Promise.all([orgHasFeature(orgId, "balances"), orgHasFeature(orgId, "documents"), orgHasFeature(orgId, "payments")]);
  return balances && documents && payments;
});

/** The customer's ledger for a contact or a company, read with the user's session (RLS decides the lines). */
export async function getLedger(orgId: string, where: { contact: string | null; company: string | null }, period: { from: string; to: string }): Promise<Ledger> {
  const supabase = await createClient();
  const raw = must(
    await supabase.rpc("customer_ledger", { p_org: orgId, p_contact: where.contact, p_company: where.company, p_from: period.from, p_to: period.to }),
    "customer ledger",
  );
  return parseLedger(raw);
}
