import { buildReport } from "@/features/reports/build";
import { findReport } from "@/features/reports/definitions";
import { csvCell } from "@/features/reports/format";
import { canExport, reportFilters } from "@/features/reports/request";
import { withReportShape } from "@/features/reports/schemas";
import { getOrgContext } from "@/features/shell/queries";
import { createClient } from "@/lib/supabase/server";

// CSV of one report, with the user's session (RLS applies, as on screen).
export async function GET(request: Request, { params }: { params: Promise<{ orgId: string; report: string }> }) {
  const { orgId, report } = await params;
  const definition = findReport(report);
  if (!definition) {
    return new Response("not found", { status: 404 });
  }
  const context = await getOrgContext(orgId);
  if (!canExport(context.role)) {
    return new Response("ייצוא מותר לבעלים, למנהלי מערכת ולמנהלי צוות.", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const searchParams = Object.fromEntries(new URL(request.url).searchParams);
  const filters = reportFilters(definition, searchParams);
  const built = await withReportShape(() => buildReport(orgId, definition.key, filters));
  if (!built.ok) {
    return new Response(built.message, { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const view = built.value;

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
  // IMP-02: written to the audit log before the file is handed over; no log, no file
  const supabase = await createClient();
  const rows = view.sections.reduce((sum, section) => sum + section.rows.length, 0);
  const { error } = await supabase.rpc("log_export", { p_org: orgId, p_kind: "report", p_report: definition.key, p_rows: rows });
  if (error) {
    return new Response("לא הצלחנו להכין את הקובץ. נסו שוב.", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
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
