import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { parseRoadmapItems, type RoadmapItem } from "./items";

/** TRU-01: the published roadmap as this business sees it, with its own vote. A non-member gets an empty list. */
export async function getRoadmap(orgId: string): Promise<RoadmapItem[]> {
  const supabase = await createClient();
  return parseRoadmapItems(must(await supabase.rpc("roadmap_items_for", { p_org: orgId }), "roadmap_items_for"));
}
