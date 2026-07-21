import { A4_LANDSCAPE, createDoc } from './pdf-kit';
import { Column, layoutTable, paginateRows } from './pdf-table';

const COLS: Column[] = [
  { header: '№', width: 30 },
  { header: 'ПРОИЗВОДИТЕЛ', width: 160 },
  { header: 'ПРОДУКТИ', width: 300 },
];

describe('layoutTable', () => {
  it('wraps each cell inside its own column width', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    const [row] = layoutTable(
      COLS,
      [['1', 'Земеделска кооперация Слънчоглед и партньори ООД', 'Домати 5 кг']],
      d.font, 9, 4,
    );
    expect(row.cells[1].length).toBeGreaterThan(1); // the long name had to wrap
    for (const line of row.cells[1]) {
      expect(d.font.widthOfTextAtSize(line, 9)).toBeLessThanOrEqual(160 - 2 * 4);
    }
  });

  it('sizes the row by its tallest cell, not by the first one', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    const [short, tall] = layoutTable(
      COLS,
      [
        ['1', 'ЕТ Петров', 'Домати'],
        ['2', 'ЕТ Петров', 'Домати 5 кг, Краставици 3 кг, Чушки 2 кг, Патладжан 4 кг, Тиквички 6 кг, Лук 1 кг'],
      ],
      d.font, 9, 4,
    );
    expect(tall.height).toBeGreaterThan(short.height);
    expect(short.height).toBe(1 * (9 + 3) + 2 * 4);
  });

  it('keeps an empty cell as one blank line so the grid stays aligned', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    const [row] = layoutTable(COLS, [['1', '', 'Домати']], d.font, 9, 4);
    expect(row.cells[1]).toEqual(['']);
    expect(row.height).toBe(1 * (9 + 3) + 2 * 4);
  });

  it('pads a short row out to the column count', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    const [row] = layoutTable(COLS, [['1']], d.font, 9, 4);
    expect(row.cells).toHaveLength(3);
    expect(row.cells[2]).toEqual(['']);
  });

  it('produces a finite height when there are no columns, instead of -Infinity', async () => {
    // `columns = []` makes `cells = []`, so `Math.max(...[])` would be `-Infinity`
    // if not guarded. That value then poisons paginateRows' running total forever.
    const d = await createDoc(A4_LANDSCAPE);
    const [row] = layoutTable([], [[]], d.font, 9, 4);
    expect(Number.isFinite(row.height)).toBe(true);
    expect(row.height).not.toBe(-Infinity);
    expect(row.height).toBe(2 * 4); // no cells → 0 lines tall, just the padding
  });
});

const rowsOf = (heights: number[]) => heights.map((h) => ({ cells: [['x']], height: h }));

describe('paginateRows', () => {
  it('keeps everything on one page when it fits', () => {
    const pages = paginateRows(rowsOf([20, 20, 20]), 500, 700, 20);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toHaveLength(3);
  });

  it('breaks to a second page and accounts for the repeated header there', () => {
    // first page: 100 space - 20 header = 80 usable → 4 rows of 20
    const pages = paginateRows(rowsOf(Array(6).fill(20)), 100, 100, 20);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toHaveLength(4);
    expect(pages[1]).toHaveLength(2);
  });

  it('never emits an empty page when a single row is taller than a whole page', () => {
    const pages = paginateRows(rowsOf([500, 20]), 100, 100, 20);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toHaveLength(1); // the oversized row goes alone, not to a blank page
    expect(pages[1]).toHaveLength(1);
  });

  it('returns a single empty page for no rows, so the header still prints', () => {
    expect(paginateRows([], 500, 700, 20)).toEqual([[]]);
  });

  it('switches from firstPageSpace to laterPageSpace after the first break', () => {
    // 10 rows of height 20, headerHeight 20.
    // Page 1 budget = 100 - 20 = 80 → rows 1-4 fill it exactly (used 80);
    // row 5 would make used 100 > 80, so it breaks to a new page.
    // Page 2 budget = 200 - 20 = 180 → the remaining 6 rows (used 120) all fit,
    // so there is no third page.
    // An implementation that never reassigns `budget` away from the first-page
    // value (80) would instead break again after 4 more rows (used 80), landing
    // rows 5-8 on page 2 and rows 9-10 alone on a third page: [4, 4, 2].
    const pages = paginateRows(rowsOf(Array(10).fill(20)), 100, 200, 20);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toHaveLength(4);
    expect(pages[1]).toHaveLength(6);
  });
});
