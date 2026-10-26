// QUO-06: the shape of a business document for the PDF renderer (render.ts). Structured data, never HTML: a quote
// today; an order confirmation (ORD-05), a signed quote (QUO-09), a customer statement (BAL-04) and report exports
// (RPT-02) build the same shape. Amounts arrive as display text made from stored values; the renderer never adds up.

/** A left-to-right value (a phone, an email, a number with signs) inside a right-to-left line keeps its order. */
export function ltr(value: string): string {
  return `‎${value}‎`;
}

export type PdfTextStyle = {
  bold?: boolean;
  // ink-soft instead of ink
  muted?: boolean;
  // in the document's accent colour (corrected for contrast)
  accent?: boolean;
  // points; default 9.5
  size?: number;
};

export type PdfLine = PdfTextStyle & { text: string };

export type PdfCell = PdfTextStyle & {
  text: string;
  // a second, muted text under the first (a line's description)
  sub?: string;
};

export type PdfColumn = {
  title: string;
  // share of the table width
  width: number;
  // "start" = the right edge in a Hebrew document; numbers sit at "end"
  align: "start" | "end";
};

export type PdfRow = {
  cells: Array<PdfCell | string>;
  // a group heading row: accent colour, a stronger rule under it
  group?: boolean;
};

export type PdfBlock =
  | ({ kind: "paragraph"; text: string } & PdfTextStyle)
  | { kind: "columns"; start: PdfLine[]; end: PdfLine[] }
  | { kind: "table"; label: string; columns: PdfColumn[]; rows: PdfRow[]; empty?: string }
  | { kind: "totals"; rows: Array<{ label: string; value: string; strong?: boolean; muted?: boolean }>; notes?: string[] }
  | { kind: "section"; title: string; text: string }
  // a title that stays with what follows it (a table's name)
  | { kind: "heading"; text: string }
  | { kind: "rule" };

export type PdfLogo = { data: Uint8Array; kind: "png" | "jpeg" };

export type PdfDocument = {
  // the file's title (metadata) and the big word on the letterhead
  title: string;
  heading: string;
  // '#rrggbb' or null = the design system's accent
  color: string | null;
  logo: PdfLogo | null;
  // under the logo, on the start side of the letterhead (the business)
  from: PdfLine[];
  // under the heading, on the end side (number, dates)
  meta: PdfLine[];
  blocks: PdfBlock[];
  // a closing text after the blocks (the design's footer)
  closing?: string | null;
  // printed small at the foot of every page, beside "עמוד X מתוך Y" (e.g. "אינו חשבונית מס")
  pageNote?: string | null;
};
