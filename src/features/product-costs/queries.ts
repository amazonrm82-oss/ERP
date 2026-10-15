import "server-only";

import { getTaxSettings, getVatRates } from "@/features/tax/queries";
import { conversionRateBp } from "@/features/deal-lines/pricing";
import { documentVat } from "@/features/tax/rates";
import { chargesVat } from "@/features/tax/status";
import { must } from "@/lib/db-read";
import { zoneDate } from "@/lib/format";
import { readAllPagesByIds } from "@/lib/paged-read";
import { createClient } from "@/lib/supabase/server";

/**
 * PRD-06: the cost per unit of the given products, by product id. Read with the user's session:
 * public.product_costs RLS returns rows only to owners, admins, managers and holders of the
 * view_costs grant, so for anyone else the map is empty. Call it only for someone canViewCosts()
 * allows, so the screen never mistakes "not allowed" for "no cost".
 */
export async function readProductCosts(orgId: string, productIds: readonly string[]): Promise<Map<string, number>> {
  const ids = [...new Set(productIds)];
  if (ids.length === 0) return new Map();
  const supabase = await createClient();
  const rows = await readAllPagesByIds(ids, async (slice, from, to) =>
    must(
      await supabase
        .from("product_costs")
        .select("product_id, cost_agorot")
        .eq("organization_id", orgId)
        .in("product_id", slice)
        .order("product_id")
        .range(from, to),
      "product costs",
    ),
  );
  return new Map(rows.map((row) => [row.product_id, Number(row.cost_agorot)]));
}

/**
 * What a product's price is compared with: today's conversion rate (the business's VAT rate, 0
 * when it charges none) and whether it charges VAT (null = not set yet).
 */
export async function getCostBasis(orgId: string, timeZone: string): Promise<{ rateBp: number; chargesVat: boolean | null }> {
  const [settings, rates] = await Promise.all([getTaxSettings(orgId), getVatRates()]);
  const day = zoneDate(new Date(), timeZone);
  const charges = chargesVat(settings.vatStatus, settings.otherChargesVat);
  return { rateBp: conversionRateBp(documentVat(charges, rates, day), rates, day), chargesVat: charges };
}
