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
 *  signatures-by-row-number block against section А's rows.
 *
 *  A row too tall for one page (see `splitRow`) is drawn across two pages —
 *  this points at where its HEAD landed. The continuation carried to the
 *  next page does not get its own entry, so `placed.length` always matches
 *  the number of rows the caller passed in. */
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
 * Cut a text row at a line boundary so its head fits `availableHeight`.
 * Returns `null` when the row already fits, or when any cell is an image —
 * an image has no line boundary to cut at, and silently scaling a signature
 * to fit is worse than one oversized row.
 *
 * Always leaves at least one line in the head: a zero-line head would make the
 * caller loop forever on the same row.
 */
export function splitRow(
  row: LaidOutRow,
  availableHeight: number,
  lineHeight: number,
  padding: number,
): [LaidOutRow, LaidOutRow] | null {
  if (row.height <= availableHeight) return null;
  if (row.cells.some(isImage)) return null;

  const fit = Math.max(1, Math.floor((availableHeight - 2 * padding) / lineHeight));
  const cells = row.cells as string[][];
  if (cells.every((c) => c.length <= fit)) return null;

  const head = cells.map((c) => c.slice(0, fit));
  const tail = cells.map((c) => c.slice(fit));
  const heightOf = (cs: string[][]) => Math.max(...cs.map((c) => c.length)) * lineHeight + 2 * padding;
  return [
    { cells: head, height: heightOf(head) },
    { cells: tail, height: heightOf(tail) },
  ];
}

/**
 * Scale down any image cell in `row` whose height exceeds `maxImageHeight`,
 * preserving its aspect ratio (width scaled by the same factor). A no-op for
 * rows with no image cell, or whose image already fits.
 *
 * `maxImageHeight` is the space actually left on the CURRENT page, not a
 * page-wide constant — `drawTable` always draws the column-header row before
 * any body row, so the room a row's image has is the usable page height
 * *minus* the header and the row's own padding, not the raw
 * `d.size.h - 2 * MARGIN`. The caller computes it from the live cursor so it
 * reflects whatever chrome (header, `reservedTopOnNewPage`) already sits
 * above this row on its actual page.
 *
 * `splitRow` refuses to split an image row — there is no correct place to cut
 * a signature — so this is the last line of defence against one drawing off
 * the bottom of the page. In practice a signature image is ~36pt tall and
 * never comes close to tripping this; it exists for the pathological case
 * where an embedded image is taller than a whole page.
 */
function fitImageCells(row: LaidOutRow, maxImageHeight: number, lineHeight: number, padding: number): LaidOutRow {
  let scaled = false;
  const cells: LaidOutCell[] = row.cells.map((cell) => {
    if (!isImage(cell) || cell.height <= maxImageHeight) return cell;
    scaled = true;
    const factor = maxImageHeight / cell.height;
    return { image: cell.image, width: cell.width * factor, height: maxImageHeight };
  });
  if (!scaled) return row;

  const textMax = Math.max(
    0,
    ...cells.filter((c): c is string[] => !isImage(c)).map((c) => c.length * lineHeight),
  );
  const imageMax = Math.max(0, ...cells.filter(isImage).map((c) => c.height));
  return { cells, height: Math.max(textMax, imageMax) + 2 * padding };
}

/**
 * Draw a table, breaking pages as needed and repeating the column-header row on
 * every page. Advances `d.y` past the table; `d.page` is left on the last page.
 *
 * Returns where every row actually landed, in input order — фаза 1 needs this
 * to place a signatures-by-row-number block against section А's rows without
 * re-deriving the pagination itself. A row too tall for one page is split at a
 * line boundary (`splitRow`) and carried across a page break; its `PlacedRow`
 * points at where its head landed (see `PlacedRow`). An over-tall image cell
 * cannot be split, so it is scaled down to fit instead (`fitImageCells`).
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

  // Rows carried here as the `tail` from `splitRow` (see below) are
  // continuations of a row that already has its own `placed` entry —
  // recording a second entry for them would make `placed.length` exceed the
  // number of rows the caller passed in.
  const continuations = new Set<LaidOutRow>();

  // Draw one row's cells at the current cursor, advance `d.y` past it, and
  // record where it landed unless it's a continuation (see above).
  // `fitImageCells` scales down an oversized image cell first; a no-op for
  // every row that doesn't have one, including every row `splitRow` ever
  // returns (it refuses to split an image row in the first place).
  const drawRow = (row: LaidOutRow, pageIndex: number, recordEntry: boolean) => {
    // 2*padding, not 1: the row box reserves padding above AND below its
    // content, but the draw call below only subtracts the top one from `d.y`
    // to get the image's own y. Reserving only 1*padding here would still
    // draw the image itself on the page while pushing the row's closing rule
    // (and `d.y`) a padding's-width past MARGIN.
    const maxImageHeight = Math.max(1, d.y - 2 * padding - MARGIN);
    const effective = fitImageCells(row, maxImageHeight, lineHeight, padding);
    effective.cells.forEach((cell, i) => {
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
    if (recordEntry) placed.push({ pageIndex, y: d.y - effective.height, height: effective.height });
    d.y -= effective.height;
    d.page.drawLine({
      start: { x: MARGIN, y: d.y },
      end: { x: MARGIN + totalW, y: d.y },
      thickness: 0.3,
      color: INK,
    });
  };

  // An index-based loop, not `pages.forEach`: `forEach` snapshots the array
  // length before it starts and never visits an index spliced in afterward,
  // so a row too tall for even a fresh page could never carry its tail
  // forward. A plain `for` re-reads `pages.length` every iteration, so a tail
  // spliced in at `pageIndex + 1` is picked up on the very next pass —
  // including a tail still too tall for one page, which splits again the
  // same way.
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    if (pageIndex > 0) newPage(d);
    drawHeader();
    const pageRows = pages[pageIndex];
    for (let i = 0; i < pageRows.length; i++) {
      const row = pageRows[i];
      const recordEntry = !continuations.has(row);
      const availableHeight = d.y - MARGIN;
      const split = splitRow(row, availableHeight, lineHeight, padding);
      if (split) {
        const [head, tail] = split;
        drawRow(head, pageIndex, recordEntry);
        continuations.add(tail);
        // Any not-yet-drawn rows after this one move to the new page too —
        // in practice there never are any, since `paginateRows` only ever
        // admits an over-tall row alone on its page, but carrying them keeps
        // this correct even if that invariant ever changes.
        pages.splice(pageIndex + 1, 0, [tail, ...pageRows.slice(i + 1)]);
        break;
      }
      drawRow(row, pageIndex, recordEntry);
    }
  }

  return placed;
}
