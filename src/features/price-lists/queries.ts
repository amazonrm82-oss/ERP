import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

export type PriceList = {
  id: string;
  name: string;
  validFrom: string | null;
  validTo: string | null;
  isActive: boolean;
  createdAt: string;
};

type Row = { id: string; name: string; valid_from: string | null; valid_to: string | null; is_active: boolean; created_at: string };

const COLUMNS = "id, name, valid_from, valid_to, is_active, created_at";

function toPriceList(row: Row): PriceList {
  return { id: row.id, name: row.name, validFrom: row.valid_from, validTo: row.valid_to, isActive: row.is_active, createdAt: row.created_at };
}

/** Every price list of the organization, by name (at most the plan's quota, well under 1,000). */
export async function listPriceLists(orgId: string): Promise<PriceList[]> {
  const supabase = await createClient();
  const rows = must(
    await supabase.from("price_lists").select(COLUMNS).eq("organization_id", orgId).order("name").order("id"),
    "price_lists",
  );
  return rows.map(toPriceList);
}

export async function getPriceList(orgId: string, listId: string): Promise<PriceList | null> {
  const supabase = await createClient();
  const row = must(
    await supabase.from("price_lists").select(COLUMNS).eq("organization_id", orgId).eq("id", listId).maybeSingle(),
    "price_lists",
  );
  return row ? toPriceList(row) : null;
}
