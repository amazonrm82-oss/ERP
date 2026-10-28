import "server-only";

import { cache } from "react";

import { orgHasFeature } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { parseDebtSummary, type DebtNumbers, type DebtSummary } from "./debt";
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

/**
 * BAL-02: the customer's open and overdue debt for the card, read with the user's session (BAL-01's rights and partial
 * rule in the database). Memoized per request: the top of the page and the ledger card share one read.
 */
export const getDebtSummary = cache(async (orgId: string, contact: string | null, company: string | null): Promise<DebtSummary> => {
  const supabase = await createClient();
  const raw = must(await supabase.rpc("customer_debt_summary", { p_org: orgId, p_contact: contact, p_company: company }), "customer debt");
  return parseDebtSummary(raw);
});

/**
 * BAL-02: whether the contacts' and companies' lists offer the debt columns, their sort and their filters: owners and
 * admins (the database's app.customer_debt_of answers null to anyone else, since the kept totals count every document) of
 * a business with the ledger's three keys.
 */
export const debtColumnsEnabled = cache(async (orgId: string): Promise<boolean> => {
  const [inPlan, context] = await Promise.all([ledgerInPlan(orgId), getOrgContext(orgId)]);
  return inPlan && (context.role === "owner" || context.role === "admin");
});

/** BAL-02: the debt columns' values for one page of contacts or companies (the server-kept totals). */
export async function getDebtNumbers(orgId: string, table: "contacts" | "companies", ids: string[]): Promise<Map<string, DebtNumbers>> {
  const result = new Map<string, DebtNumbers>();
  if (ids.length === 0) return result;
  const supabase = await createClient();
  for (let i = 0; i < ids.length; i += 200) {
    const rows = must(
      await supabase.from(table).select("id, debt_balance, overdue_debt").eq("organization_id", orgId).in("id", ids.slice(i, i + 200)),
      "debt balance",
    );
    for (const row of rows as unknown as Array<{ id: string; debt_balance: number | string | null; overdue_debt: number | string | null }>) {
      if (row.debt_balance !== null) result.set(row.id, { open: Number(row.debt_balance), overdue: Number(row.overdue_debt ?? 0) });
    }
  }
  return result;
}
