import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { parseAdminBanners, type AdminBanner } from "./banners";

/** ADM-04: the newest 200 banners, for every platform role. */
export async function listAdminBanners(): Promise<AdminBanner[]> {
  const supabase = await createClient();
  return parseAdminBanners(must(await supabase.rpc("platform_list_system_banners"), "platform_list_system_banners"));
}
