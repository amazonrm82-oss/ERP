import "server-only";

import { cache } from "react";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { TAX_COLUMNS, taxSettingsFromRow, type TaxSettings } from "./settings";

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
