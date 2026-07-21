import { PDFFont } from 'pdf-lib';
import { wrap } from './pdf-kit';

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
    const tallest = Math.max(...cells.map((c) => c.length));
    return { cells, height: tallest * lineHeight + 2 * padding };
  });
}
