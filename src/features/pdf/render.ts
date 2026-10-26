// QUO-06: the PDF renderer. Runs on our own server (owner, 13 October 2026: no outside service), from structured data
// (document.ts), with the Heebo font from the repo. Every line is wrapped and put in visual order here (text-layout.ts,
// bidi.ts) and written left to right; pages are cut by paginate.ts, and a table's header row is repeated on every page
// it continues on. The business's colour is corrected for contrast like BrandScope does (brandPalette, light).
//
// pdfkit lays text out through fontkit, which reverses any run it takes for Hebrew. The lines given to it are already in
// visual order, so the layout is asked for the Latin script (one left-to-right run, kerning and mark positions kept):
// pdfkit hands `features` straight to fontkit's layout(text, script) when it is a string. Pinned with the exact pdfkit
// version in package.json; tests/unit/pdf-render.test.ts reads the text back from a real file and fails if this changes.

import PDFDocument from "pdfkit";

import { brandPalette, DEFAULT_PICKER_COLOR, isHexColor } from "@/features/branding/color";

import type { PdfBlock, PdfCell, PdfDocument, PdfLine, PdfTextStyle } from "./document";
import { HEEBO_BOLD_BASE64 } from "./fonts/heebo-bold";
import { HEEBO_REGULAR_BASE64 } from "./fonts/heebo-regular";
import { paginate, splitRowLines, type Piece } from "./paginate";
import { wrapText, type VisualLine } from "./text-layout";

/** The light theme's ink and line colours (src/app/globals.css; tests/unit/pdf-render.test.ts keeps them equal). */
export const PDF_COLORS = {
  ink: "#141c26",
  inkSoft: "#525e6c",
  line: "#e2e6eb",
  lineStrong: "#c5ccd5",
} as const;

// A4 in points
export const PAGE = { width: 595.28, height: 841.89, marginX: 40, marginTop: 40, marginBottom: 56 } as const;
const CONTENT = PAGE.width - 2 * PAGE.marginX;
const BASE_SIZE = 9.5;
const LINE = 1.45;
const CELL_PAD_X = 4;
const CELL_PAD_Y = 5;

// visual-order text: lay it out as one left-to-right run (see the note at the top)
const LTR_RUN = "latn";

let fonts: { regular: Buffer; bold: Buffer } | null = null;
function fontData() {
  fonts ??= { regular: Buffer.from(HEEBO_REGULAR_BASE64, "base64"), bold: Buffer.from(HEEBO_BOLD_BASE64, "base64") };
  return fonts;
}

type Styled = VisualLine & { style: PdfTextStyle };

/** Renders the document; answers the bytes of the PDF file. */
export async function renderPdf(doc: PdfDocument): Promise<Uint8Array> {
  const { regular, bold } = fontData();
  const pdf = new PDFDocument({
    size: "A4",
    margin: 0,
    autoFirstPage: false,
    bufferPages: true,
    font: regular,
    lang: "he-IL",
    displayTitle: true,
    info: { Title: doc.title },
  });
  pdf.registerFont("r", regular);
  pdf.registerFont("b", bold);

  const chunks: Uint8Array[] = [];
  pdf.on("data", (chunk: Uint8Array) => chunks.push(chunk));
  const finished = new Promise<void>((resolve, reject) => {
    pdf.on("end", () => resolve());
    pdf.on("error", reject);
  });

  const palette = brandPalette(isHexColor(doc.color) ? doc.color : DEFAULT_PICKER_COLOR, "light");
  const colorOf = (style: PdfTextStyle) => (style.accent ? palette.accentStrong : style.muted ? PDF_COLORS.inkSoft : PDF_COLORS.ink);
  const sizeOf = (style: PdfTextStyle) => style.size ?? BASE_SIZE;
  const lineHeight = (style: PdfTextStyle) => sizeOf(style) * LINE;
  const applyStyle = (style: PdfTextStyle) => pdf.font(style.bold ? "b" : "r").fontSize(sizeOf(style));
  // widths are asked again and again while wrapping (each candidate line): one layout per font, size and text
  const widths = new Map<string, number>();
  const measure = (style: PdfTextStyle) => (text: string) => {
    const key = `${style.bold ? "b" : "r"}${sizeOf(style)}|${text}`;
    let width = widths.get(key);
    if (width === undefined) {
      applyStyle(style);
      width = pdf.widthOfString(text, { features: LTR_RUN });
      widths.set(key, width);
    }
    return width;
  };
  const wrap = (text: string, width: number, style: PdfTextStyle): Styled[] =>
    wrapText(text, width, measure(style)).map((line) => ({ ...line, style }));

  /** One visual line at the top `y`, aligned to the start (right) or end (left) of the box [x, x + width]. */
  const write = (line: Styled, x: number, y: number, width: number, align: "start" | "end") => {
    if (!line.text) return;
    applyStyle(line.style).fillColor(colorOf(line.style));
    const left = align === "start" ? x + width - line.width : x;
    pdf.text(line.text, left, y, { lineBreak: false, features: LTR_RUN });
  };
  const writeLines = (lines: Styled[], x: number, y: number, width: number, align: "start" | "end") => {
    let top = y;
    for (const line of lines) {
      write(line, x, top, width, align);
      top += lineHeight(line.style);
    }
    return top - y;
  };
  const heightOf = (lines: Styled[]) => lines.reduce((sum, line) => sum + lineHeight(line.style), 0);
  const rule = (y: number, color: string, weight: number, x = PAGE.marginX, width = CONTENT) => {
    pdf.moveTo(x, y).lineTo(x + width, y).lineWidth(weight).strokeColor(color).stroke();
  };
  const linesOf = (items: PdfLine[], width: number) => items.flatMap((item) => wrap(item.text, width, item));

  // ---------------------------------------------------------------- letterhead (first page)
  const half = CONTENT * 0.48;
  const logo = doc.logo;
  const logoBox = { width: 150, height: 48 };
  const fromLines = linesOf(doc.from, half);
  const headingLines = wrap(doc.heading, half, { bold: true, size: 17, accent: true });
  const metaLines = linesOf(doc.meta, half);
  const startHeight = (logo ? logoBox.height + 8 : 0) + heightOf(fromLines);
  const endHeight = heightOf(headingLines) + 4 + heightOf(metaLines);
  const letterheadHeight = Math.max(startHeight, endHeight) + 14;
  const drawLetterhead = () => {
    const top = PAGE.marginTop;
    const startX = PAGE.width - PAGE.marginX - half;
    let y = top;
    if (logo) {
      // at the start (right) edge of the page
      pdf.image(Buffer.from(logo.data), PAGE.width - PAGE.marginX - logoBox.width, y, { fit: [logoBox.width, logoBox.height], align: "right", valign: "top" });
      y += logoBox.height + 8;
    }
    writeLines(fromLines, startX, y, half, "start");
    const endY = top + writeLines(headingLines, PAGE.marginX, top, half, "end") + 4;
    writeLines(metaLines, PAGE.marginX, endY, half, "end");
    rule(top + letterheadHeight - 6, palette.accent, 2);
  };

  // ---------------------------------------------------------------- blocks into pieces
  type DrawPiece = Piece & { draw: (y: number) => void; header?: (y: number) => void };
  const pieces: DrawPiece[] = [];
  const gap = 12;

  const textPieces = (lines: Styled[], gapBefore: number, x = PAGE.marginX, width = CONTENT, align: "start" | "end" = "start") => {
    lines.forEach((line, index) => {
      pieces.push({
        height: lineHeight(line.style),
        gapBefore: index === 0 ? gapBefore : 0,
        draw: (y) => write(line, x, y, width, align),
      });
    });
  };

  let tableCount = 0;
  const addBlock = (block: PdfBlock) => {
    switch (block.kind) {
      case "paragraph": {
        textPieces(wrap(block.text, CONTENT, block), gap);
        return;
      }
      case "rule": {
        pieces.push({ height: 6, gapBefore: gap, draw: (y) => rule(y + 3, PDF_COLORS.line, 0.75) });
        return;
      }
      case "columns": {
        const start = linesOf(block.start, half);
        const end = linesOf(block.end, half);
        pieces.push({
          height: Math.max(heightOf(start), heightOf(end)),
          gapBefore: gap,
          draw: (y) => {
            writeLines(start, PAGE.width - PAGE.marginX - half, y, half, "start");
            writeLines(end, PAGE.marginX, y, half, "end");
          },
        });
        return;
      }
      case "heading": {
        const title = wrap(block.text, CONTENT, { bold: true });
        title.forEach((line, index) =>
          pieces.push({
            height: lineHeight(line.style),
            gapBefore: index === 0 ? gap + 2 : 0,
            keepWithNext: true,
            draw: (y) => write(line, PAGE.marginX, y, CONTENT, "start"),
          }),
        );
        return;
      }
      case "section": {
        const title = wrap(block.title, CONTENT, { bold: true });
        const body = block.text.trim() ? wrap(block.text, CONTENT, {}) : [];
        title.forEach((line, index) =>
          pieces.push({
            height: lineHeight(line.style),
            gapBefore: index === 0 ? gap + 2 : 0,
            keepWithNext: index === title.length - 1 && body.length > 0,
            draw: (y) => write(line, PAGE.marginX, y, CONTENT, "start"),
          }),
        );
        textPieces(body, 0);
        return;
      }
      case "totals": {
        const boxWidth = CONTENT * 0.46;
        const labelWidth = boxWidth * 0.6;
        const valueWidth = boxWidth - labelWidth - 6;
        block.rows.forEach((row, index) => {
          const style: PdfTextStyle = { bold: row.strong, muted: row.muted, size: row.strong ? 10.5 : BASE_SIZE };
          const label = wrap(row.label, labelWidth, style);
          const value = wrap(row.value, valueWidth, style);
          const height = Math.max(heightOf(label), heightOf(value)) + (row.strong ? 6 : 2);
          pieces.push({
            height,
            gapBefore: index === 0 ? gap : 0,
            keepWithNext: index < block.rows.length - 1,
            draw: (y) => {
              const top = row.strong ? y + 5 : y + 1;
              if (row.strong) rule(y + 1.5, palette.accent, 1.5, PAGE.marginX, boxWidth);
              writeLines(label, PAGE.marginX + boxWidth - labelWidth, top, labelWidth, "start");
              writeLines(value, PAGE.marginX, top, valueWidth, "end");
            },
          });
        });
        for (const note of block.notes ?? []) {
          textPieces(wrap(note, boxWidth, { muted: true, size: 8.5 }), 2, PAGE.marginX, boxWidth, "start");
        }
        return;
      }
      case "table": {
        const id = `t${tableCount++}`;
        const widths = block.columns.map((column) => column.width);
        const total = widths.reduce((a, b) => a + b, 0) || 1;
        const colWidths = widths.map((w) => (w / total) * CONTENT);
        // columns run from the start (right) edge leftwards
        const colX: number[] = [];
        let right = PAGE.width - PAGE.marginX;
        for (const width of colWidths) {
          right -= width;
          colX.push(right);
        }
        const headStyle: PdfTextStyle = { bold: true, size: 8.5 };
        const headLines = block.columns.map((column, i) => wrap(column.title, colWidths[i] - 2 * CELL_PAD_X, headStyle));
        const headHeight = Math.max(...headLines.map(heightOf)) + 2 * CELL_PAD_Y;
        const drawHeader = (y: number) => {
          const top = y - headHeight;
          block.columns.forEach((column, i) => writeLines(headLines[i], colX[i] + CELL_PAD_X, top + CELL_PAD_Y, colWidths[i] - 2 * CELL_PAD_X, column.align));
          rule(y - 0.75, PDF_COLORS.lineStrong, 1.5);
        };
        if (block.rows.length === 0) {
          textPieces(wrap(block.empty ?? "", CONTENT, { muted: true }), gap);
          return;
        }
        block.rows.forEach((row, rowIndex) => {
          // a group row: its first cell spans the columns the row does not fill
          const span = row.group && row.cells.length < block.columns.length ? block.columns.length - row.cells.length + 1 : 1;
          const cells = row.cells.map((raw, i) => {
            const cell: PdfCell = typeof raw === "string" ? { text: raw } : raw;
            const first = i === 0 ? 0 : span - 1 + i;
            const columns = i === 0 ? span : 1;
            const x = colX[first + columns - 1];
            const width = colWidths.slice(first, first + columns).reduce((a, b) => a + b, 0);
            const style: PdfTextStyle = row.group ? { ...cell, bold: true, accent: i === 0, muted: i > 0 } : cell;
            const lines = [
              ...wrap(cell.text, width - 2 * CELL_PAD_X, style),
              ...(cell.sub ? wrap(cell.sub, width - 2 * CELL_PAD_X, { muted: true, size: 8.5 }) : []),
            ];
            return { x, width, lines, align: block.columns[first].align };
          });
          const maxHeight = PAGE.height - PAGE.marginTop - PAGE.marginBottom - headHeight - 4;
          const lineH = lineHeight({});
          const fullHeight = Math.max(...cells.map((cell) => heightOf(cell.lines))) + 2 * CELL_PAD_Y;
          const parts =
            fullHeight > maxHeight
              ? splitRowLines(cells.map((cell) => cell.lines.length), lineH, 2 * CELL_PAD_Y, maxHeight)
              : [cells.map((cell) => [0, cell.lines.length] as [number, number])];
          parts.forEach((ranges, partIndex) => {
            const partCells = cells.map((cell, i) => ({ ...cell, lines: cell.lines.slice(ranges[i][0], ranges[i][1]) }));
            const height = Math.max(...partCells.map((cell) => heightOf(cell.lines))) + 2 * CELL_PAD_Y;
            const last = partIndex === parts.length - 1;
            pieces.push({
              height,
              gapBefore: rowIndex === 0 && partIndex === 0 ? gap : 0,
              table: { id, headerHeight: headHeight },
              header: drawHeader,
              draw: (y) => {
                for (const cell of partCells) writeLines(cell.lines, cell.x + CELL_PAD_X, y + CELL_PAD_Y, cell.width - 2 * CELL_PAD_X, cell.align);
                if (last) rule(y + height - 0.5, row.group ? PDF_COLORS.lineStrong : PDF_COLORS.line, row.group ? 1 : 0.75);
              },
            });
          });
        });
        return;
      }
    }
  };
  for (const block of doc.blocks) addBlock(block);
  if (doc.closing) {
    pieces.push({ height: 6, gapBefore: gap + 4, keepWithNext: true, draw: (y) => rule(y + 3, PDF_COLORS.line, 0.75) });
    textPieces(wrap(doc.closing, CONTENT, { muted: true, size: 8.5 }), 2);
  }
  if (doc.footerNote) {
    if (!doc.closing) pieces.push({ height: 6, gapBefore: gap + 4, keepWithNext: true, draw: (y) => rule(y + 3, PDF_COLORS.line, 0.75) });
    textPieces(wrap(doc.footerNote, CONTENT, { muted: true, size: 8 }), 2);
  }

  // ---------------------------------------------------------------- pages
  const body = PAGE.height - PAGE.marginTop - PAGE.marginBottom;
  const placements = paginate(pieces, body, body - letterheadHeight);
  let page = -1;
  for (const placement of placements) {
    while (page < placement.page) {
      pdf.addPage({ size: "A4", margin: 0 });
      page++;
      if (page === 0) drawLetterhead();
    }
    const top = PAGE.marginTop + (placement.page === 0 ? letterheadHeight : 0) + placement.y;
    const piece = pieces[placement.piece];
    if (placement.headerAbove && piece.header) piece.header(top);
    piece.draw(top);
  }
  if (page < 0) {
    pdf.addPage({ size: "A4", margin: 0 });
    drawLetterhead();
  }

  // the foot of every page: "עמוד X מתוך Y" and the document's note
  const range = pdf.bufferedPageRange();
  const footStyle: PdfTextStyle = { muted: true, size: 8 };
  for (let i = 0; i < range.count; i++) {
    pdf.switchToPage(range.start + i);
    const y = PAGE.height - PAGE.marginBottom + 18;
    rule(y - 6, PDF_COLORS.line, 0.5);
    const count = wrap(`עמוד ${i + 1} מתוך ${range.count}`, CONTENT / 2, footStyle);
    writeLines(count, PAGE.marginX, y, CONTENT / 2, "end");
    if (doc.pageNote) writeLines(wrap(doc.pageNote, CONTENT / 2, footStyle), PAGE.width / 2, y, CONTENT / 2, "start");
  }
  pdf.end();
  await finished;
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export type { PdfDocument };
