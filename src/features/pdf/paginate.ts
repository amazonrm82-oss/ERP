// QUO-06: placing measured pieces of a document on pages. Pure, so the page breaks are unit tested.
//
// A piece is a block (a heading, a paragraph, the totals) or a table row. A table's header row is drawn above its
// first row and again at the top of every page the table continues on. A block or a row is never cut: it moves to
// the next page whole; one taller than a whole page must be cut by the caller first (splitRowLines). A piece may ask
// to stay with the next one (a section title and its first line, a table header and its first row).

export type Piece = {
  height: number;
  // a row of this table: its header (height) is repeated on every page the table continues on
  table?: { id: string; headerHeight: number };
  // do not end a page right after this piece
  keepWithNext?: boolean;
  // space above the piece, dropped at the top of a page
  gapBefore?: number;
};

export type Placement = {
  piece: number;
  page: number;
  // from the top of the page's body
  y: number;
  // the table header drawn right above this row, at y - headerHeight
  headerAbove: boolean;
};

/**
 * Puts the pieces on pages whose body is `bodyHeight` tall (the first page's body may be shorter, e.g. after a
 * letterhead). Answers one placement per piece, in order.
 */
export function paginate(pieces: readonly Piece[], bodyHeight: number, firstBodyHeight: number = bodyHeight): Placement[] {
  const out: Placement[] = [];
  let page = 0;
  let y = 0;
  let lastTable: string | null = null;
  const room = () => (page === 0 ? firstBodyHeight : bodyHeight);
  const need = (index: number, atTop: boolean, tableOpen: string | null): number => {
    const piece = pieces[index];
    const gap = atTop ? 0 : (piece.gapBefore ?? 0);
    const header = piece.table && (atTop || tableOpen !== piece.table.id) ? piece.table.headerHeight : 0;
    return gap + header + piece.height;
  };
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    const atTop = y === 0;
    let needed = need(i, atTop, lastTable);
    // keep-with-next: the next piece (as it would sit after this one) must fit too
    if (piece.keepWithNext && i + 1 < pieces.length) {
      const nextTable = piece.table ? piece.table.id : lastTable;
      needed += need(i + 1, false, nextTable);
    }
    if (!atTop && y + needed > room()) {
      page++;
      y = 0;
    }
    const top = y === 0;
    const gap = top ? 0 : (piece.gapBefore ?? 0);
    const headerAbove = piece.table !== undefined && (top || lastTable !== piece.table.id);
    const header = headerAbove && piece.table ? piece.table.headerHeight : 0;
    out.push({ piece: i, page, y: y + gap + header, headerAbove });
    y += gap + header + piece.height;
    lastTable = piece.table ? piece.table.id : null;
  }
  return out;
}

/**
 * Cuts a table row whose cells hold `lineCounts` lines into parts that each fit in `maxHeight`
 * (padding + lines x lineHeight). Every cell keeps its own lines in order; a part takes the next lines of every
 * cell. Answers, per part, the [from, to) line range of each cell.
 */
export function splitRowLines(lineCounts: readonly number[], lineHeight: number, padding: number, maxHeight: number): Array<Array<[number, number]>> {
  const perPart = Math.max(1, Math.floor((maxHeight - padding) / lineHeight));
  const most = Math.max(1, ...lineCounts);
  const parts: Array<Array<[number, number]>> = [];
  for (let from = 0; from < most; from += perPart) {
    parts.push(lineCounts.map((count) => [Math.min(from, count), Math.min(from + perPart, count)] as [number, number]));
  }
  return parts;
}
