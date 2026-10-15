import "server-only";

import { canViewCosts } from "@/features/permissions/keys";
import { getMyPermissions } from "@/features/permissions/queries";
import { readProductCosts } from "@/features/product-costs/queries";
import { canExport } from "@/features/reports/request";
import { getOrgContext } from "@/features/shell/queries";
import { csvText } from "@/lib/csv";
import { zoneDate } from "@/lib/format";
import { readAllPages } from "@/lib/paged-read";
import { isUuid } from "@/lib/paths";
import { parseSort, sortValue } from "@/lib/sort";
import { createClient } from "@/lib/supabase/server";
import { xlsxFile } from "@/lib/xlsx";

import { productExportHeader, productExportRows } from "./export-table";
import { listProductCategories, listProductUnits } from "./list-queries";
import { categoryWithChildren } from "./lists";
import { listProducts, PRODUCT_DEFAULT_SORT, PRODUCT_SORT_COLUMNS, PRODUCT_STATUS_FILTERS, type Product, type ProductSortKey, type ProductStatusFilter } from "./queries";
import { PRODUCT_KINDS, type ProductKind } from "./schema";

// PRD-05: the product list as CSV or Excel, with the list's search, filters and sort (the same
// query string as the page). Read with the user's session; owners, admins and team managers, like
// every list export (LST-08), and written to the audit log first (log_list_export, 'product').

const MAX_ROWS = 50_000;
const text = (message: string, status: number) => new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

export async function exportProducts(request: Request, orgId: string): Promise<Response> {
  const context = await getOrgContext(orgId);
  // PRM-01: extra permissions (export)
  const granted = await getMyPermissions(orgId);
  if (!canExport(context.role, granted)) {
    return text("ייצוא מותר לבעלים, למנהלי מערכת, למנהלי צוות ולמי שקיבל הרשאת ייצוא.", 403);
  }
  const params = new URL(request.url).searchParams;
  const format = params.get("format") === "xlsx" ? "xlsx" : "csv";
  const search = (params.get("q") ?? "").trim();
  const kindParam = params.get("kind") ?? "";
  const statusParam = params.get("status") ?? "";
  const kind = (PRODUCT_KINDS as readonly string[]).includes(kindParam) ? (kindParam as ProductKind) : null;
  const status: ProductStatusFilter = (PRODUCT_STATUS_FILTERS as readonly string[]).includes(statusParam) ? (statusParam as ProductStatusFilter) : "";
  const sort = parseSort(params.get("sort") ?? "", Object.keys(PRODUCT_SORT_COLUMNS) as ProductSortKey[], PRODUCT_DEFAULT_SORT);

  const [categories, units] = await Promise.all([listProductCategories(orgId), listProductUnits(orgId)]);
  const categoryParam = params.get("category") ?? "";
  const categoryId = isUuid(categoryParam) && categories.some((c) => c.id === categoryParam) ? categoryParam : null;

  const { rows: products, complete } = await readAllPages<Product>(
    async (from, to) =>
      (
        await listProducts(orgId, {
          search,
          categoryIds: categoryId ? categoryWithChildren(categories, categoryId) : null,
          kind,
          status,
          page: 1,
          sort,
          chunk: { from, size: to - from + 1 },
        })
      ).products,
    { limit: MAX_ROWS },
  );
  if (!complete) {
    return text(`ברשימה יותר מ-${MAX_ROWS.toLocaleString("he-IL")} מוצרים. צמצמו בסינון, או השתמשו בייצוא המלא בהגדרות.`, 413);
  }

  // the audit entry comes first: no entry, no file (only the shape of the filters is kept)
  const supabase = await createClient();
  const filters: Record<string, string> = Object.fromEntries(
    Object.entries({ q: search, sort: sortValue(sort) }).filter(([, value]) => value !== ""),
  );
  const { error } = await supabase.rpc("log_list_export", {
    p_org: orgId,
    p_object: "product",
    p_format: format,
    p_rows: products.length,
    p_scope: "filtered",
    p_filters: filters,
  });
  if (error) {
    return text(
      error.code === "42501" ? "ייצוא מותר לבעלים, למנהלי מערכת, למנהלי צוות ולמי שקיבל הרשאת ייצוא." : "לא הצלחנו להכין את הקובץ. נסו שוב.",
      error.code === "42501" ? 403 : 500,
    );
  }

  // PRD-06: the cost column only for those who see costs; the rows come from product_costs under RLS
  const costs = canViewCosts(context.role, granted) ? await readProductCosts(orgId, products.map((p) => p.id)) : null;
  const header = productExportHeader(costs !== null);
  const body = productExportRows(products, categories, units, costs);
  const filename = `products-${zoneDate(new Date())}.${format}`;
  if (format === "xlsx") {
    return new Response(xlsxFile("מוצרים", header, body) as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  }
  const lines = [header, ...body].map((values) => values.map((value) => csvText(value)).join(","));
  // BOM: Excel opens UTF-8 Hebrew correctly only with it
  return new Response(`﻿${lines.join("\r\n")}\r\n`, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "no-store" },
  });
}
