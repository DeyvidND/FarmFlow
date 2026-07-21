import { PDFFont, PDFImage } from 'pdf-lib';
import { contentW, Doc, drawBoldText, ensureSpace, INK, MARGIN, newPage, wrap } from './pdf-kit';

export interface Column {
  header: string;
  width: number;
  align?: 'left' | 'right' | 'center';
}

/**
 * Split `total` into per-column widths in proportion to `weights`. The last
 * column absorbs the rounding remainder so the widths sum to `total` exactly —
 * a one-point gap is invisible on screen and a visible seam in print.
 *
 * Every weight must be a positive, finite number: an empty `weights` array has
 * no proportions to split by (and would corrupt the array via
 * `out[out.length - 1]` on a `-1` index), and a zero-or-negative sum divides by
 * a non-positive number, producing `NaN`/`Infinity` widths that would only
 * surface much later as a broken layout. No caller passes either today, but
 * this is exported for config-driven column sets to build on next.
 */
export function columnWidths(total: number, weights: number[]): number[] {
  if (weights.length === 0 || !weights.every((w) => Number.isFinite(w) && w > 0)) {
    throw new Error(
      `columnWidths: weights must be a non-empty array of positive numbers, got ${JSON.stringify(weights)}`,
    );
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  const out = weights.map((w) => Math.floor((total * w) / sum));
  out[out.length - 1] += total - out.reduce((a, b) => a + b, 0);
  return out;
}

/** A pre-embedded image drawn at a fixed box — the caller owns its size. */
export interface ImageCell {
  image: PDFImage;
  width: number;
  height: number;
}

/** A table cell: wrapped text, or a pre-embedded image drawn at a fixed box. */
export type Cell = string | ImageCell;

export type LaidOutCell = string[] | ImageCell;

export interface LaidOutRow {
  /** One wrapped-line array per text column, or the image cell, always `columns.length` long. */
  cells: LaidOutCell[];
  height: number;
}

/** Where a row was actually drawn — фаза 1 needs this to place a
 *  signatures-by-row-number block against section А's rows. */
export interface PlacedRow {
  pageIndex: number;
  y: number;
  height: number;
}

const isImage = (c: LaidOutCell): c is ImageCell => typeof c === 'object' && !Array.isArray(c);

/**
 * Pure layout: wrap every cell inside its own column and compute the row height
 * from the tallest cell. Kept separate from drawing so the maths is unit-tested
 * directly instead of by parsing PDF bytes.
 *
 * An empty cell becomes `['']` rather than `[]` — a zero-line cell would let the
 * row collapse and knock the grid out of alignment.
 *
 * Overloaded on the input: callers passing plain `string[][]` (every
 * pre-image-cell caller, including this file's own text-only tests) get back
 * `cells: string[][]` rather than the widened `LaidOutCell[]` — TypeScript
 * cannot narrow a union return type after the fact, so without this overload
 * `row.cells[i].length` and `for...of row.cells[i]` would stop compiling for
 * text-only callers even though every cell really is a `string[]` at runtime.
 */
export function layoutTable(
  columns: Column[],
  rows: string[][],
  font: PDFFont,
  size: number,
  padding: number,
): Array<{ cells: string[][]; height: number }>;
export function layoutTable(
  columns: Column[],
  rows: Cell[][],
  font: PDFFont,
  size: number,
  padding: number,
): LaidOutRow[];
export function layoutTable(
  columns: Column[],
  rows: Cell[][],
  font: PDFFont,
  size: number,
  padding: number,
): LaidOutRow[] {
  const lineHeight = size + 3;
  return rows.map((row) => {
    const cells: LaidOutCell[] = columns.map((col, i) => {
      const cell = row[i] ?? '';
      if (typeof cell === 'object') return cell;
      const lines = wrap(cell, font, size, col.width - 2 * padding);
      return lines.length ? lines : [''];
    });
    // `Math.max()` with no arguments (an empty `columns` list, or a row with no
    // image cells) returns `-Infinity`, which would poison `paginateRows`'s
    // running `used` total for the rest of the table. Fall back to 0 so the
    // height stays finite (padding alone).
    const textHeight = Math.max(0, ...cells.map((c) => (isImage(c) ? 0 : c.length * lineHeight)));
    const imageHeight = Math.max(0, ...cells.map((c) => (isImage(c) ? c.height : 0)));
    return { cells, height: Math.max(textHeight, imageHeight) + 2 * padding };
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
 *
 * Returns where every row actually landed, in input order — фаза 1 needs this
 * to place a signatures-by-row-number block against section А's rows without
 * re-deriving the pagination itself.
 */
export function drawTable(
  d: Doc,
  columns: Column[],
  rows: Cell[][],
  opts: { size?: number; padding?: number } = {},
): PlacedRow[] {
  const size = opts.size ?? 9;
  const padding = opts.padding ?? 4;
  const lineHeight = size + 3;
  const headerHeight = lineHeight + 2 * padding;

  // A table wider than the page prints a legal document with a column sliced
  // off the edge, unnoticed until someone is holding it — a composition-time
  // programming error, not a runtime condition to clamp and recover from.
  const totalW = columns.reduce((sum, c) => sum + c.width, 0);
  const available = contentW(d);
  if (totalW > available) {
    throw new Error(`drawTable: columns total ${totalW}pt but only ${available}pt of content width is available`);
  }

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

  // Alignment-aware x for a piece of text in column `colIndex`, shared by the
  // header row and body cells so a right-aligned money column's header lines
  // up with its own values rather than sitting flush left above them.
  const textX = (colIndex: number, text: string, textSize: number) => {
    const col = columns[colIndex];
    const left = xOf(colIndex) + padding;
    if (!col.align || col.align === 'left') return left;
    const tw = d.font.widthOfTextAtSize(text, textSize);
    const right = xOf(colIndex) + col.width - padding - tw;
    return col.align === 'right' ? right : (left + right) / 2;
  };

  const drawHeader = () => {
    columns.forEach((col, i) => {
      drawBoldText(d, col.header, textX(i, col.header, size), d.y - lineHeight + 3, size);
    });
    d.y -= headerHeight;
    d.page.drawLine({
      start: { x: MARGIN, y: d.y },
      end: { x: MARGIN + totalW, y: d.y },
      thickness: 0.8,
      color: INK,
    });
  };

  const placed: PlacedRow[] = [];

  pages.forEach((pageRows, pageIndex) => {
    if (pageIndex > 0) newPage(d);
    drawHeader();
    for (const row of pageRows) {
      row.cells.forEach((cell, i) => {
        if (isImage(cell)) {
          d.page.drawImage(cell.image, {
            x: xOf(i) + padding,
            y: d.y - padding - cell.height,
            width: cell.width,
            height: cell.height,
          });
          return;
        }
        cell.forEach((line, lineIndex) => {
          d.page.drawText(line, {
            x: textX(i, line, size),
            y: d.y - padding - (lineIndex + 1) * lineHeight + 3,
            size,
            font: d.font,
            color: INK,
          });
        });
      });
      placed.push({ pageIndex, y: d.y - row.height, height: row.height });
      d.y -= row.height;
      d.page.drawLine({
        start: { x: MARGIN, y: d.y },
        end: { x: MARGIN + totalW, y: d.y },
        thickness: 0.3,
        color: INK,
      });
    }
  });

  return placed;
}
