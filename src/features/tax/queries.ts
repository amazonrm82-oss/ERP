import "server-only";

import { cache } from "react";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import type { VatRate } from "./rates";
import {
  BANK_COLUMNS,
  bankDetailsFromRow,
  DETAILS_COLUMNS,
  documentDetailsFromRow,
  TAX_COLUMNS,
  taxSettingsFromRow,
  type BankDetails,
  type DocumentDetails,
  type TaxSettings,
} from "./settings";

/**
 * The business's tax settings (TAX-01), with the member's session. Read on its
 * own, not through org_context(), so that shared function stays as it is.
 */
export const getTaxSettings = cache(async (orgId: string): Promise<TaxSettings> => {
  const supabase = await createClient();
  const row = must(
    await supabase.from("org_document_settings").select(TAX_COLUMNS).eq("organization_id", orgId).maybeSingle(),
    "org document settings",
  );
  return taxSettingsFromRow(row);
});

/** The business details printed on documents (TAX-02), with the member's session. */
export const getDocumentDetails = cache(async (orgId: string): Promise<DocumentDetails> => {
  const supabase = await createClient();
  const row = must(
    await supabase.from("org_document_settings").select(DETAILS_COLUMNS).eq("organization_id", orgId).maybeSingle(),
    "org document details",
  );
  return documentDetailsFromRow(row);
});

/** Whether the business types and shows prices including VAT (TAX-04); no row = before VAT. */
export const getPricesIncludeVat = cache(async (orgId: string): Promise<boolean> => {
  const supabase = await createClient();
  const row = must(
    await supabase.from("org_document_settings").select("prices_include_vat").eq("organization_id", orgId).maybeSingle(),
    "org prices mode",
  );
  return row?.prices_include_vat === true;
});

/** Every VAT rate of the platform (TAX-03), oldest first; a handful of rows. */
export const getVatRates = cache(async (): Promise<VatRate[]> => {
  const supabase = await createClient();
  const rows = must(await supabase.from("vat_rates").select("effective_from, rate_bp").order("effective_from"), "vat rates");
  return rows.map((row) => ({ effectiveFrom: row.effective_from, rateBp: row.rate_bp }));
});

/**
 * The bank details (TAX-02 follow-up). Only owners and admins get the row; for
 * anyone else RLS returns nothing, so call it only for them.
 */
export const getBankDetails = cache(async (orgId: string): Promise<BankDetails> => {
  const supabase = await createClient();
  const row = must(
    await supabase.from("org_bank_details").select(BANK_COLUMNS).eq("organization_id", orgId).maybeSingle(),
    "org bank details",
  );
  return bankDetailsFromRow(row);
});
