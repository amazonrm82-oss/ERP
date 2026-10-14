import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { parseLayout, type CardLayoutGroup, type CardLayoutType } from "./layout";

/** FLD-08: the business's card layout of one record type; null = no row (the default layout). */
export async function getCardLayout(orgId: string, type: CardLayoutType): Promise<CardLayoutGroup[] | null> {
  const supabase = await createClient();
  const rows = must(
    await supabase.from("card_layouts").select("groups").eq("organization_id", orgId).eq("object_type", type).limit(1),
    "card layout",
  );
  return rows.length > 0 ? parseLayout(type, rows[0].groups) : null;
}
