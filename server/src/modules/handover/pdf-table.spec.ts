import { A4_LANDSCAPE, createDoc } from './pdf-kit';
import { Column, layoutTable } from './pdf-table';

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
});
