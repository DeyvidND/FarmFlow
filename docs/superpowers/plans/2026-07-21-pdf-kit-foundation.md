# PDF-kit foundation (фаза 0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared PDF layer — a brand block, a real table primitive and page-breaking — and retrofit the existing bilateral protocol onto it, so the consolidated protocol (фаза 1) and the emailed protocol (фаза 2) start from one visual foundation instead of diverging.

**Architecture:** A new `pdf-kit.ts` owns the font, the page geometry and a mutable draw context (`Doc`) that carries the current page and cursor, so a page break is a function call instead of a rewrite. Table layout is split into two **pure** functions — `layoutTable` (wrapping + row heights) and `paginateRows` (which rows land on which page) — so the hard maths is unit-tested directly rather than by parsing PDF bytes. `handover-pdf.ts` keeps its public exports and delegates.

**Tech Stack:** NestJS, TypeScript, `pdf-lib` + `@pdf-lib/fontkit` (already installed), jest.

## Global Constraints

- Node ≥20, pnpm@9.12 workspace. Server tests: `pnpm --filter @fermeribg/api test`.
- **No new npm dependencies.** `pdf-lib` and `@pdf-lib/fontkit` are already present.
- **No new font asset.** Only `server/src/assets/fonts/DejaVuSans.ttf` exists (regular). Bold stays emulated, behind the single `drawBoldText` seam — see Task 1. Do not download a font file.
- All dates go through `bgDateOf` (`server/src/common/time/bg-time`). **Never** use `Date`'s local getters: prod runs UTC, dev machines run Europe/Sofia, and the suite runs UTC via `test/set-tz.ts`.
- `handover-pdf.ts` must keep exporting `PAGE_W`, `PAGE_H`, `MARGIN`, `CONTENT_W`, `wrap`, `composeProtocol`, `renderProtocolPdf` — `handover-pdf.spec.ts` imports them and must stay green untouched.
- Bulgarian is the UI/document language. Keep existing wording verbatim unless a task says otherwise.

---

### Task 1: `pdf-kit.ts` — font, geometry, draw context, page breaks

**Files:**
- Create: `server/src/modules/handover/pdf-kit.ts`
- Create: `server/src/modules/handover/pdf-kit.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `A4_PORTRAIT`, `A4_LANDSCAPE`: `{ w: number; h: number }`
  - `MARGIN: number`, `INK: RGB`
  - `interface Doc { doc: PDFDocument; font: PDFFont; size: { w: number; h: number }; page: PDFPage; y: number }`
  - `createDoc(size: { w: number; h: number }): Promise<Doc>`
  - `contentW(d: Doc): number`
  - `newPage(d: Doc): void`
  - `ensureSpace(d: Doc, needed: number): boolean` — returns `true` if it broke to a new page
  - `drawBoldText(d: Doc, text: string, x: number, y: number, size: number): void`
  - `wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[]`
  - `dateBg(d: Date): string`

- [ ] **Step 1: Write the failing test**

Create `server/src/modules/handover/pdf-kit.spec.ts`:

```ts
import { A4_LANDSCAPE, A4_PORTRAIT, contentW, createDoc, dateBg, ensureSpace, MARGIN, newPage, wrap } from './pdf-kit';

describe('pdf-kit geometry', () => {
  it('exposes A4 both ways round', () => {
    expect(A4_PORTRAIT).toEqual({ w: 595, h: 842 });
    expect(A4_LANDSCAPE).toEqual({ w: 842, h: 595 });
  });

  it('content width follows the page size, not a hardcoded constant', async () => {
    const p = await createDoc(A4_PORTRAIT);
    const l = await createDoc(A4_LANDSCAPE);
    expect(contentW(p)).toBe(595 - 2 * MARGIN);
    expect(contentW(l)).toBe(842 - 2 * MARGIN);
  });
});

describe('pdf-kit page breaks', () => {
  it('newPage resets the cursor to the top of a fresh page', async () => {
    const d = await createDoc(A4_PORTRAIT);
    d.y = 100;
    newPage(d);
    expect(d.y).toBe(A4_PORTRAIT.h - MARGIN);
    expect(d.doc.getPageCount()).toBe(2);
  });

  it('ensureSpace breaks only when the block does not fit', async () => {
    const d = await createDoc(A4_PORTRAIT);
    d.y = 400;
    expect(ensureSpace(d, 100)).toBe(false);
    expect(d.doc.getPageCount()).toBe(1);

    d.y = MARGIN + 10; // almost at the foot
    expect(ensureSpace(d, 100)).toBe(true);
    expect(d.doc.getPageCount()).toBe(2);
    expect(d.y).toBe(A4_PORTRAIT.h - MARGIN);
  });
});

describe('wrap', () => {
  it('never emits a line wider than the limit', async () => {
    const d = await createDoc(A4_PORTRAIT);
    const long = '„Земеделска кооперация Слънчоглед и партньори" ООД, гр. Русе, бул. Липник 123, ет. 4';
    for (const line of wrap(long, d.font, 11, 200)) {
      expect(d.font.widthOfTextAtSize(line, 11)).toBeLessThanOrEqual(200);
    }
  });

  it('keeps a single unbreakable word rather than dropping it', async () => {
    const d = await createDoc(A4_PORTRAIT);
    expect(wrap('Свръхдългодумабезинтервали', d.font, 11, 10)).toEqual(['Свръхдългодумабезинтервали']);
  });
});

describe('dateBg', () => {
  it('dates in Europe/Sofia even though the suite runs UTC', () => {
    // 22:30Z on the 16th is 01:30 on the 17th in Sofia (EEST, UTC+3).
    expect(dateBg(new Date('2026-07-16T22:30:00Z'))).toBe('17.07.2026 г.');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- pdf-kit`
Expected: FAIL — `Cannot find module './pdf-kit'`

- [ ] **Step 3: Write the implementation**

Create `server/src/modules/handover/pdf-kit.ts`:

```ts
import { PDFDocument, PDFFont, PDFPage, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFileSync } from 'fs';
import { join } from 'path';
import { bgDateOf } from '../../common/time/bg-time';

/** Read once at module load — the same file the bilateral renderer has always used. */
const FONT_REGULAR = readFileSync(join(__dirname, '..', '..', 'assets', 'fonts', 'DejaVuSans.ttf'));

export const A4_PORTRAIT = { w: 595, h: 842 };
export const A4_LANDSCAPE = { w: 842, h: 595 };
export const MARGIN = 55;
export const INK = rgb(0.11, 0.1, 0.09);

/**
 * Mutable draw context. `page` and `y` change as content flows, so a page break
 * is `newPage(d)` rather than threading a new cursor through every helper.
 */
export interface Doc {
  doc: PDFDocument;
  font: PDFFont;
  size: { w: number; h: number };
  page: PDFPage;
  y: number;
}

export async function createDoc(size: { w: number; h: number }): Promise<Doc> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(FONT_REGULAR);
  const page = doc.addPage([size.w, size.h]);
  return { doc, font, size, page, y: size.h - MARGIN };
}

export function contentW(d: Doc): number {
  return d.size.w - 2 * MARGIN;
}

export function newPage(d: Doc): void {
  d.page = d.doc.addPage([d.size.w, d.size.h]);
  d.y = d.size.h - MARGIN;
}

/**
 * Break to a new page when `needed` points would run past the bottom margin.
 * Returns whether it broke, so callers can redraw a table's header row.
 */
export function ensureSpace(d: Doc, needed: number): boolean {
  if (d.y - needed >= MARGIN) return false;
  newPage(d);
  return true;
}

/**
 * Emulated bold: the asset set has only DejaVuSans regular, so weight is faked
 * by overdrawing with a small horizontal offset. Two offsets rather than the
 * single 0.4 the bilateral renderer used — at 9pt table-header sizes one pass
 * is almost invisible.
 *
 * THIS IS THE SEAM. If DejaVuSans-Bold.ttf is ever added to assets/fonts,
 * embed it in `createDoc` as `fontBold` and make this one call to drawText —
 * no other file needs to change.
 */
export function drawBoldText(d: Doc, text: string, x: number, y: number, size: number): void {
  for (const dx of [0, 0.25, 0.5]) {
    d.page.drawText(text, { x: x + dx, y, size, font: d.font, color: INK });
  }
}

/** Greedy word-wrap: split `text` into lines no wider than `maxWidth` at `size`. */
export function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= maxWidth || !line) {
      line = next;
    } else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Bulgarian short date in Europe/Sofia, e.g. "16.07.2026 г."
 *
 * Goes through bgDateOf rather than Date's local getters: no TZ is set in the
 * Dockerfile or compose, so prod runs UTC while dev machines here run
 * Europe/Sofia — a local-getter bug is right locally and wrong in prod.
 */
export function dateBg(d: Date): string {
  const [year, month, day] = bgDateOf(d).split('-');
  return `${day}.${month}.${year} г.`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/api test -- pdf-kit`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/handover/pdf-kit.ts server/src/modules/handover/pdf-kit.spec.ts
git commit -m "feat(pdf): shared draw context with real page breaks

The bilateral renderer calls addPage exactly once and lets content fall off
the bottom. A mutable Doc context makes a page break a function call, which
is what the consolidated protocol's 24-row tables need."
```

---

### Task 2: `layoutTable` — pure cell wrapping and row heights

**Files:**
- Create: `server/src/modules/handover/pdf-table.ts`
- Create: `server/src/modules/handover/pdf-table.spec.ts`

**Interfaces:**
- Consumes: `wrap`, `Doc` from `./pdf-kit` (Task 1).
- Produces:
  - `interface Column { header: string; width: number; align?: 'left' | 'right' }`
  - `interface LaidOutRow { cells: string[][]; height: number }`
  - `layoutTable(columns: Column[], rows: string[][], font: PDFFont, size: number, padding: number): LaidOutRow[]`

Row height is `lineCount * lineHeight + 2 * padding`, where `lineHeight = size + 3` and `lineCount` is the tallest cell in that row.

- [ ] **Step 1: Write the failing test**

Create `server/src/modules/handover/pdf-table.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- pdf-table`
Expected: FAIL — `Cannot find module './pdf-table'`

- [ ] **Step 3: Write the implementation**

Create `server/src/modules/handover/pdf-table.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/api test -- pdf-table`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/handover/pdf-table.ts server/src/modules/handover/pdf-table.spec.ts
git commit -m "feat(pdf): pure table layout — cell wrapping and row heights

Split from drawing so the layout maths is asserted directly. The renderer has
had no cell or column concept at all until now."
```

---

### Task 3: `paginateRows` — which rows land on which page

**Files:**
- Modify: `server/src/modules/handover/pdf-table.ts`
- Modify: `server/src/modules/handover/pdf-table.spec.ts`

**Interfaces:**
- Consumes: `LaidOutRow` (Task 2).
- Produces: `paginateRows(rows: LaidOutRow[], firstPageSpace: number, laterPageSpace: number, headerHeight: number): LaidOutRow[][]`

The first page has less room (a document header sits above the table); later pages only lose the repeated column-header row.

- [ ] **Step 1: Write the failing test**

Append to `server/src/modules/handover/pdf-table.spec.ts`:

**Extend the existing import** to
`import { Column, layoutTable, paginateRows } from './pdf-table';` — do not add a
second import statement from the same module. Then append:

```ts
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- pdf-table`
Expected: FAIL — `paginateRows is not a function`

- [ ] **Step 3: Write the implementation**

Append to `server/src/modules/handover/pdf-table.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/api test -- pdf-table`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/handover/pdf-table.ts server/src/modules/handover/pdf-table.spec.ts
git commit -m "feat(pdf): paginate table rows, repeating the column header

An oversized row is emitted alone rather than pushed forward forever."
```

---

### Task 4: `drawTable` — wire layout + pagination into actual drawing

**Files:**
- Modify: `server/src/modules/handover/pdf-table.ts`
- Modify: `server/src/modules/handover/pdf-table.spec.ts`

**Interfaces:**
- Consumes: `Doc`, `MARGIN`, `INK`, `drawBoldText` (Task 1); `layoutTable`, `paginateRows` (Tasks 2–3).
- Produces: `drawTable(d: Doc, columns: Column[], rows: string[][], opts?: { size?: number; padding?: number }): void` — advances `d.y` past the table and leaves `d.page` on the last page used.

- [ ] **Step 1: Write the failing test**

Append to `server/src/modules/handover/pdf-table.spec.ts`:

**Extend the two existing imports** to
`import { A4_LANDSCAPE, createDoc, MARGIN } from './pdf-kit';` and
`import { Column, drawTable, layoutTable, paginateRows } from './pdf-table';` —
do not add second import statements from modules already imported. Then append:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- pdf-table`
Expected: FAIL — `drawTable is not a function`

- [ ] **Step 3: Write the implementation**

Append to `server/src/modules/handover/pdf-table.ts`:

```ts
import { Doc, drawBoldText, INK, MARGIN, newPage } from './pdf-kit';

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

  const laid = layoutTable(columns, rows, d.font, size, padding);
  const pages = paginateRows(laid, d.y - MARGIN, d.size.h - 2 * MARGIN, headerHeight);

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/api test -- pdf-table`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/handover/pdf-table.ts server/src/modules/handover/pdf-table.spec.ts
git commit -m "feat(pdf): draw tables with page breaks and a repeated column header"
```

---

### Task 5: Shared brand block — `drawDocumentHeader` / `drawDocumentFooter`

**Files:**
- Modify: `server/src/modules/handover/pdf-kit.ts`
- Modify: `server/src/modules/handover/pdf-kit.spec.ts`

**Interfaces:**
- Consumes: `Doc`, `drawBoldText`, `dateBg`, `contentW` (Task 1).
- Produces:
  - `interface DocHeader { brand: string; title: string; subtitle?: string | null; number?: string | null; date?: Date | null }`
  - `drawDocumentHeader(d: Doc, h: DocHeader): void`
  - `drawDocumentFooter(d: Doc, text: string): void`

This is the single place that makes both documents look like ours. Change it once, both change.

- [ ] **Step 1: Write the failing test**

Append to `server/src/modules/handover/pdf-kit.spec.ts`:

```ts
import { drawDocumentFooter, drawDocumentHeader } from './pdf-kit';

describe('shared brand block', () => {
  it('consumes vertical space and leaves the cursor below itself', async () => {
    const d = await createDoc(A4_PORTRAIT);
    const before = d.y;
    drawDocumentHeader(d, { brand: 'ФермериБГ', title: 'ОБОБЩЕН ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ', number: 'ОБ-7', date: new Date('2026-07-21T06:00:00Z') });
    expect(d.y).toBeLessThan(before);
    expect(d.y).toBeGreaterThan(MARGIN);
  });

  it('takes the same vertical space on both page sizes, so the two documents line up', async () => {
    const header = { brand: 'ФермериБГ', title: 'ПРОТОКОЛ', number: '7', date: new Date('2026-07-21T06:00:00Z') };

    const p = await createDoc(A4_PORTRAIT);
    const startP = p.y;
    drawDocumentHeader(p, header);
    const usedP = startP - p.y;

    const l = await createDoc(A4_LANDSCAPE);
    const startL = l.y;
    drawDocumentHeader(l, header);
    const usedL = startL - l.y;

    expect(usedP).toBe(usedL);
  });

  it('omits the number line entirely when there is no number (unsaved preview)', async () => {
    const withNo = await createDoc(A4_PORTRAIT);
    const withYes = await createDoc(A4_PORTRAIT);
    const base = { brand: 'ФермериБГ', title: 'ПРОТОКОЛ', date: new Date('2026-07-21T06:00:00Z') };
    drawDocumentHeader(withNo, { ...base, number: null });
    drawDocumentHeader(withYes, { ...base, number: '7' });
    expect(withNo.y).toBeGreaterThan(withYes.y); // no number → less space used
  });

  it('footer sits at the foot, not at the cursor', async () => {
    const d = await createDoc(A4_PORTRAIT);
    d.y = 400;
    drawDocumentFooter(d, 'Съставен в два еднообразни екземпляра.');
    expect(d.y).toBe(400); // footer must not move the cursor
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- pdf-kit`
Expected: FAIL — `drawDocumentHeader is not a function`

- [ ] **Step 3: Write the implementation**

Append to `server/src/modules/handover/pdf-kit.ts`:

```ts
export interface DocHeader {
  brand: string;
  title: string;
  subtitle?: string | null;
  number?: string | null;
  date?: Date | null;
}

/**
 * The one block that makes every document of ours look like ours: brand line,
 * rule, centred title, optional subtitle, then № and date on one row.
 *
 * Deliberately size-independent — it consumes the same vertical space on A4
 * portrait and landscape, so the bilateral protocol and the consolidated one
 * line up despite different page shapes.
 */
export function drawDocumentHeader(d: Doc, h: DocHeader): void {
  const w = contentW(d);
  const centre = (text: string, size: number, bold: boolean) => {
    const x = MARGIN + (w - d.font.widthOfTextAtSize(text, size)) / 2;
    if (bold) drawBoldText(d, text, x, d.y, size);
    else d.page.drawText(text, { x, y: d.y, size, font: d.font, color: INK });
  };

  // Brand line, left, small caps-ish.
  drawBoldText(d, h.brand, MARGIN, d.y, 10);
  d.y -= 6;
  d.page.drawLine({
    start: { x: MARGIN, y: d.y },
    end: { x: MARGIN + w, y: d.y },
    thickness: 1.2,
    color: INK,
  });
  d.y -= 22;

  centre(h.title, 14, true);
  d.y -= 18;

  if (h.subtitle) {
    centre(h.subtitle, 9, false);
    d.y -= 13;
  }

  const left = h.number ? `№ ${h.number}` : '';
  const right = h.date ? dateBg(h.date) : '';
  if (left || right) {
    if (left) d.page.drawText(left, { x: MARGIN, y: d.y, size: 10, font: d.font, color: INK });
    if (right) {
      const rw = d.font.widthOfTextAtSize(right, 10);
      d.page.drawText(right, { x: MARGIN + w - rw, y: d.y, size: 10, font: d.font, color: INK });
    }
    d.y -= 18;
  }
}

/**
 * Footer pinned to the foot of the CURRENT page. Does not move the cursor —
 * callers keep laying out body content after calling it.
 */
export function drawDocumentFooter(d: Doc, text: string): void {
  const w = contentW(d);
  const size = 8;
  const x = MARGIN + (w - d.font.widthOfTextAtSize(text, size)) / 2;
  d.page.drawText(text, { x, y: MARGIN - 18, size, font: d.font, color: INK });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/api test -- pdf-kit`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/handover/pdf-kit.ts server/src/modules/handover/pdf-kit.spec.ts
git commit -m "feat(pdf): one shared brand block for every document we issue

Size-independent on purpose: the bilateral protocol is portrait and the
consolidated one is landscape, and they still have to look related."
```

---

### Task 6: Retrofit the bilateral protocol onto pdf-kit

**Files:**
- Modify: `server/src/modules/handover/handover-pdf.ts` (whole render path; keep every current export)
- Modify: `server/src/modules/handover/handover-pdf.spec.ts` (add regression tests only — do not change existing ones)

**Interfaces:**
- Consumes: everything from Tasks 1 and 5.
- Produces: no new exports. `renderProtocolPdf(row)` keeps its signature and gains page-breaking plus the brand header.

The existing `handover-pdf.spec.ts` must stay green **without edits** — that is the proof the retrofit did not change behaviour that mattered.

- [ ] **Step 1: Write the failing regression test**

Append to `server/src/modules/handover/handover-pdf.spec.ts`:

```ts
describe('renderProtocolPdf — overflow (regression)', () => {
  const bigRow = (n: number) => ({
    ...ROW,
    items: Array.from({ length: n }, (_, i) => ({
      productName: `Продукт с доста дълго име номер ${i + 1}`,
      quantity: i + 1,
      unit: 'кг',
    })),
  });

  it('adds pages instead of dropping items off the bottom', async () => {
    const buf = await renderProtocolPdf(bigRow(80) as any);
    expect(isPdf(buf)).toBe(true);
    const doc = await PDFDocument.load(buf);
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });

  it('still fits a small protocol on a single page', async () => {
    const doc = await PDFDocument.load(await renderProtocolPdf(bigRow(3) as any));
    expect(doc.getPageCount()).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- handover-pdf`
Expected: FAIL on the first new test — `expect(1).toBeGreaterThan(1)`, because `addPage` is called exactly once today.

- [ ] **Step 3: Rewrite the render path onto pdf-kit**

In `server/src/modules/handover/handover-pdf.ts`:

Replace the imports and constants at the top (lines 1–16) with:

> **Note:** after this rewrite `handover-pdf.ts` no longer references any
> `pdf-lib` type directly (`drawParty` and `sigBlock` take `Doc` instead of
> `PDFPage`/`PDFFont`), and `bgDateOf` is gone with the local `dateBg`. Both
> imports must be **deleted**, not left behind — the build treats unused imports
> as errors.

```ts
import { cityFromAddress } from './handover-city';
import {
  A4_PORTRAIT,
  Doc,
  MARGIN,
  INK,
  contentW,
  createDoc,
  dateBg,
  drawBoldText,
  drawDocumentFooter,
  drawDocumentHeader,
  ensureSpace,
  wrap,
} from './pdf-kit';

// Re-exported for back-compat: handover-pdf.spec.ts and callers import these
// from here. Geometry now lives in pdf-kit so both renderers share it.
export const PAGE_W = A4_PORTRAIT.w;
export const PAGE_H = A4_PORTRAIT.h;
export { MARGIN, wrap };
export const CONTENT_W = PAGE_W - 2 * MARGIN;

const BODY_SIZE = 11;
const BODY_LH = BODY_SIZE + 5;
```

Delete the now-duplicated local `dateBg` (old lines 18–30) and local `wrap` (old lines 32–48) — both come from `pdf-kit`.

Replace `renderProtocolPdf` (old lines 154–226) with:

```ts
export async function renderProtocolPdf(row: any): Promise<Buffer> {
  const d = await createDoc(A4_PORTRAIT);
  const t = composeProtocol(row);
  const operatorSnap = row.kind === 'operator_to_customer' ? row.fromSnapshot : row.toSnapshot;

  drawDocumentHeader(d, {
    brand: String(operatorSnap?.name ?? 'ФермериБГ'),
    title: t.title,
    number: row.protocolNumber != null ? String(row.protocolNumber) : null,
    date: new Date(row.signedAt ?? row.createdAt ?? Date.now()),
  });

  const drawLeft = (text: string, x: number, size = BODY_SIZE, lh = BODY_LH) => {
    for (const l of wrap(text, d.font, size, contentW(d) - (x - MARGIN))) {
      ensureSpace(d, lh);
      d.page.drawText(l, { x, y: d.y, size, font: d.font, color: INK });
      d.y -= lh;
    }
  };

  drawLeft(t.opening, MARGIN);
  d.y -= 10;

  drawParty(d, MARGIN, t.from);
  d.y -= 6;
  ensureSpace(d, 18);
  const iW = d.font.widthOfTextAtSize('и', 12);
  d.page.drawText('и', { x: MARGIN + (contentW(d) - iW) / 2, y: d.y, size: 12, font: d.font, color: INK });
  d.y -= 18;
  drawParty(d, MARGIN, t.to);
  d.y -= 4;

  drawLeft(t.intro, MARGIN);
  d.y -= 10;

  const itemX = MARGIN + 6;
  for (const line of t.itemLines) drawLeft(line, itemX);

  const dot = d.font.widthOfTextAtSize('.', BODY_SIZE);
  for (let k = 0; k < 2; k++) {
    const prefix = `${t.itemLines.length + 1 + k}. `;
    const room = contentW(d) - 6 - d.font.widthOfTextAtSize(prefix, BODY_SIZE);
    ensureSpace(d, BODY_LH);
    d.page.drawText(prefix + '.'.repeat(Math.max(0, Math.floor(room / dot))), {
      x: itemX, y: d.y, size: BODY_SIZE, font: d.font, color: INK,
    });
    d.y -= BODY_LH;
  }
  d.y -= 12;

  drawLeft(t.footer, MARGIN, 10, 15);

  // Signature blocks need ~90pt; break rather than overlap the item list — the
  // old code clamped them to y=150 and let long lists run straight through them.
  ensureSpace(d, 90);
  const sigY = d.y - 20;
  await sigBlock(d, MARGIN, sigY, 'ПРЕДАЛ', t.fromName, row.fromSignaturePng);
  await sigBlock(d, PAGE_W / 2 + 10, sigY, 'ПРИЕЛ', t.toName, row.toSignaturePng);
  d.y = sigY - 40;

  drawDocumentFooter(d, 'Документът е издаден електронно от ФермериБГ.');

  return Buffer.from(await d.doc.save());
}
```

Replace `drawParty` (old lines 234–253) with a `Doc`-based version:

```ts
function drawParty(d: Doc, x: number, p: PartyText): void {
  const line = (text: string, size = BODY_SIZE, bold = false) => {
    ensureSpace(d, BODY_LH);
    if (bold) drawBoldText(d, text, x, d.y, size);
    else d.page.drawText(text, { x, y: d.y, size, font: d.font, color: INK });
    d.y -= BODY_LH;
  };
  line(p.role, BODY_SIZE, true);
  line(p.name, BODY_SIZE, true);
  if (p.idLine) line(p.idLine);
  if (p.address) for (const l of wrap(`адрес: ${p.address}`, d.font, BODY_SIZE, contentW(d))) line(l);
  const contact = [p.phone && `тел.: ${p.phone}`, p.email && `e-mail: ${p.email}`].filter(Boolean).join('   ');
  if (contact) line(contact);
}
```

Replace `sigBlock` (old lines 255–279) with:

```ts
async function sigBlock(
  d: Doc,
  x: number,
  y: number,
  label: string,
  name: string | null | undefined,
  png: string | null,
) {
  const nameX = x + d.font.widthOfTextAtSize(`${label}: `, 10);
  d.page.drawText(`${label}: ______________________`, { x, y, size: 10, font: d.font, color: INK });
  if (name) {
    d.page.drawText(`/${String(name)}/`, { x: nameX, y: y - 13, size: 9, font: d.font, color: INK });
  }
  if (png) {
    try {
      const bytes = Buffer.from(png.split(',').pop()!, 'base64');
      const img = await d.doc.embedPng(bytes);
      d.page.drawImage(img, { x: nameX, y: y + 4, width: 110, height: 36 });
    } catch {
      // Malformed/corrupt signature data — fall back to the blank line drawn above.
    }
  }
}
```

Leave `composeProtocol`, `idLineOf`, `partyText`, `orderNumbersFragment`, `PartyText` and `ProtocolText` exactly as they are — they are pure text and already tested.

- [ ] **Step 4: Run the whole handover suite**

Run: `pnpm --filter @fermeribg/api test -- handover`
Expected: PASS — the 17 pre-existing `handover-pdf` tests **unchanged and green**, plus the 2 new overflow tests.

If a pre-existing test fails, the retrofit changed behaviour it should not have. Fix the retrofit, not the test.

- [ ] **Step 5: Run the full server suite for collateral damage**

Run: `pnpm --filter @fermeribg/api test`
Expected: PASS, no new failures. `handover.service.spec.ts` renders PDFs through this path.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/handover/handover-pdf.ts server/src/modules/handover/handover-pdf.spec.ts
git commit -m "fix(pdf): the bilateral protocol no longer drops content off the page

addPage was called exactly once and y was allowed to go negative, so a long
protocol silently lost its tail and ran through the signature blocks. Now on
the shared pdf-kit: real page breaks plus the common brand header.

Every pre-existing handover-pdf test is unchanged and still green."
```

---

## Self-review

**Spec coverage (фаза 0 rows of §8):** `pdf-kit.ts` shared brand block → Task 5. Table primitive → Tasks 2–4. Pagination of the existing bilateral protocol → Task 6. Bold font → **deviation, see below**.

**Deviation from spec §3.4.** The spec says to add `DejaVuSans-Bold.ttf`. That file is not in the repo and obtaining it means downloading a binary from outside — a decision for the repo owner, not something to do silently mid-plan. Task 1 instead isolates weight behind `drawBoldText` and improves the emulation. Dropping the real font in later is a two-line change inside `createDoc` and `drawBoldText`, with no other file touched.

**Out of scope for фаза 0 (belongs to later plans):** the consolidated protocol entity, migration, live view, freeze and edit UI (фаза 1); email attachments and the reordered confirm (фаза 2); farmer readiness, list polish and the `orderIds` fix (фаза 3).
