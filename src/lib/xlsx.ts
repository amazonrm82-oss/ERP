import { strToU8, zipSync } from "fflate";

// A minimal Excel (.xlsx) file: one sheet, right-to-left, written as inline
// strings so no shared-strings table is needed. Excel, LibreOffice and Google
// Sheets open it. `xlsxFile` is the list export (text cells, a frozen bold
// header row); `xlsxSheet` takes typed cells (numbers, money, percent, dates).

// characters XML 1.0 does not allow are dropped
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
const escape = (text: string) => text.replace(INVALID_XML, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

/**
 * One cell. A string or null is plain text (null and "" leave the cell empty).
 * money is in shekels, percent is a fraction (0.425 shows as 42.5%), date is a
 * calendar day "YYYY-MM-DD" (no time, so no time zone shift).
 */
export type XlsxCell =
  | string
  | null
  | { type: "text"; value: string; bold?: boolean }
  | { type: "number" | "money" | "percent"; value: number }
  | { type: "date"; value: string };

// cellXfs indexes in styles.xml below
const STYLE = { plain: 0, bold: 1, money: 2, percent: 3, date: 4, number: 5, decimal: 6 } as const;

/** Excel's serial day number of a calendar date (days since 1899-12-30), or null when it is not a real date. */
export function excelDate(day: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const time = Date.UTC(y, m - 1, d);
  const back = new Date(time);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d || y < 1900) return null;
  return time / 86_400_000 + 25_569;
}

/**
 * A valid sheet name: forbidden characters (: \\ / ? * [ ]) become spaces, no
 * apostrophe at either end, at most 31 characters, never empty or "History".
 */
export function sheetName(name: string, fallback = "Sheet1"): string {
  const cleaned = Array.from(name.replace(INVALID_XML, "").replace(/[:\\/?*[\]]/g, " ").replace(/\s+/g, " "))
    .slice(0, 31)
    .join("")
    .trim()
    .replace(/^'+|'+$/g, "")
    .trim();
  return cleaned === "" || cleaned.toLowerCase() === "history" ? fallback : cleaned;
}

function cellXml(ref: string, cell: XlsxCell): string {
  if (cell === null) return "";
  if (typeof cell === "string") cell = { type: "text", value: cell };
  if (cell.type === "text") {
    return cell.value === ""
      ? ""
      : `<c r="${ref}" t="inlineStr"${cell.bold ? ` s="${STYLE.bold}"` : ""}><is><t xml:space="preserve">${escape(cell.value.slice(0, 32767))}</t></is></c>`;
  }
  if (cell.type === "date") {
    const serial = excelDate(cell.value);
    return serial === null ? cellXml(ref, cell.value) : `<c r="${ref}" s="${STYLE.date}"><v>${serial}</v></c>`;
  }
  if (!Number.isFinite(cell.value)) return "";
  const style = cell.type === "number" && !Number.isInteger(cell.value) ? STYLE.decimal : STYLE[cell.type];
  return `<c r="${ref}" s="${style}"><v>${cell.value}</v></c>`;
}

const cellWidth = (cell: XlsxCell): number => {
  if (cell === null) return 0;
  if (typeof cell === "string") return cell.length;
  if (cell.type === "text") return cell.value.length;
  if (cell.type === "date") return 10;
  return String(Math.round(cell.value * 100) / 100).length + (cell.type === "money" ? 4 : 2);
};

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

export function xlsxFile(name: string, header: string[], rows: string[][]): Uint8Array {
  return xlsxSheet(name, [header.map((value) => ({ type: "text" as const, value, bold: true })), ...rows], { freezeFirstRow: true });
}

/** One sheet of typed cells, right to left. Column widths follow the first 200 rows. */
export function xlsxSheet(name: string, rows: XlsxCell[][], options: { freezeFirstRow?: boolean } = {}): Uint8Array {
  const columns = Math.max(0, ...rows.map((r) => r.length));
  const sample = rows.slice(0, 200);
  const widths = Array.from({ length: columns }, (_, i) => Math.min(60, Math.max(10, ...sample.map((r) => cellWidth(r[i] ?? null) + 2))));
  const rowXml = (cells: XlsxCell[], r: number) => `<row r="${r}">${cells.map((cell, i) => cellXml(`${columnName(i)}${r}`, cell)).join("")}</row>`;
  const pane = options.freezeFirstRow ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' : "";

  const sheet =
    XML_HEAD +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetViews><sheetView workbookViewId="0" rightToLeft="1">${pane}</sheetView></sheetViews>` +
    (columns > 0 ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "") +
    `<sheetData>${rows.map((cells, i) => rowXml(cells, i + 1)).join("")}</sheetData>` +
    "</worksheet>";

  const title = escape(sheetName(name));
  const files: Record<string, string> = {
    "[Content_Types].xml":
      XML_HEAD +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      "</Types>",
    "_rels/.rels":
      XML_HEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      "</Relationships>",
    "xl/workbook.xml":
      XML_HEAD +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<sheets><sheet name="${title}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels":
      XML_HEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      "</Relationships>",
    "xl/styles.xml":
      XML_HEAD +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      // 164: shekels with two decimals; 165: a percent with one decimal; 166: a day; built-in 3 and 4: whole and decimal numbers with thousands separators
      '<numFmts count="3"><numFmt numFmtId="164" formatCode="[$₪-40D]\\ #,##0.00;[$₪-40D]\\ \\-#,##0.00"/><numFmt numFmtId="165" formatCode="0.0%"/>' +
      '<numFmt numFmtId="166" formatCode="dd/mm/yyyy"/></numFmts>' +
      '<fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      "</styleSheet>",
    "xl/worksheets/sheet1.xml": sheet,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)])));
}
