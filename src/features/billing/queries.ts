import "server-only";

import { listPriceLists } from "@/features/price-lists/queries";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { BILLING_COLUMNS, companyBilling, contactBilling, type Billing, type BillingColumns, type BillingSubject } from "./billing";

export type BillingPriceList = { id: string; name: string; isActive: boolean; validFrom: string | null; validTo: string | null };

export type RecordBilling = {
  subject: BillingSubject;
  own: Billing;
  // a contact's company, as the fallback for its empty fields (null: no company, or not readable)
  company: { id: string; name: string; billing: Billing } | null;
  // every price list of the organization, for the picker and to name the chosen one
  priceLists: BillingPriceList[];
};

/**
 * CON-08: the billing details of a company or contact, read with the user's session (RLS decides).
 * Null when the record is not readable or is in the recycle bin.
 */
export async function getRecordBilling(orgId: string, subject: BillingSubject, id: string): Promise<RecordBilling | null> {
  const supabase = await createClient();
  const priceListsPromise = listPriceLists(orgId);

  if (subject === "company") {
    const row = must(
      await supabase
        .from("companies")
        .select(`tax_id, ${BILLING_COLUMNS.company}`)
        .eq("organization_id", orgId)
        .eq("id", id)
        .is("deleted_at", null)
        .maybeSingle(),
      "companies",
    );
    if (!row) return null;
    const priceLists = await priceListsPromise;
    return { subject, own: companyBilling(row as BillingColumns & { tax_id: string | null }), company: null, priceLists: priceLists.map(pickList) };
  }

  const row = must(
    await supabase
      .from("contacts")
      .select(`company_id, ${BILLING_COLUMNS.contact}`)
      .eq("organization_id", orgId)
      .eq("id", id)
      .is("deleted_at", null)
      .maybeSingle(),
    "contacts",
  );
  if (!row) return null;
  const companyId = (row as { company_id: string | null }).company_id;
  const [companyRow, priceLists] = await Promise.all([
    companyId
      ? supabase
          .from("companies")
          .select(`id, name, tax_id, ${BILLING_COLUMNS.company}`)
          .eq("organization_id", orgId)
          .eq("id", companyId)
          .is("deleted_at", null)
          .maybeSingle()
          .then((result) => must(result, "companies"))
      : Promise.resolve(null),
    priceListsPromise,
  ]);
  let company: RecordBilling["company"] = null;
  if (companyRow) {
    const c = companyRow as BillingColumns & { id: string; name: string; tax_id: string | null };
    const billing = companyBilling(c);
    // the invoice goes to the company: without a name for invoices, its own name
    company = { id: c.id, name: c.name, billing: { ...billing, name: billing.name ?? c.name } };
  }
  return { subject, own: contactBilling(row as BillingColumns), company, priceLists: priceLists.map(pickList) };
}

function pickList(list: { id: string; name: string; isActive: boolean; validFrom: string | null; validTo: string | null }): BillingPriceList {
  return { id: list.id, name: list.name, isActive: list.isActive, validFrom: list.validFrom, validTo: list.validTo };
}
