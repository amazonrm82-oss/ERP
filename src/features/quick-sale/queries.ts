import "server-only";

import { getPaymentsAccess } from "@/features/payments/queries";
import { orgHasFeature } from "@/features/settings/queries";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

/** GAP-08: whether the "+" menu offers the quick sale: the user records payments and the plan holds payments and products. */
export async function quickSaleOffered(orgId: string): Promise<boolean> {
  try {
    const [access, products] = await Promise.all([getPaymentsAccess(orgId), orgHasFeature(orgId, "products")]);
    return access.canRecord && products;
  } catch {
    // the menu never breaks the page
    return false;
  }
}

/** The business's sales process for quick sales (org_document_settings.quick_sale_pipeline_id); null = the default one. */
export async function getQuickSalePipeline(orgId: string): Promise<string | null> {
  const supabase = await createClient();
  const row = must(
    await supabase.from("org_document_settings").select("quick_sale_pipeline_id").eq("organization_id", orgId).maybeSingle(),
    "quick sale pipeline",
  );
  return row?.quick_sale_pipeline_id ?? null;
}
