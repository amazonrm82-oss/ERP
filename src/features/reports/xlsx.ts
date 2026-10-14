import type { XlsxCell } from "@/lib/xlsx";

import type { ColumnKind, ReportView } from "./definitions";

/**
 * A report cell in an Excel file (RPT-02): numbers stay numbers, money is shekels
 * (agorot / 100) with a shekel format, a percent is a real percent (42.5 -> 0.425,
 * shown 42.5%). Text, and any string value, is written as text.
 */
export function reportXlsxCell(kind: ColumnKind, value: string | number | null | undefined): XlsxCell {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  switch (kind) {
    case "money":
      return { type: "money", value: value / 100 };
    case "percent":
      // rounded so the file holds 0.123, not 0.12300000000000001
      return { type: "percent", value: Number((value / 100).toFixed(6)) };
    case "text":
      return String(value);
    default:
      return { type: "number", value };
  }
}

/**
 * The rows of a report's Excel sheet: the same lines as its CSV export (title,
 * period with real dates, then each section's title, header and rows).
 * The period is a pair of calendar days already in the organization's time zone.
 */
export function reportXlsxRows(title: string, period: { fromDate: string; toDate: string } | null, view: ReportView): XlsxCell[][] {
  const rows: XlsxCell[][] = [[{ type: "text", value: title, bold: true }]];
  if (period) {
    rows.push(["תקופה", { type: "date", value: period.fromDate }, { type: "date", value: period.toDate }]);
  }
  for (const section of view.sections) {
    rows.push([], [{ type: "text", value: section.title, bold: true }]);
    rows.push(section.columns.map((c) => ({ type: "text", value: c.kind === "money" ? `${c.label} (₪)` : c.label, bold: true })));
    for (const row of section.rows) {
      rows.push(section.columns.map((c) => reportXlsxCell(c.kind, row[c.key])));
    }
  }
  return rows;
}
