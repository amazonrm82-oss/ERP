import "server-only";

import { cache } from "react";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { isHexColor } from "./color";
import { logoPublicUrl } from "./logo";

export type OrgBranding = {
  logoPath: string | null;
  logoUrl: string | null;
  color: string | null;
};

/**
 * The organization's logo and main colour (FLD-04), with the member's session.
 * Read on its own, not through org_context(), so that shared function stays as it is.
 */
export const getOrgBranding = cache(async (orgId: string): Promise<OrgBranding> => {
  const supabase = await createClient();
  const data = must(
    await supabase.from("organizations").select("logo_path, brand_color").eq("id", orgId).maybeSingle(),
    "organizations branding",
  );
  const logoPath = data?.logo_path ?? null;
  return {
    logoPath,
    logoUrl: logoPublicUrl(logoPath),
    color: isHexColor(data?.brand_color) ? data.brand_color : null,
  };
});
