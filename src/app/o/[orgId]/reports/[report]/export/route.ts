import { buildReport } from "@/features/reports/build";
import { getPunchReportDays } from "@/features/reports/punch-days-server";
import { findReport, reportRoleAllows, reportTexts } from "@/features/reports/definitions";
import { getOrgTerms } from "@/features/terminology/queries";
import { csvCell } from "@/features/reports/format";
import { canViewCosts } from "@/features/permissions/keys";
import { seesBalances } from "@/features/balances/queries";
import { getCollectionAccess } from "@/features/collection/queries";
import { getMyPermissions } from "@/features/permissions/queries";
import { canExport, reportFilters } from "@/features/reports/request";
import { withReportShape } from "@/features/reports/schemas";
import { reportXlsxRows } from "@/features/reports/xlsx";
import { getOrgContext } from "@/features/shell/queries";
import { renderPdf } from "@/features/pdf/render";
import { listPipelines } from "@/features/deals/queries";
import { reportMadeAt, reportPdfDocument, reportPdfFileName } from "@/features/reports/pdf";
import { listMembers, orgHasFeature } from "@/features/settings/queries";
import { createClient } from "@/lib/supabase/server";
import { formatDate, zonedIso } from "@/lib/format";
import { sheetName, xlsxSheet } from "@/lib/xlsx";

const text = (status: number, body: string) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

// RPT-02: a refused PDF says why (the month's quota, or too many this minute); anything else is the plain failure
const PDF_REFUSED: Record<string, string> = {
  "limit:max_pdf_per_month": "הגעתם למכסת קובצי ה-PDF החודשית, ולכן הדוח לא הופק כ-PDF. אפשר לייצא אותו ל-Excel או ל-CSV.",
  "rate:pdf": "הופקו הרבה קובצי PDF בדקה האחרונה. נסו שוב בעוד דקה.",
};

// One report as CSV, as Excel with ?format=xlsx, or as PDF with ?format=pdf (RPT-02), with the user's session (RLS applies,
// as on screen).
export async function GET(request: Request, { params }: { params: Promise<{ orgId: string; report: string }> }) {
  const { orgId, report } = await params;
  const definition = findReport(report);
  if (!definition) {
    return new Response("not found", { status: 404 });
  }
  const context = await getOrgContext(orgId);
  // PRM-01: extra permissions (export)
  const granted = await getMyPermissions(orgId);
  // PKG-07 (owner (118) ב): a report for owners, admins and managers does not exist for anyone else
  if (!reportRoleAllows(definition, context.role)) {
    return new Response("not found", { status: 404 });
  }
  // DLI-06: a report about costs does not exist for someone who may not see costs (log_export refuses it too)
  if (definition.costs && !canViewCosts(context.role, granted)) {
    return new Response("not found", { status: 404 });
  }
  // QUO-17: a report of a plan capability (log_export refuses it too)
  if (definition.feature && !(await orgHasFeature(orgId, definition.feature))) {
    return new Response("not found", { status: 404 });
  }
  // BAL-03: a report about customers' balances (log_export refuses it too)
  if (definition.balances && !(await seesBalances(orgId))) {
    return new Response("not found", { status: 404 });
  }
  // COL-06: the collection report (log_export refuses it too)
  if (definition.collection && !(await getCollectionAccess(orgId)).canOpen) {
    return new Response("not found", { status: 404 });
  }
  if (!canExport(context.role, granted)) {
    return new Response("ייצוא מותר לבעלים, למנהלי מערכת, למנהלי צוות ולמי שקיבל הרשאת ייצוא.", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const searchParams = Object.fromEntries(new URL(request.url).searchParams);
  const xlsx = searchParams.format === "xlsx";
  const pdf = searchParams.format === "pdf";
  // FLD-10: the title in the business's words
  const title = reportTexts(definition, await getOrgTerms(orgId)).title;
  const filters = reportFilters(definition, searchParams);
  // PKG-07 (owner (117) ב): the file holds what the screen shows, by the user's kept window
  const punchDays = definition.key === "punch_cards" ? await getPunchReportDays(orgId) : undefined;
  const built = await withReportShape(() => buildReport(orgId, definition.key, filters, { punchDays }));
  if (!built.ok) {
    return new Response(built.message, { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  // COL-06: a section of links only stays on the screen
  const view = { ...built.value, sections: built.value.sections.filter((section) => section.exported !== false) };

  // IMP-02: written to the audit log before the file is handed over, with its format; no log, no file
  const supabase = await createClient();
  const rows = view.sections.reduce((sum, section) => sum + section.rows.length, 0);

  if (pdf) {
    // review (low): a cheap read-only look at the month's quota and the minute's rate first, so a refused export is not
    // rendered for nothing; log_export decides again (and counts) after the render
    const precheck = await supabase.rpc("pdf_quota_check", { p_org: orgId });
    if (precheck.error) return text(500, "לא הצלחנו להכין את הקובץ. נסו שוב.");
    const refusedEarly = typeof precheck.data === "string" ? PDF_REFUSED[precheck.data] : undefined;
    if (refusedEarly) return text(429, refusedEarly);
    // RPT-02 (owner, 1 November 2026, answer (4) א): made here for this export, never stored; rendered before it is logged,
    // so a failed render counts nothing, and logged (one production of max_pdf_per_month) before a byte is handed over
    const [members, pipelines] = await Promise.all([
      filters.ownerId ? listMembers(orgId) : Promise.resolve([]),
      filters.pipelineId ? listPipelines(orgId) : Promise.resolve([]),
    ]);
    const owner = filters.ownerId ? members.find((m) => m.userId === filters.ownerId) : undefined;
    const pipeline = filters.pipelineId ? pipelines.find((p) => p.id === filters.pipelineId) : undefined;
    const period = filters.period;
    const zone = context.org.timeZone;
    const bytes = await renderPdf(
      reportPdfDocument({
        title,
        business: context.org.name,
        periodText: definition.filters.includes("period")
          ? `תקופה: ${formatDate(zonedIso(period.fromDate, "12:00:00", zone))} עד ${formatDate(zonedIso(period.toDate, "12:00:00", zone))}`
          : "מצב נוכחי",
        filters: [
          ...(owner ? [`${definition.ownerLabel ?? "נציג"}: ${owner.name}`] : []),
          ...(pipeline ? [`תהליך מכירה: ${pipeline.name}`] : []),
        ],
        madeAt: reportMadeAt(new Date(), zone),
        view,
      }),
    );
    const logged = await supabase.rpc("log_export", { p_org: orgId, p_kind: "report", p_report: definition.key, p_rows: rows, p_format: "pdf" });
    if (logged.error) {
      const refused = logged.error.hint ? PDF_REFUSED[logged.error.hint] : undefined;
      return text(refused ? 429 : 500, refused ?? "לא הצלחנו להכין את הקובץ. נסו שוב.");
    }
    return new Response(bytes as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(bytes.length),
        "Content-Disposition": `attachment; filename="${reportPdfFileName(definition.key, filters.period.fromDate)}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  const { error } = await supabase.rpc("log_export", { p_org: orgId, p_kind: "report", p_report: definition.key, p_rows: rows, p_format: xlsx ? "xlsx" : "csv" });
  if (error) {
    return text(500, "לא הצלחנו להכין את הקובץ. נסו שוב.");
  }

  if (xlsx) {
    const period = definition.filters.includes("period") ? filters.period : null;
    const file = xlsxSheet(sheetName(title, "דוח"), reportXlsxRows(title, period, view));
    return new Response(file as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="report-${definition.key}-${filters.period.fromDate}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const lines: string[] = [csvCell("text", title)];
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
