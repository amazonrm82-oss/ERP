import "server-only";

import { listFieldDefinitions } from "@/features/custom-fields/queries";
import type { FieldDefinition } from "@/features/custom-fields/types";
import { requestedProductEnabled } from "@/features/requested-product/queries";
import { createClient } from "@/lib/supabase/server";

import { catalogFor, resolveColumns, type CatalogColumn, type ColumnChoice, type ListObject } from "./columns";

export type ListColumns = { catalog: CatalogColumn[]; columns: ColumnChoice[]; fields: FieldDefinition[]; saved: boolean };

/** The signed-in user's columns for a list, with everything the list can show. */
export async function getListColumns(orgId: string, object: ListObject): Promise<ListColumns> {
  const supabase = await createClient();
  const [fields, { data }, products] = await Promise.all([
    // tasks have no custom fields
    object === "task" ? Promise.resolve([]) : listFieldDefinitions(orgId, object),
    supabase.from("list_preferences").select("columns").eq("organization_id", orgId).eq("object_type", object).maybeSingle(),
    // LEAD-04: the leads' product column only with the product catalog
    object === "lead" ? requestedProductEnabled(orgId) : Promise.resolve(false),
  ]);
  const catalog = catalogFor(object, fields, { products });
  return { catalog, columns: resolveColumns(object, data?.columns ?? null, catalog), fields, saved: Boolean(data) };
}
