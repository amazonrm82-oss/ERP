import { buildReport } from "@/features/reports/build";
import { findReport } from "@/features/reports/definitions";
import { csvCell } from "@/features/reports/format";
import { getMyPermissions } from "@/features/permissions/queries";
import { canExport, reportFilters } from "@/features/reports/request";
import { withReportShape } from "@/features/reports/schemas";
import { reportXlsxRows } from "@/features/reports/xlsx";
import { getOrgContext } from "@/features/shell/queries";
import { createClient } from "@/lib/supabase/server";
import { sheetName, xlsxSheet } from "@/lib/xlsx";

// One report as CSV, or as Excel with ?format=xlsx (RPT-02), with the user's session (RLS applies, as on screen).
export async function GET(request: Request, { params }: { params: Promise<{ orgId: string; report: string }> }) {
  const { orgId, report } = await params;
  const definition = findReport(report);
  if (!definition) {
    return new Response("not found", { status: 404 });
  }
  const context = await getOrgContext(orgId);
  // PRM-01: extra permissions (export)
  const granted = await getMyPermissions(orgId);
  if (!canExport(context.role, granted)) {
    return new Response("ייצוא מותר לבעלים, למנהלי מערכת, למנהלי צוות ולמי שקיבל הרשאת ייצוא.", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const searchParams = Object.fromEntries(new URL(request.url).searchParams);
  const xlsx = searchParams.format === "xlsx";
  const filters = reportFilters(definition, searchParams);
  const built = await withReportShape(() => buildReport(orgId, definition.key, filters));
  if (!built.ok) {
    return new Response(built.message, { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const view = built.value;

  // IMP-02: written to the audit log before the file is handed over, with its format; no log, no file
  const supabase = await createClient();
  const rows = view.sections.reduce((sum, section) => sum + section.rows.length, 0);
  const { error } = await supabase.rpc("log_export", { p_org: orgId, p_kind: "report", p_report: definition.key, p_rows: rows, p_format: xlsx ? "xlsx" : "csv" });
  if (error) {
    return new Response("לא הצלחנו להכין את הקובץ. נסו שוב.", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  if (xlsx) {
    const period = definition.filters.includes("period") ? filters.period : null;
    const file = xlsxSheet(sheetName(definition.title, "דוח"), reportXlsxRows(definition.title, period, view));
    return new Response(file as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="report-${definition.key}-${filters.period.fromDate}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const lines: string[] = [csvCell("text", definition.title)];
  if (definition.filters.includes("period")) {
    lines.push(`${csvCell("text", "תקופה")},${filters.period.fromDate},${filters.period.toDate}`);
  }
  for (const section of view.sections) {
    lines.push("", csvCell("text", section.title));
    lines.push(section.columns.map((c) => csvCell("text", c.kind === "money" ? `${c.label} (₪)` : c.label)).join(","));
    for (const row of section.rows) {
      lines.push(section.columns.map((c) => csvCell(c.kind, row[c.key])).join(","));
    }
  }
  // BOM: Excel opens UTF-8 Hebrew correctly only with it
  const body = `﻿${lines.join("\r\n")}\r\n`;
  const filename = `report-${definition.key}-${filters.period.fromDate}.csv`;
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
