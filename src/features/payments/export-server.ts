import "server-only";

import { prepareListFilter } from "@/features/list-filters/prepare";
import { getMyPermissions } from "@/features/permissions/queries";
import { canExport } from "@/features/reports/request";
import { orgHasFeature } from "@/features/settings/queries";
import { getOrgContext, getUserNames } from "@/features/shell/queries";
import { csvText } from "@/lib/csv";
import { zoneDate } from "@/lib/format";
import { readAllPages } from "@/lib/paged-read";
import { isUuid } from "@/lib/paths";
import { sortValue } from "@/lib/sort";
import { createClient } from "@/lib/supabase/server";
import { xlsxFile } from "@/lib/xlsx";

import { PAYMENT_EXPORT_HEADER, paymentExportRows } from "./export-table";
import { paymentListFilters } from "./list";
import { listPayments, type PaymentListItem } from "./queries";

// LST-09: the payments list as CSV or Excel, with the list's selects, advanced filter and sort (the same query
// string as the page), or only the picked rows. Read with the user's session (the payments RLS decides);
// owners, admins, team managers and whoever has the export grant, like every list export (LST-08), and written to the
// audit log first (log_list_export, which also refuses without the plan's `payments` key).

const MAX_ROWS = 50_000;
// LST-08: "export the picked rows" sends at most one page's worth
const MAX_PICKED = 100;
const FORBIDDEN = "ייצוא מותר לבעלים, למנהלי מערכת, למנהלי צוות ולמי שקיבל הרשאת ייצוא.";
const NOT_IN_PLAN = "תשלומים לא כלולים בחבילה של העסק.";
const text = (message: string, status: number) => new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

export async function exportPayments(request: Request, orgId: string): Promise<Response> {
  const context = await getOrgContext(orgId);
  // PRM-01: extra permissions (export)
  const [granted, inPlan] = await Promise.all([getMyPermissions(orgId), orgHasFeature(orgId, "payments")]);
  if (!inPlan) {
    return text(NOT_IN_PLAN, 404);
  }
  if (!canExport(context.role, granted)) {
    return text(FORBIDDEN, 403);
  }
  const params = new URL(request.url).searchParams;
  const format = params.get("format") === "xlsx" ? "xlsx" : "csv";
  const picked = (params.get("ids") ?? "").split(",").filter(isUuid);
  if (picked.length > MAX_PICKED) {
    return text(`אפשר לייצא עד ${MAX_PICKED} תשלומים נבחרים. לייצוא של יותר, השתמשו בסינון.`, 400);
  }
  const scope = params.has("ids") ? "selected" : "filtered";
  const filters = paymentListFilters(Object.fromEntries(params.entries()));
  // LST-05: the advanced filter, checked against the list's fields as on the page
  const filter = await prepareListFilter(orgId, "payment", params.get("f") ?? "", context.user.id, []);

  const { rows: payments, complete } = await readAllPages<PaymentListItem>(
    async (from, to) =>
      (
        await listPayments(
          orgId,
          // picked rows ignore the list's filters: they were picked on screen
          scope === "selected"
            ? { status: null, method: null, from: null, to: null, page: 1, sort: filters.sort, ids: picked, chunk: { from, size: to - from + 1 } }
            : { ...filters, page: 1, filter: filter.logic, chunk: { from, size: to - from + 1 } },
        )
      ).payments,
    { limit: MAX_ROWS },
  );
  if (!complete) {
    return text(`ברשימה יותר מ-${MAX_ROWS.toLocaleString("he-IL")} תשלומים. צמצמו בסינון, או השתמשו בייצוא המלא בהגדרות.`, 413);
  }

  // the audit entry comes first: no entry, no file. Only the shape of the filters is kept (RVW-4, app.export_filters): the
  // advanced filter's conditions and the sort; the page's own selects (status, method, dates) are not on its allow-list
  const supabase = await createClient();
  const logged: Record<string, string | number> =
    scope === "selected"
      ? { picked: picked.length }
      : Object.fromEntries(
          Object.entries({ f: filter.applied ? JSON.stringify(filter.applied) : "", sort: filters.sort ? sortValue(filters.sort) : "" }).filter(([, value]) => value !== ""),
        );
  const { error } = await supabase.rpc("log_list_export", {
    p_org: orgId,
    p_object: "payment",
    p_format: format,
    p_rows: payments.length,
    p_scope: scope,
    p_filters: logged,
  });
  if (error) {
    return text(error.code === "42501" ? FORBIDDEN : error.hint === "feature:payments" ? NOT_IN_PLAN : "לא הצלחנו להכין את הקובץ. נסו שוב.", error.code === "42501" ? 403 : 500);
  }

  const names = await getUserNames(payments.map((payment) => payment.createdBy));
  const header = [...PAYMENT_EXPORT_HEADER];
  const body = paymentExportRows(payments, names, context.org.timeZone);
  const filename = `payments-${zoneDate(new Date(), context.org.timeZone)}.${format}`;
  if (format === "xlsx") {
    return new Response(xlsxFile("תשלומים", header, body) as unknown as BodyInit, {
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
