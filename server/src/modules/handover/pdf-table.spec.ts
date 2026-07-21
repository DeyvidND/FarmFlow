import { PDFPage } from 'pdf-lib';
import { A4_LANDSCAPE, createDoc, MARGIN } from './pdf-kit';
import { Column, drawTable, layoutTable, paginateRows } from './pdf-table';

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

describe('drawTable', () => {
  it('advances the cursor down the page', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    const before = d.y;
    drawTable(d, COLS, [['1', 'ЕТ Петров', 'Домати']]);
    expect(d.y).toBeLessThan(before);
  });

  it('adds pages when the rows overflow and never leaves the cursor below the margin', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    const many = Array.from({ length: 60 }, (_, i) => [String(i + 1), `Фермер ${i + 1}`, 'Домати 5 кг']);
    drawTable(d, COLS, many);
    expect(d.doc.getPageCount()).toBeGreaterThan(1);
    expect(d.y).toBeGreaterThanOrEqual(MARGIN);
  });

  it('produces an openable PDF with Cyrillic content', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    drawTable(d, COLS, [['1', 'ЕТ Димка Четова', 'Домати 5 кг, Краставици 3 кг']]);
    const buf = Buffer.from(await d.doc.save());
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(1000);
  });
});

describe('drawTable — what it actually draws', () => {
  // `d.page` is reassigned to a brand-new `PDFPage` instance every time the
  // table breaks to a page (see `newPage` in pdf-kit.ts), so spying on one
  // `d.page` object would go blind after the first break. `drawText` and
  // `drawLine` are ordinary methods on `PDFPage.prototype` (real class-method
  // syntax in pdf-lib's source, not per-instance functions assigned in the
  // constructor), so spying on the prototype once, here, reliably captures
  // every draw call on every page regardless of how many times `d.page` is
  // swapped out. `jest.spyOn` calls through to the real implementation by
  // default, so the PDF bytes produced are unaffected — these are the same
  // PDFs the tests above already validate as openable.
  let drawTextSpy: jest.SpyInstance;
  let drawLineSpy: jest.SpyInstance;
  let drawImageSpy: jest.SpyInstance;

  beforeEach(() => {
    drawTextSpy = jest.spyOn(PDFPage.prototype, 'drawText');
    drawLineSpy = jest.spyOn(PDFPage.prototype, 'drawLine');
    drawImageSpy = jest.spyOn(PDFPage.prototype, 'drawImage');
  });

  afterEach(() => {
    drawTextSpy.mockRestore();
    drawLineSpy.mockRestore();
    drawImageSpy.mockRestore();
  });

  it('never draws below MARGIN when the cursor starts with less than a header row of headroom and there are no rows', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    // headerHeight with the defaults (size 9, padding 4) is (9 + 3) + 2*4 = 20;
    // 70 - MARGIN(55) = 15 < 20. Hand-traced against the unfixed code: it drew
    // the header rule at y = 70 - 20 = 50, five points below MARGIN, and left
    // d.y at 50.
    d.y = 70;

    drawTable(d, COLS, []);

    for (const [, opts] of drawTextSpy.mock.calls) {
      expect(opts.y).toBeGreaterThanOrEqual(MARGIN);
    }
    for (const [opts] of drawLineSpy.mock.calls) {
      expect(opts.start.y).toBeGreaterThanOrEqual(MARGIN);
      expect(opts.end.y).toBeGreaterThanOrEqual(MARGIN);
    }
    expect(d.y).toBeGreaterThanOrEqual(MARGIN);
  });

  it('never draws below MARGIN when the cursor starts with less than a header row of headroom and there are a few rows', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    d.y = 70;

    drawTable(d, COLS, [
      ['1', 'ЕТ Петров', 'Домати'],
      ['2', 'ЕТ Иванов', 'Краставици'],
      ['3', 'ЕТ Георгиев', 'Чушки'],
    ]);

    for (const [, opts] of drawTextSpy.mock.calls) {
      expect(opts.y).toBeGreaterThanOrEqual(MARGIN);
    }
    for (const [opts] of drawLineSpy.mock.calls) {
      expect(opts.start.y).toBeGreaterThanOrEqual(MARGIN);
      expect(opts.end.y).toBeGreaterThanOrEqual(MARGIN);
    }
    expect(d.y).toBeGreaterThanOrEqual(MARGIN);
  });

  it('repeats the column header on every page, not just the first', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    const many = Array.from({ length: 60 }, (_, i) => [String(i + 1), `Фермер ${i + 1}`, 'Домати 5 кг']);

    // Ground truth for how many pages this table needs comes from the same
    // pure functions `drawTable` calls internally (already unit-tested above)
    // rather than a hand-guessed row count — real word-wrapping depends on
    // font metrics this test should not assume. `ensureSpace` is a no-op here
    // (a freshly created doc starts with a full page of headroom), so `d.y`
    // going into `paginateRows` is the same value `drawTable` will use.
    const headerHeight = 9 + 3 + 2 * 4;
    const laid = layoutTable(COLS, many, d.font, 9, 4);
    const expectedPages = paginateRows(laid, d.y - MARGIN, d.size.h - 2 * MARGIN, headerHeight);

    drawTable(d, COLS, many);

    // Every fresh page starts at the same fixed `d.y` (`size.h - MARGIN`), so
    // the header is drawn at the *same coordinates* on every page — distinct
    // y-coordinates cannot tell pages apart here. `mock.instances` gives the
    // actual `this` (the `PDFPage` the call landed on), which is a distinct
    // object per page regardless of coordinate coincidence, so grouping by
    // instance identity is the reliable way to count "how many pages got a
    // header".
    for (const col of COLS) {
      const pagesDrawnOn = new Set(
        drawTextSpy.mock.calls
          .map((call, i) => ({ text: call[0], page: drawTextSpy.mock.instances[i] }))
          .filter((c) => c.text === col.header)
          .map((c) => c.page),
      );
      expect(pagesDrawnOn.size).toBe(expectedPages.length);
    }
  });

  it('never draws below MARGIN across a multi-page table', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    const many = Array.from({ length: 60 }, (_, i) => [String(i + 1), `Фермер ${i + 1}`, 'Домати 5 кг']);

    drawTable(d, COLS, many);

    expect(drawTextSpy.mock.calls.length).toBeGreaterThan(0);
    for (const [, opts] of drawTextSpy.mock.calls) {
      expect(opts.y).toBeGreaterThanOrEqual(MARGIN);
    }
    for (const [opts] of drawLineSpy.mock.calls) {
      expect(opts.start.y).toBeGreaterThanOrEqual(MARGIN);
      expect(opts.end.y).toBeGreaterThanOrEqual(MARGIN);
    }
  });

  it('never draws below MARGIN when the cursor starts just past the header-only threshold and there is one row (d.y = 75)', async () => {
    // headerHeight = (9+3) + 2*4 = 20. The OLD guard was `ensureSpace(d, headerHeight)`,
    // i.e. `ensureSpace(d, 20)`: it breaks only when `d.y - 20 < MARGIN(55)`, i.e. when
    // d.y < 75. At d.y = 75 the old guard sees 75 - 20 = 55 >= 55 and does NOT break,
    // so the header draws fine but the first row is then admitted by `paginateRows`
    // unconditionally and drawn off the page.
    //
    // Hand-traced against the OLD (unfixed) guard:
    //   drawHeader: header text at 75 - 12 + 3 = 66 (>= MARGIN, fine)
    //               d.y -= 20 -> 55; header rule at y = 55 (== MARGIN, fine)
    //   row (1 line): text at 55 - 4 - 1*12 + 3 = 42 (< MARGIN = 55  -- FAILS)
    //                 d.y -= 20 -> 35; row rule at y = 35 (< MARGIN  -- FAILS)
    //
    // The fix reserves headerHeight + the first row's real height (20 + 20 = 40).
    // 75 - 40 = 35 < 55, so the fixed guard DOES break to a fresh page here, and
    // every coordinate above lands well clear of MARGIN instead.
    const d = await createDoc(A4_LANDSCAPE);
    d.y = 75;

    drawTable(d, COLS, [['1', 'X', 'Y']]);

    for (const [, opts] of drawTextSpy.mock.calls) {
      expect(opts.y).toBeGreaterThanOrEqual(MARGIN);
    }
    for (const [opts] of drawLineSpy.mock.calls) {
      expect(opts.start.y).toBeGreaterThanOrEqual(MARGIN);
      expect(opts.end.y).toBeGreaterThanOrEqual(MARGIN);
    }
    expect(d.y).toBeGreaterThanOrEqual(MARGIN);
  });

  it('never draws below MARGIN one point further into the band (d.y = 76)', async () => {
    // Same band as d.y = 75 above; one point higher to cover the rest of the
    // gap the previous fix left open. Hand-traced against the OLD guard:
    //   old guard: 76 - 20 = 56 >= 55 -> no break.
    //   drawHeader: header text at 76 - 12 + 3 = 67 (fine); d.y -= 20 -> 56;
    //               header rule at y = 56 (fine).
    //   row (1 line): text at 56 - 4 - 12 + 3 = 43 (< MARGIN -- FAILS)
    //                 d.y -= 20 -> 36; row rule at y = 36 (< MARGIN -- FAILS)
    // Fixed guard: needed = 20 + 20 = 40; 76 - 40 = 36 < 55 -> breaks to a new
    // page, so nothing draws below MARGIN.
    const d = await createDoc(A4_LANDSCAPE);
    d.y = 76;

    drawTable(d, COLS, [['1', 'X', 'Y']]);

    for (const [, opts] of drawTextSpy.mock.calls) {
      expect(opts.y).toBeGreaterThanOrEqual(MARGIN);
    }
    for (const [opts] of drawLineSpy.mock.calls) {
      expect(opts.start.y).toBeGreaterThanOrEqual(MARGIN);
      expect(opts.end.y).toBeGreaterThanOrEqual(MARGIN);
    }
    expect(d.y).toBeGreaterThanOrEqual(MARGIN);
  });

  it('still forces a break at a cursor a short first row would find safe, when the first row is tall — proves the guard reserves the row\'s real height, not a fixed amount', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    const headerHeight = 9 + 3 + 2 * 4; // 20, same derivation drawTable uses internally
    // Same long producer name the very first `layoutTable` test in this file
    // uses to prove wrapping at column width 160 — already established there
    // (`row.cells[1].length).toBeGreaterThan(1)`) to wrap to more than one
    // line, so its height is strictly greater than `headerHeight` (a 1-line row).
    const tallRow = ['1', 'Земеделска кооперация Слънчоглед и партньори ООД', 'Домати'];
    const [laidTall] = layoutTable(COLS, [tallRow], d.font, 9, 4);
    expect(laidTall.height).toBeGreaterThan(headerHeight);

    // MARGIN + 2*headerHeight = 55 + 40 = 95. If a first row's height equals
    // headerHeight (20, the "short row" case already covered above), this is
    // exactly the cursor where the fix's guard stops breaking: needed = 20 + 20
    // = 40, and 95 - 40 = 55 >= MARGIN. A guard that reserved a fixed
    // `2 * headerHeight` regardless of the row's real height would treat this
    // starting point as "safe" for ANY first row — including this taller one.
    // The correct guard reserves headerHeight + the row's *actual* height, so
    // for this taller row it must still break here.
    d.y = MARGIN + 2 * headerHeight; // 95

    drawTable(d, COLS, [tallRow]);

    for (const [, opts] of drawTextSpy.mock.calls) {
      expect(opts.y).toBeGreaterThanOrEqual(MARGIN);
    }
    for (const [opts] of drawLineSpy.mock.calls) {
      expect(opts.start.y).toBeGreaterThanOrEqual(MARGIN);
      expect(opts.end.y).toBeGreaterThanOrEqual(MARGIN);
    }
    expect(d.y).toBeGreaterThanOrEqual(MARGIN);
  });

  it("positions each cell's text at MARGIN plus the preceding column widths plus padding", async () => {
    const d = await createDoc(A4_LANDSCAPE);
    // A single, deliberately short row — already established elsewhere in
    // this file (the "sizes the row by its tallest cell" test) to lay out at
    // exactly one line per cell, so each cell's text is drawn exactly once.
    drawTable(d, COLS, [['1', 'ЕТ Петров', 'Домати']]);

    // xOf(i) = MARGIN + sum of the preceding columns' widths; cell text is
    // drawn at xOf(i) + padding(4). Column widths are 30, 160, 300.
    const expected: [string, number][] = [
      ['1', MARGIN + 4], // column 0, no preceding columns: 55 + 4 = 59
      ['ЕТ Петров', MARGIN + 30 + 4], // column 1, preceded by width 30: 55 + 30 + 4 = 89
      ['Домати', MARGIN + 30 + 160 + 4], // column 2, preceded by 30 + 160: 55 + 190 + 4 = 249
    ];

    for (const [text, x] of expected) {
      const calls = drawTextSpy.mock.calls.filter(([t]) => t === text);
      expect(calls).toHaveLength(1);
      expect(calls[0][1].x).toBe(x);
    }
  });

  it('keeps later-page rows above MARGIN when an onNewPage hook eats the top of the page', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    d.reservedTopOnNewPage = 80;
    d.onNewPage = (doc) => { doc.y -= 80; };
    const many = Array.from({ length: 60 }, (_, i) => [String(i + 1), `Фермер ${i + 1}`, 'Домати 5 кг']);
    drawTable(d, COLS, many);
    expect(d.doc.getPageCount()).toBeGreaterThan(1);
    const ys = [
      ...drawTextSpy.mock.calls.map((c) => c[1].y),
      ...drawLineSpy.mock.calls.flatMap((c) => [c[0].start.y, c[0].end.y]),
    ];
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(MARGIN);
  });

  const tinyPng = async (d: Awaited<ReturnType<typeof createDoc>>) => {
    // 1x1 opaque black PNG
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    return d.doc.embedPng(Buffer.from(b64, 'base64'));
  };

  it('sizes a row by its image when the image is taller than the text', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    const img = await tinyPng(d);
    const rows = layoutTable(COLS, [['1', 'ЕТ Петров', { image: img, width: 80, height: 40 }]], d.font, 9, 4);
    expect(rows[0].height).toBe(40 + 2 * 4);
  });

  it('draws the image inside its own column, not at the page origin', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    const img = await tinyPng(d);
    drawTable(d, COLS, [['1', 'ЕТ Петров', { image: img, width: 80, height: 40 }]]);
    expect(drawImageSpy).toHaveBeenCalledTimes(1);
    const [, opts] = drawImageSpy.mock.calls[0];
    expect(opts.x).toBe(MARGIN + COLS[0].width + COLS[1].width + 4);
    expect(opts.width).toBe(80);
    expect(opts.height).toBe(40);
    expect(opts.y).toBeGreaterThanOrEqual(MARGIN);
  });

  it('returns where every row landed, in input order, across a page break', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    const many = Array.from({ length: 60 }, (_, i) => [String(i + 1), `Фермер ${i + 1}`, 'Домати 5 кг']);
    const placed = drawTable(d, COLS, many);
    expect(placed).toHaveLength(60);
    expect(placed[0].pageIndex).toBe(0);
    expect(placed[59].pageIndex).toBeGreaterThan(0);
    // Within one page, each row sits below the previous one.
    const firstPage = placed.filter((p) => p.pageIndex === 0);
    for (let i = 1; i < firstPage.length; i++) {
      expect(firstPage[i].y).toBeLessThan(firstPage[i - 1].y);
    }
    for (const p of placed) expect(p.y).toBeGreaterThanOrEqual(MARGIN);
  });

  it('still accepts plain string rows unchanged', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    const placed = drawTable(d, COLS, [['1', 'ЕТ Петров', 'Домати']]);
    expect(placed).toHaveLength(1);
    expect(drawImageSpy).not.toHaveBeenCalled();
  });
});
