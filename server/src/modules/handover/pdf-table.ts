import { PDFFont } from 'pdf-lib';
import { Doc, drawBoldText, ensureSpace, INK, MARGIN, newPage, wrap } from './pdf-kit';

export interface Column {
  header: string;
  width: number;
  align?: 'left' | 'right';
}

export interface LaidOutRow {
  /** One wrapped-line array per column, always `columns.length` long. */
  cells: string[][];
  height: number;
}

/**
 * Pure layout: wrap every cell inside its own column and compute the row height
 * from the tallest cell. Kept separate from drawing so the maths is unit-tested
 * directly instead of by parsing PDF bytes.
 *
 * An empty cell becomes `['']` rather than `[]` — a zero-line cell would let the
 * row collapse and knock the grid out of alignment.
 */
export function layoutTable(
  columns: Column[],
  rows: string[][],
  font: PDFFont,
  size: number,
  padding: number,
): LaidOutRow[] {
  const lineHeight = size + 3;
  return rows.map((row) => {
    const cells = columns.map((col, i) => {
      const text = row[i] ?? '';
      const lines = wrap(text, font, size, col.width - 2 * padding);
      return lines.length ? lines : [''];
    });
    // `Math.max()` with no arguments (an empty `columns` list) returns `-Infinity`,
    // which would poison `paginateRows`'s running `used` total for the rest of the
    // table. Fall back to 0 lines so the height stays finite (padding alone).
    const tallest = cells.length ? Math.max(...cells.map((c) => c.length)) : 0;
    return { cells, height: tallest * lineHeight + 2 * padding };
  });
}

/**
 * Split laid-out rows into pages. `firstPageSpace` is usually smaller than
 * `laterPageSpace` because a document header sits above the table on page one;
 * both lose `headerHeight` to the repeated column-header row.
 *
 * A row taller than a whole page is emitted alone rather than pushed to a fresh
 * page forever — that would loop, or leave a blank page before it.
 */
export function paginateRows(
  rows: LaidOutRow[],
  firstPageSpace: number,
  laterPageSpace: number,
  headerHeight: number,
): LaidOutRow[][] {
  if (!rows.length) return [[]];

  const pages: LaidOutRow[][] = [];
  let current: LaidOutRow[] = [];
  let used = 0;
  let budget = firstPageSpace - headerHeight;

  for (const row of rows) {
    if (current.length && used + row.height > budget) {
      pages.push(current);
      current = [];
      used = 0;
      budget = laterPageSpace - headerHeight;
    }
    current.push(row);
    used += row.height;
  }
  pages.push(current);
  return pages;
}

/**
 * Draw a table, breaking pages as needed and repeating the column-header row on
 * every page. Advances `d.y` past the table; `d.page` is left on the last page.
 */
export function drawTable(
  d: Doc,
  columns: Column[],
  rows: string[][],
  opts: { size?: number; padding?: number } = {},
): void {
  const size = opts.size ?? 9;
  const padding = opts.padding ?? 4;
  const lineHeight = size + 3;
  const headerHeight = lineHeight + 2 * padding;

  // Lay the rows out first so the real height of row zero is known before we
  // decide whether to break — see the `ensureSpace` call below.
  const laid = layoutTable(columns, rows, d.font, size, padding);

  // Guarantee room for the column-header row, and — when the table has rows —
  // for the first content row too, before the first page's budget is derived
  // from `d.y`. `paginateRows` always admits a page's first row unconditionally,
  // however little budget remains, so reserving only `headerHeight` let a
  // starting cursor with "just enough" room for the header alone draw that
  // first row (and its rule) below MARGIN — off the usable page. Using the
  // first row's actual laid-out height (rather than assuming it matches
  // `headerHeight`) keeps this correct for rows that wrap to several lines.
  // With zero rows there is nothing to reserve beyond the header itself.
  const firstRowHeight = laid.length ? laid[0].height : 0;
  ensureSpace(d, headerHeight + firstRowHeight);

  const pages = paginateRows(
    laid,
    d.y - MARGIN,
    d.size.h - 2 * MARGIN - d.reservedTopOnNewPage,
    headerHeight,
  );

  const xOf = (i: number) => MARGIN + columns.slice(0, i).reduce((sum, c) => sum + c.width, 0);
  const totalW = columns.reduce((sum, c) => sum + c.width, 0);

  const drawHeader = () => {
    columns.forEach((col, i) => {
      drawBoldText(d, col.header, xOf(i) + padding, d.y - lineHeight + 3, size);
    });
    d.y -= headerHeight;
    d.page.drawLine({
      start: { x: MARGIN, y: d.y },
      end: { x: MARGIN + totalW, y: d.y },
      thickness: 0.8,
      color: INK,
    });
  };

  pages.forEach((pageRows, pageIndex) => {
    if (pageIndex > 0) newPage(d);
    drawHeader();
    for (const row of pageRows) {
      row.cells.forEach((lines, i) => {
        lines.forEach((line, lineIndex) => {
          d.page.drawText(line, {
            x: xOf(i) + padding,
            y: d.y - padding - (lineIndex + 1) * lineHeight + 3,
            size,
            font: d.font,
            color: INK,
          });
        });
      });
      d.y -= row.height;
      d.page.drawLine({
        start: { x: MARGIN, y: d.y },
        end: { x: MARGIN + totalW, y: d.y },
        thickness: 0.3,
        color: INK,
      });
    }
  });
}
