// RPT-02 (owner, 1 November 2026, answer (4) א): a report as a PDF document (src/features/pdf), made on our server for every
// export from the same shaped view as the CSV and Excel files (build.ts, with `exported = false` sections left out). Never
// stored. Pure, so it is unit tested: the values are the screen's (formatCell), never added up here.

import { type PdfBlock, type PdfColumn, type PdfDocument, type PdfLine } from "@/features/pdf/document";

import type { ColumnKind, ReportSection, ReportView } from "./definitions";
import { formatCell } from "./format";

export type ReportPdfInput = {
  // the report's title in the business's words (reportTexts)
  title: string;
  // the business's display name (customer-facing rule does not apply: this is the business's own document)
  business: string;
  // "1 באוק׳ 2026 עד 31 באוק׳ 2026" or "מצב נוכחי"
  periodText: string;
  // the filters picked on screen, as names ("נציג: דנה כהן", "תהליך מכירה: מכירות")
  filters: string[];
  // when the file was made, already in the business's time zone (reportMadeAt)
  madeAt: string;
  view: ReportView;
};

/** "הופק ב-01.11.2026 14:05", the moment in the business's time zone. */
export function reportMadeAt(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `הופק ב-${part("day")}.${part("month")}.${part("year")} ${part("hour")}:${part("minute")}`;
}

/** A text column takes twice the width of a number column. */
function columnWidth(kind: ColumnKind): number {
  return kind === "text" ? 2 : 1;
}

/** The sections a file carries: COL-06's link-only sections stay on the screen. */
export function exportedSections(view: ReportView): ReportSection[] {
  return view.sections.filter((section) => section.exported !== false);
}

function sectionBlocks(section: ReportSection): PdfBlock[] {
  const columns: PdfColumn[] = section.columns.map((column) => ({
    title: column.label,
    width: columnWidth(column.kind),
    align: column.kind === "text" ? "start" : "end",
  }));
  const blocks: PdfBlock[] = [
    { kind: "heading", text: section.title },
    {
      kind: "table",
      label: section.title,
      columns,
      rows: section.rows.map((row) => ({
        // the screen's text; the bidi layout keeps an amount, a number or a percent in its own order (as on the quote PDF)
        cells: section.columns.map((column) => formatCell(column.kind, row[column.key])),
      })),
      empty: section.empty,
    },
  ];
  if (section.note) blocks.push({ kind: "paragraph", text: section.note, muted: true, size: 8.5 });
  return blocks;
}

export function reportPdfDocument(input: ReportPdfInput): PdfDocument {
  const { view } = input;
  const from: PdfLine[] = [{ text: input.business, bold: true, size: 11 }];
  const meta: PdfLine[] = [{ text: input.periodText }, ...input.filters.map((text) => ({ text })), { text: input.madeAt, muted: true }];

  const blocks: PdfBlock[] = [];
  if (view.kpis.length > 0) {
    blocks.push({ kind: "heading", text: "סיכום" });
    blocks.push({
      kind: "table",
      label: "סיכום",
      columns: [
        { title: "מדד", width: 3, align: "start" },
        { title: "ערך", width: 2, align: "end" },
      ],
      rows: view.kpis.map((kpi) => ({ cells: [{ text: kpi.label, sub: kpi.hint }, kpi.value] })),
    });
  }
  for (const section of exportedSections(view)) blocks.push(...sectionBlocks(section));
  if (view.note) blocks.push({ kind: "paragraph", text: view.note, muted: true, size: 8.5 });

  return {
    title: input.title,
    heading: input.title,
    color: null,
    logo: null,
    from,
    meta,
    blocks,
    closing: null,
    footerNote: null,
    pageNote: input.title,
  };
}

/** The file's name: the report's key and the period's first day, like the CSV and Excel files. */
export function reportPdfFileName(key: string, fromDate: string): string {
  return `report-${key}-${fromDate}.pdf`;
}
