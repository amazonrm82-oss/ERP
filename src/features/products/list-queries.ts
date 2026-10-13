import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import type { ProductCategory, ProductUnit } from "./lists";

// at most 200 categories and 50 units per organization (database caps), so one read each is enough

/** Every product category of the organization (PRD-04). */
export async function listProductCategories(orgId: string): Promise<ProductCategory[]> {
  const supabase = await createClient();
  const rows =
    must(
      await supabase
        .from("product_categories")
        .select("id, parent_id, name, position")
        .eq("organization_id", orgId)
        .order("position", { ascending: true })
        .order("name", { ascending: true }),
      "product categories",
    ) ?? [];
  return rows.map((row) => ({ id: row.id, parentId: row.parent_id, name: row.name, position: row.position }));
}

/** Every unit of measure of the organization, in the order the admin set (PRD-04). */
export async function listProductUnits(orgId: string): Promise<ProductUnit[]> {
  const supabase = await createClient();
  const rows =
    must(
      await supabase
        .from("product_units")
        .select("id, name, position")
        .eq("organization_id", orgId)
        .order("position", { ascending: true })
        .order("name", { ascending: true }),
      "product units",
    ) ?? [];
  return rows.map((row) => ({ id: row.id, name: row.name, position: row.position }));
}
