import "server-only";

import { parseAdminRoadmap, type AdminRoadmapList } from "@/features/roadmap/items";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

/** TRU-01: the newest 500 roadmap items with their vote counts (request ids for owner and support only), and the total. */
export async function listAdminRoadmap(): Promise<AdminRoadmapList> {
  const supabase = await createClient();
  return parseAdminRoadmap(must(await supabase.rpc("platform_list_roadmap_items"), "platform_list_roadmap_items"));
}
