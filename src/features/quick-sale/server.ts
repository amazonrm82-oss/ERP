import "server-only";

import { priceListTiers, readDealPricing } from "@/features/deal-lines/queries";
import { isBilling } from "@/features/deal-lines/recurring";
import { documentVatRateBp } from "@/features/tax/calc";
import type { VatKind } from "@/features/products/schema";
import { must } from "@/lib/db-read";
import type { createClient } from "@/lib/supabase/server";

import { priceSale, type PricedSale, type QuickSaleItem, type SaleProduct, type SalePricing } from "./sale";

type Client = Awaited<ReturnType<typeof createClient>>;

/**
 * GAP-08: prices a quick sale with the user's session, exactly as a new deal line on that customer would be priced
 * (PL-03; readDealPricing reads the business's VAT mode, the day's rate and the customer's price list). A new
 * customer has no list. Every read is RLS-filtered: a product the user cannot read is "not found".
 */
export async function priceQuickSale(
  supabase: Client,
  orgId: string,
  contactId: string | null,
  items: readonly QuickSaleItem[],
): Promise<{ priced: PricedSale; day: string }> {
  const org = must(await supabase.from("organizations").select("timezone").eq("id", orgId).maybeSingle(), "organizations");
  const base = await readDealPricing(supabase, orgId, { contactId, companyId: null }, [], org?.timezone ?? "Asia/Jerusalem");
  const ids = [...new Set(items.map((item) => item.productId))];
  const [rows, tiers] = await Promise.all([
    supabase
      .from("products")
      .select("id, name, price_agorot, price_includes_vat, vat_kind, billing, is_active, archived_at")
      .eq("organization_id", orgId)
      .in("id", ids),
    base.list ? priceListTiers(supabase, orgId, base.list.id, ids) : Promise.resolve([]),
  ]);
  const products = new Map<string, SaleProduct>(
    must(rows, "products").map((row) => [
      row.id,
      {
        id: row.id,
        name: row.name,
        priceAgorot: Number(row.price_agorot),
        priceIncludesVat: row.price_includes_vat,
        // the check constraint holds vat_kind to VAT_KINDS
        vatKind: row.vat_kind as VatKind,
        billing: isBilling(row.billing) ? row.billing : "one_time",
        offerable: row.is_active && row.archived_at === null,
      },
    ]),
  );
  const pricing: SalePricing = {
    day: base.day,
    includesVat: base.includesVat,
    conversionRateBp: base.rateBp,
    documentRateBp: documentVatRateBp(base.vat),
    list: base.list ? { ...base.list, lines: tiers } : null,
  };
  return { priced: priceSale(items, products, pricing), day: base.day };
}
