import "server-only";

import { listFieldDefinitions } from "@/features/custom-fields/queries";
import type { FieldDefinition } from "@/features/custom-fields/types";
import { moneyColumnsEnabled } from "@/features/allocations/queries";
import { debtColumnsEnabled } from "@/features/balances/queries";
import { requestedProductEnabled } from "@/features/requested-product/queries";
import { createClient } from "@/lib/supabase/server";

import { catalogFor, resolveColumns, type CatalogColumn, type ColumnChoice, type ListObject } from "./columns";

export type ListColumns = { catalog: CatalogColumn[]; columns: ColumnChoice[]; fields: FieldDefinition[]; saved: boolean };

/** The signed-in user's columns for a list, with everything the list can show. */
export async function getListColumns(orgId: string, object: ListObject): Promise<ListColumns> {
  const supabase = await createClient();
  const [fields, { data }, products, money, debt] = await Promise.all([
    // tasks, products, quotes, documents and payments have no custom fields
    object === "task" || object === "product" || object === "quote" || object === "document" || object === "payment" ? Promise.resolve([]) : listFieldDefinitions(orgId, object),
    supabase.from("list_preferences").select("columns").eq("organization_id", orgId).eq("object_type", object).maybeSingle(),
    // LEAD-04: the leads' product column only with the product catalog
    object === "lead" ? requestedProductEnabled(orgId) : Promise.resolve(false),
    // PAY-03: the credit column only where the business sees money
    object === "contact" || object === "company" ? moneyColumnsEnabled(orgId) : Promise.resolve(false),
    // BAL-02: the debt columns only where the business sees balances
    object === "contact" || object === "company" ? debtColumnsEnabled(orgId) : Promise.resolve(false),
  ]);
  const catalog = catalogFor(object, fields, { products, money, debt });
  return { catalog, columns: resolveColumns(object, data?.columns ?? null, catalog), fields, saved: Boolean(data) };
}
