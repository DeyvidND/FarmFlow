# PDF-kit foundation, part 2 (фаза 0 довършване) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five gaps the final whole-branch review found between the shared PDF layer and what the consolidated protocol (фаза 1) actually needs — so фаза 1 builds a new file instead of reopening the shared foundation while a second document already sits on it.

**Architecture:** Part 1 built a mutable draw context (`pdf-kit.ts`) and a table primitive split into pure layout + drawing (`pdf-table.ts`). This part adds the four things the review proved missing: per-page document furniture, image cells with row geometry, column alignment and width guards, and splitting a row that is taller than a page. All four are edits to the two shared files — none can be done from a new file, which is why they belong here and not in фаза 1.

**Tech Stack:** NestJS, TypeScript, `pdf-lib` + `@pdf-lib/fontkit` (already installed), jest.

## Global Constraints

- Node ≥20, pnpm@9.12. Server tests: `pnpm --filter @fermeribg/api test -- <pattern> --maxWorkers=4`, always **foreground**.
- **No new npm dependencies.** No new font asset — bold stays emulated behind `drawBoldText`.
- All dates through `dateBg` / `bgDateOf`. Local `Date` getters are forbidden (prod runs UTC, dev runs Europe/Sofia, suite runs UTC).
- `renderProtocolPdf(row): Promise<Buffer>` must keep its signature — `handover.service.ts:25` is its production caller.
- Exactly one import statement per source module per file (`no-duplicate-imports`).
- **The 16 original tests in `handover-pdf.spec.ts` stay green and unedited.** They are the production regression net.
- Bulgarian document wording is preserved verbatim where it exists.

## Testing constraint — read this before writing any test

Part 1 shipped **four** defects of one class: a test that asserted something *adjacent* to the behaviour and therefore could not fail. Cursor bookkeeping instead of drawn coordinates. Page counts instead of repeated headers. A signature-overlap test whose fixture had no signature. Every one was found by deliberately breaking the code, none by reading it.

Therefore, in every task below:

1. **Assert against captured draw calls**, not against `d.y`. The harness already exists in `pdf-kit.spec.ts` and `pdf-table.spec.ts`: `jest.spyOn(PDFPage.prototype, 'drawText' | 'drawLine' | 'drawImage')` with `afterEach` teardown. PDF bytes are useless for this — the font is Type0/CID and drawn strings are not literal text in the buffer.
2. **Prove every new assertion can fail.** Break the implementation in the specific way the test should catch, record the observed failure, restore. Report each observation. A test you did not watch fail is not yet a test.
3. **If the requirement is about appearance, render and look.** The Read tool renders PDFs. Both visual regressions in part 1 were invisible to all 2138 green tests.

---

### Task 7: Per-page document furniture

Today `newPage` is called *inside* `drawTable`, so a caller cannot put anything on the pages it creates. A multi-page document gets its brand header on page 1 only, and there is no page numbering anywhere — verified on an 80-item render: page 2 was bare product lines, page 3 was a lone footer.

**Files:**
- Modify: `server/src/modules/handover/pdf-kit.ts`
- Modify: `server/src/modules/handover/pdf-kit.spec.ts`
- Modify: `server/src/modules/handover/pdf-table.ts` (budget only — see step 3)

**Interfaces:**
- Consumes: `Doc`, `newPage`, `MARGIN`, `INK`, `contentW`, `drawBoldText` from `pdf-kit`.
- Produces:
  - `Doc` gains `onNewPage?: (d: Doc, pageIndex: number) => void` and `reservedTopOnNewPage: number` (default `0`)
  - `stampPageNumbers(d: Doc, label?: (page: number, total: number) => string): void`

**Why two fields and not one hook.** `drawTable` paginates **up front**, computing each later page's budget from the page height. If a hook silently consumes 77pt at the top of every new page, that budget is wrong and rows drawn on page 2+ cross the bottom margin. `reservedTopOnNewPage` is how the caller declares what its hook costs, so the budget stays honest. A hook that draws nothing leaves it `0`.

**Why a post-pass for numbering.** „стр. 2 от 5" cannot be drawn while page 2 is being laid out — the total is unknown until the document is finished. `stampPageNumbers` runs at the end over `d.doc.getPages()`.

- [ ] **Step 1: Write the failing tests**

Extend the existing spy `describe` in `server/src/modules/handover/pdf-kit.spec.ts`:

```ts
describe('per-page furniture', () => {
  it('runs onNewPage for each page newPage creates, with a 1-based-after-first index', async () => {
    const d = await createDoc(A4_PORTRAIT);
    const seen: number[] = [];
    d.onNewPage = (_d, i) => { seen.push(i); };
    newPage(d);
    newPage(d);
    expect(seen).toEqual([1, 2]);
  });

  it('lets the hook draw, and leaves the cursor where the hook left it', async () => {
    const d = await createDoc(A4_PORTRAIT);
    d.onNewPage = (doc) => { doc.page.drawText('продължение', { x: MARGIN, y: doc.y, size: 9, font: doc.font, color: INK }); doc.y -= 20; };
    newPage(d);
    expect(d.y).toBe(A4_PORTRAIT.h - MARGIN - 20);
    expect(drawTextSpy.mock.calls.some(([t]) => t === 'продължение')).toBe(true);
  });

  it('does not invoke the hook for the first page created by createDoc', async () => {
    let calls = 0;
    const d = await createDoc(A4_PORTRAIT);
    d.onNewPage = () => { calls += 1; };
    expect(calls).toBe(0);
  });

  it('stampPageNumbers writes one label on every page, with the true total', async () => {
    const d = await createDoc(A4_PORTRAIT);
    newPage(d);
    newPage(d);
    stampPageNumbers(d);
    const labels = drawTextSpy.mock.calls.map(([t]) => t).filter((t) => typeof t === 'string' && t.startsWith('стр.'));
    expect(labels).toEqual(['стр. 1 от 3', 'стр. 2 от 3', 'стр. 3 от 3']);
  });

  it('stampPageNumbers draws on distinct page instances, not three times on the last one', async () => {
    const d = await createDoc(A4_PORTRAIT);
    newPage(d);
    stampPageNumbers(d);
    const stampCalls = drawTextSpy.mock.calls
      .map((c, i) => ({ text: c[0], inst: drawTextSpy.mock.instances[i] }))
      .filter((c) => typeof c.text === 'string' && c.text.startsWith('стр.'));
    expect(new Set(stampCalls.map((c) => c.inst)).size).toBe(2);
  });

  it('stampPageNumbers accepts a custom label and leaves the cursor untouched', async () => {
    const d = await createDoc(A4_PORTRAIT);
    d.y = 400;
    stampPageNumbers(d, (p, t) => `${p}/${t}`);
    expect(drawTextSpy.mock.calls.some(([t]) => t === '1/1')).toBe(true);
    expect(d.y).toBe(400);
  });
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `pnpm --filter @fermeribg/api test -- pdf-kit --maxWorkers=4`
Expected: FAIL — `stampPageNumbers` is not exported; the hook tests fail because `onNewPage` is never called.

- [ ] **Step 3: Implement**

In `pdf-kit.ts`, extend the interface and `createDoc`:

```ts
export interface Doc {
  doc: PDFDocument;
  font: PDFFont;
  size: { w: number; h: number };
  page: PDFPage;
  y: number;
  /**
   * Called after every page `newPage` creates — NOT for the first page, which
   * `createDoc` makes before any caller can install a hook. `pageIndex` is
   * 0-based over the document, so the first hook call receives 1.
   *
   * Exists because `drawTable` calls `newPage` internally: without this a
   * caller has no way to put a continuation header on the pages its own table
   * generated.
   */
  onNewPage?: (d: Doc, pageIndex: number) => void;
  /**
   * What `onNewPage` consumes from the top of a fresh page. `drawTable`
   * paginates up front, so it must know this to keep later pages' budgets
   * honest — otherwise rows sized for a full page get drawn onto a page whose
   * top is already occupied, and they cross the bottom margin.
   */
  reservedTopOnNewPage: number;
}
```

`createDoc` returns `{ ..., reservedTopOnNewPage: 0 }`.

`newPage` becomes:

```ts
export function newPage(d: Doc): void {
  d.page = d.doc.addPage([d.size.w, d.size.h]);
  d.y = d.size.h - MARGIN;
  d.onNewPage?.(d, d.doc.getPageCount() - 1);
}
```

Add at the end of the file:

```ts
/**
 * Draws „стр. X от Y" at the foot of every page. A post-pass by necessity: the
 * total is not knowable while the pages are being laid out.
 *
 * Does not move the cursor — callers may keep drawing after calling it, though
 * in practice this is the last thing a renderer does.
 */
export function stampPageNumbers(d: Doc, label: (page: number, total: number) => string = (p, t) => `стр. ${p} от ${t}`): void {
  const pages = d.doc.getPages();
  const total = pages.length;
  pages.forEach((page, i) => {
    const text = label(i + 1, total);
    const w = d.font.widthOfTextAtSize(text, 8);
    page.drawText(text, { x: d.size.w - MARGIN - w, y: MARGIN - 18, size: 8, font: d.font, color: INK });
  });
}
```

In `pdf-table.ts`, `drawTable` must subtract the reservation from later pages only:

```ts
const pages = paginateRows(
  laid,
  d.y - MARGIN,
  d.size.h - 2 * MARGIN - d.reservedTopOnNewPage,
  headerHeight,
);
```

- [ ] **Step 4: Add the budget-honesty test**

In `pdf-table.spec.ts`, inside the existing spy `describe`:

```ts
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
```

- [ ] **Step 5: Run both suites, confirm green**

Run: `pnpm --filter @fermeribg/api test -- pdf-kit --maxWorkers=4`
Run: `pnpm --filter @fermeribg/api test -- pdf-table --maxWorkers=4`

- [ ] **Step 6: Teeth-check**

Break each of these, confirm the named test fails, restore. Report the observed values.
- Remove the `d.onNewPage?.(...)` call from `newPage` → the hook tests fail.
- Make `stampPageNumbers` draw only on `d.page` → the distinct-instances test fails.
- Drop `- d.reservedTopOnNewPage` from the budget → the budget-honesty test fails with a y below `MARGIN`.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/handover/pdf-kit.ts server/src/modules/handover/pdf-kit.spec.ts server/src/modules/handover/pdf-table.ts server/src/modules/handover/pdf-table.spec.ts
git commit -m "feat(pdf): per-page furniture — an onNewPage hook and page numbering

drawTable calls newPage internally, so a caller had no way to put anything on
the pages its own table created: an 80-item protocol printed its brand header
on page 1 and nothing at all on page 2. Numbering is a post-pass because the
total is not knowable while the pages are still being laid out.

reservedTopOnNewPage exists because pagination happens up front — a hook that
silently eats the top of every page would otherwise push later rows across the
bottom margin."
```

---

### Task 8: Image cells and row geometry

Spec §3.6 requires a farmer with a stored signature to print **already signed** inside section А of the consolidated protocol. Today `drawTable` takes `string[][]` and returns `void`: there is no image cell, and no way to learn where row *n* landed, so even drawing a separate signatures-by-row-number block is impossible.

**Files:**
- Modify: `server/src/modules/handover/pdf-table.ts`
- Modify: `server/src/modules/handover/pdf-table.spec.ts`

**Interfaces:**
- Produces:
  - `type Cell = string | { image: PDFImage; width: number; height: number }`
  - `layoutTable(columns, rows: Cell[][], font, size, padding): LaidOutRow[]` — `LaidOutRow.cells` becomes `Array<string[] | { image: PDFImage; width: number; height: number }>`
  - `interface PlacedRow { pageIndex: number; y: number; height: number }`
  - `drawTable(...): PlacedRow[]` — where every row landed, in input order

**Why `PDFImage` and not a data-URI.** `doc.embedPng` is async; taking a `PDFImage` keeps `drawTable` synchronous and pushes the one `await` to the caller, which already has the document. Do not make `drawTable` async — `renderProtocolPdf` and фаза 1 both call it inside larger sync layout sequences.

- [ ] **Step 1: Write the failing tests**

Append to `pdf-table.spec.ts`, inside the existing spy `describe`:

```ts
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
```

Add `drawImageSpy` to the existing `beforeEach`/`afterEach` harness alongside `drawTextSpy` and `drawLineSpy`.

- [ ] **Step 2: Run and confirm they fail**

Run: `pnpm --filter @fermeribg/api test -- pdf-table --maxWorkers=4`
Expected: FAIL — `Cell` type does not exist; `drawTable` returns `undefined`.

- [ ] **Step 3: Implement**

In `pdf-table.ts`:

```ts
import { PDFFont, PDFImage } from 'pdf-lib';

/** A table cell: wrapped text, or a pre-embedded image drawn at a fixed box. */
export type Cell = string | { image: PDFImage; width: number; height: number };

export type LaidOutCell = string[] | { image: PDFImage; width: number; height: number };

export interface LaidOutRow {
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

const isImage = (c: LaidOutCell): c is { image: PDFImage; width: number; height: number } =>
  typeof c === 'object' && !Array.isArray(c);
```

`layoutTable` widens its `rows` parameter to `Cell[][]`, passes image cells through untouched, and sizes the row by the taller of (text lines × lineHeight) and (tallest image height):

```ts
const textHeight = Math.max(0, ...cells.map((c) => (isImage(c) ? 0 : c.length * lineHeight)));
const imageHeight = Math.max(0, ...cells.map((c) => (isImage(c) ? c.height : 0)));
return { cells, height: Math.max(textHeight, imageHeight) + 2 * padding };
```

Keep the existing empty-columns guard: when `cells` is empty both maxima are `0`, so height is `2 * padding` — the same finite value part 1 fixed to.

`drawTable` collects and returns placements. Inside the row loop, before advancing the cursor, record `{ pageIndex, y: d.y - row.height, height: row.height }`, and draw an image cell with:

```ts
d.page.drawImage(cell.image, {
  x: xOf(i) + padding,
  y: d.y - padding - cell.height,
  width: cell.width,
  height: cell.height,
});
```

- [ ] **Step 4: Run, confirm green**

Run: `pnpm --filter @fermeribg/api test -- pdf-table --maxWorkers=4`

- [ ] **Step 5: Teeth-check**

Break each, confirm the named test fails, restore, report observations:
- Size rows by text only (ignore image height) → the row-sizing test fails.
- Draw the image at `x: MARGIN` → the column-position test fails.
- Return `placed` without the page-break entries (e.g. only the last page) → the ordering test fails.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/handover/pdf-table.ts server/src/modules/handover/pdf-table.spec.ts
git commit -m "feat(pdf): image cells and row geometry in drawTable

The consolidated protocol has to print a farmer's stored signature inside its
own table row, and drawTable had neither an image cell nor any way to tell a
caller where row N landed. Images are pre-embedded by the caller so drawTable
stays synchronous."
```

---

### Task 9: Column alignment and width guards

`Column.align` has been declared since part 1 and never honoured — `drawTable` always draws at `xOf(i) + padding`. Фаза 1's farmer table has a „СТОЙНОСТ EUR" money column, which must be right-aligned. Separately, nothing checks that the columns fit: over-wide columns bleed off the right edge in silence, and фаза 1 hand-sums a 5-column and a 6-column table against 732pt of landscape content width.

**Files:**
- Modify: `server/src/modules/handover/pdf-table.ts`
- Modify: `server/src/modules/handover/pdf-table.spec.ts`

**Interfaces:**
- Produces: `columnWidths(total: number, weights: number[]): number[]`
- `drawTable` honours `align: 'left' | 'right' | 'center'` for both body cells and the header row, and throws when the columns do not fit.

**Why throw rather than clamp.** A table wider than the page prints a legal document with a column sliced off the edge, and nobody notices until a farmer is holding it. This is a programming error at composition time, not a runtime condition to recover from — фаза 1 will see it on its first run.

- [ ] **Step 1: Write the failing tests**

```ts
describe('columnWidths', () => {
  it('splits the total in proportion to the weights', () => {
    expect(columnWidths(600, [1, 2, 3])).toEqual([100, 200, 300]);
  });
  it('gives the rounding remainder to the last column so the sum is exact', () => {
    const w = columnWidths(100, [1, 1, 1]);
    expect(w.reduce((a, b) => a + b, 0)).toBe(100);
  });
});

describe('column alignment and fit', () => {
  it('right-aligns a cell against its column edge', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    const cols: Column[] = [{ header: 'A', width: 100 }, { header: 'СТОЙНОСТ', width: 100, align: 'right' }];
    drawTable(d, cols, [['x', '123,45']]);
    const call = drawTextSpy.mock.calls.find(([t]) => t === '123,45')!;
    const textW = d.font.widthOfTextAtSize('123,45', 9);
    expect(call[1].x).toBeCloseTo(MARGIN + 100 + 100 - 4 - textW, 5);
  });

  it('right-aligns the header of a right-aligned column too', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    const cols: Column[] = [{ header: 'A', width: 100 }, { header: 'СТОЙНОСТ', width: 100, align: 'right' }];
    drawTable(d, cols, [['x', '1']]);
    const call = drawTextSpy.mock.calls.find(([t]) => t === 'СТОЙНОСТ')!;
    const textW = d.font.widthOfTextAtSize('СТОЙНОСТ', 9);
    expect(call[1].x).toBeCloseTo(MARGIN + 100 + 100 - 4 - textW, 5);
  });

  it('leaves a left-aligned column exactly where it was', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    drawTable(d, COLS, [['1', 'ЕТ Петров', 'Домати']]);
    const call = drawTextSpy.mock.calls.find(([t]) => t === 'ЕТ Петров')!;
    expect(call[1].x).toBe(MARGIN + COLS[0].width + 4);
  });

  it('throws when the columns are wider than the page, instead of drawing off the edge', async () => {
    const d = await createDoc(A4_PORTRAIT); // contentW = 485
    const tooWide: Column[] = [{ header: 'A', width: 300 }, { header: 'B', width: 300 }];
    expect(() => drawTable(d, tooWide, [['x', 'y']])).toThrow(/600.*485/);
  });

  it('does not throw when the columns fit exactly', async () => {
    const d = await createDoc(A4_PORTRAIT);
    const exact: Column[] = columnWidths(contentW(d), [1, 1]).map((w, i) => ({ header: `C${i}`, width: w }));
    expect(() => drawTable(d, exact, [['x', 'y']])).not.toThrow();
  });
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `pnpm --filter @fermeribg/api test -- pdf-table --maxWorkers=4`
Expected: FAIL — `columnWidths` not exported; alignment ignored; no throw.

- [ ] **Step 3: Implement**

```ts
/**
 * Split `total` into per-column widths in proportion to `weights`. The last
 * column absorbs the rounding remainder so the widths sum to `total` exactly —
 * a one-point gap is invisible on screen and a visible seam in print.
 */
export function columnWidths(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const out = weights.map((w) => Math.floor((total * w) / sum));
  out[out.length - 1] += total - out.reduce((a, b) => a + b, 0);
  return out;
}
```

In `drawTable`, before any drawing:

```ts
const totalW = columns.reduce((sum, c) => sum + c.width, 0);
const available = contentW(d);
if (totalW > available) {
  throw new Error(`drawTable: columns total ${totalW}pt but only ${available}pt of content width is available`);
}
```

Replace the fixed cell x with an alignment-aware helper used by BOTH the header row and the body cells:

```ts
const textX = (colIndex: number, text: string, textSize: number) => {
  const col = columns[colIndex];
  const left = xOf(colIndex) + padding;
  if (!col.align || col.align === 'left') return left;
  const tw = d.font.widthOfTextAtSize(text, textSize);
  const right = xOf(colIndex) + col.width - padding - tw;
  return col.align === 'right' ? right : (left + right) / 2;
};
```

Widen `Column.align` to `'left' | 'right' | 'center'`.

- [ ] **Step 4: Run, confirm green**

Run: `pnpm --filter @fermeribg/api test -- pdf-table --maxWorkers=4`

- [ ] **Step 5: Teeth-check**

Break each, confirm failure, restore, report:
- Apply alignment to body cells but not the header → the header-alignment test fails.
- Change the guard to `>=` → the fits-exactly test fails.
- Remove the guard → the too-wide test fails.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/handover/pdf-table.ts server/src/modules/handover/pdf-table.spec.ts
git commit -m "feat(pdf): honour column alignment and refuse a table wider than the page

align has been declared and ignored since the primitive was written; the
consolidated protocol's money column needs it. The width guard throws rather
than clamping — a column sliced off the edge of a legal document is not
something to recover from quietly at runtime."
```

---

### Task 10: Split a row taller than a page

`paginateRows` emits an oversized row alone rather than pushing it forward forever — a deliberate choice in part 1 that stopped an infinite loop. But `drawTable` then draws it regardless: measured at row height 728 against 485pt of usable page, the content ran to **y = -208**, entirely off the paper, in silence.

This is the ledger's "carry to фаза 1" item. It lands precisely on the consolidated protocol's „ПРОДУКТИ И КОЛИЧЕСТВА" column, which holds a farmer's whole product list.

**Files:**
- Modify: `server/src/modules/handover/pdf-table.ts`
- Modify: `server/src/modules/handover/pdf-table.spec.ts`

**Interfaces:**
- Produces: `splitRow(row: LaidOutRow, availableHeight: number, lineHeight: number, padding: number): [LaidOutRow, LaidOutRow] | null`

**The rule.** A row whose wrapped text is taller than a whole usable page is split at a line boundary: as many lines as fit go on this page, the remainder continues on the next. An **image** cell cannot be split — a row whose image alone exceeds the page keeps the current behaviour (drawn alone, oversized), because scaling a signature down silently is worse than one oversized row, and there is no correct place to cut an image.

- [ ] **Step 1: Write the failing tests**

```ts
describe('splitRow', () => {
  const textRow = (lines: number): LaidOutRow => ({
    cells: [Array.from({ length: lines }, (_, i) => `ред ${i + 1}`)],
    height: lines * 12 + 8,
  });

  it('returns null when the row already fits', () => {
    expect(splitRow(textRow(3), 500, 12, 4)).toBeNull();
  });

  it('splits at a line boundary and conserves every line', () => {
    const [head, tail] = splitRow(textRow(50), 100, 12, 4)!;
    const headLines = head.cells[0] as string[];
    const tailLines = tail.cells[0] as string[];
    expect(headLines.length + tailLines.length).toBe(50);
    expect(headLines.concat(tailLines)).toEqual((textRow(50).cells[0] as string[]));
    expect(head.height).toBeLessThanOrEqual(100);
  });

  it('never returns an empty head — at least one line stays on this page', () => {
    const [head] = splitRow(textRow(50), 10, 12, 4)!;
    expect((head.cells[0] as string[]).length).toBeGreaterThanOrEqual(1);
  });

  it('refuses to split a row containing an image cell', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    const img = await tinyPng(d);
    const row: LaidOutRow = { cells: [{ image: img, width: 80, height: 700 }], height: 708 };
    expect(splitRow(row, 100, 12, 4)).toBeNull();
  });
});

describe('drawTable with an over-tall row', () => {
  it('splits it across pages instead of drawing off the paper', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    const huge = Array.from({ length: 80 }, (_, i) => `позиция ${i + 1}`).join(' ');
    drawTable(d, COLS, [['1', 'ЕТ Петров', huge]]);
    expect(d.doc.getPageCount()).toBeGreaterThan(1);
    const ys = [
      ...drawTextSpy.mock.calls.map((c) => c[1].y),
      ...drawLineSpy.mock.calls.flatMap((c) => [c[0].start.y, c[0].end.y]),
    ];
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(MARGIN);
  });
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `pnpm --filter @fermeribg/api test -- pdf-table --maxWorkers=4`
Expected: FAIL — `splitRow` not exported; the drawTable case draws below `MARGIN`.

- [ ] **Step 3: Implement**

```ts
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
```

In `drawTable`'s page loop, before drawing a row, try to split it against the remaining space on the current page; draw the head, break, and carry the tail to the next page. Keep the returned `PlacedRow` for a split row pointing at where its **head** landed, and document that.

- [ ] **Step 4: Run, confirm green**

Run: `pnpm --filter @fermeribg/api test -- pdf-table --maxWorkers=4`

- [ ] **Step 5: Teeth-check**

Break each, confirm failure, restore, report:
- Drop the `Math.max(1, ...)` floor and feed a tiny `availableHeight` → the non-empty-head test fails (or the suite hangs, which is itself the finding — report it).
- Let `splitRow` split image rows → the image test fails.
- Skip the split in `drawTable` → the off-paper test fails with a negative y.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/handover/pdf-table.ts server/src/modules/handover/pdf-table.spec.ts
git commit -m "fix(pdf): split a row taller than a page instead of drawing it off the paper

Measured before this: a 728pt row against 485pt of usable page drew down to
y = -208, silently. It is the consolidated protocol's product-list column that
will hit this. Image cells are still never split — there is no correct place to
cut a signature."
```

---

### Task 11: Wire the furniture into the bilateral protocol

Tasks 7-10 add capability; this task proves it works end to end on the document that already exists, so фаза 1 inherits a working example rather than an untested API.

**Files:**
- Modify: `server/src/modules/handover/handover-pdf.ts`
- Modify: `server/src/modules/handover/handover-pdf.spec.ts`

- [ ] **Step 1: Write the failing tests**

Add this inside the spec's existing spy `describe` (the one with the `PDFPage.prototype` spies and `afterEach` teardown), so `drawTextSpy` is in scope. `bigRow(n)` already exists in the file from the overflow-regression block:

```ts
const pageLabels = () =>
  drawTextSpy.mock.calls
    .map(([t]) => t)
    .filter((t): t is string => typeof t === 'string' && t.startsWith('стр.'));

it('numbers every page of a multi-page protocol', async () => {
  const buf = await renderProtocolPdf(bigRow(80) as any);
  const pageCount = (await PDFDocument.load(buf)).getPageCount();
  expect(pageCount).toBeGreaterThan(1);
  expect(pageLabels()).toEqual(
    Array.from({ length: pageCount }, (_, i) => `стр. ${i + 1} от ${pageCount}`),
  );
});

it('stamps each label on its own page, not all of them on the last one', async () => {
  await renderProtocolPdf(bigRow(80) as any);
  const stamped = drawTextSpy.mock.calls
    .map((c, i) => ({ text: c[0], inst: drawTextSpy.mock.instances[i] }))
    .filter((c) => typeof c.text === 'string' && c.text.startsWith('стр.'));
  expect(new Set(stamped.map((s) => s.inst)).size).toBe(stamped.length);
});

it('leaves a single-page protocol unnumbered — „стр. 1 от 1" is clutter on a form', async () => {
  const buf = await renderProtocolPdf(bigRow(3) as any);
  expect((await PDFDocument.load(buf)).getPageCount()).toBe(1);
  expect(pageLabels()).toEqual([]);
});
```

- [ ] **Step 2-4: Implement, run, teeth-check**

In `renderProtocolPdf`, after all content is drawn and before `doc.save()`, call `stampPageNumbers(d)` **only when `d.doc.getPageCount() > 1`**. A „стр. 1 от 1" on a one-page протокол is clutter.

Do NOT add a continuation header to this document — the bilateral protocol's own body already restates the parties, and фаза 1's consolidated document is where `onNewPage` earns its keep. Adding one here would change a production document's appearance for no requirement.

Run: `pnpm --filter @fermeribg/api test -- handover-pdf --maxWorkers=4` — the 16 original tests stay green and unedited.

- [ ] **Step 5: Render and look**

Render a long protocol and READ the PDF. Confirm the page numbers appear at the foot of each page, that the signature blocks are still anchored and clear of the closing sentence, and that nothing collides.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/handover/handover-pdf.ts server/src/modules/handover/handover-pdf.spec.ts
git commit -m "feat(handover): number the pages of a multi-page protocol

Proves the new furniture on the document that already exists, so фаза 1
inherits a working example rather than an untested API. Single-page protocols
stay unnumbered — „стр. 1 от 1" is clutter on a form."
```

---

### Task 12: Split a row that is both over-tall text AND carries an image

The final whole-branch review found the seventh defect of this branch's recurring class. `splitRow` bails on **any** image row (`row.cells.some(isImage) → null`), so a row whose *text* is taller than a page but which also carries a small signature image is never split — `drawTable` draws its text straight off the bottom. Reproduced: a long products column plus a 110×36 signature drew its text to **y = −268**, silently, exactly the original "content falls off the page" bug, for exactly the shape of the consolidated protocol's section А (a farmer's products column with an in-row signature).

This closes the residual half of the ledger's "over-tall row" carry: pure-text and pure-image rows are already handled; this handles their composition.

**The design decision** (there is genuine ambiguity here, so it is fixed explicitly): when an image row's text overflows, the **image stays on the head** — a farmer's signature belongs next to the first fragment of their row, and the image is small — while the text is cut at a line boundary. The tail is pure text; its image column becomes an empty cell. An image *taller than the page fragment itself* is still refused (returns `null`) and left to `fitImageCells` to scale, unchanged.

**Files:**
- Modify: `server/src/modules/handover/pdf-table.ts` (`splitRow` only)
- Modify: `server/src/modules/handover/pdf-table.spec.ts`

**Interfaces:** no signature change — `splitRow`'s existing signature and return type are unchanged; only its image-row behaviour changes.

- [ ] **Step 1: Write the failing tests**

Append inside the existing spy `describe`:

```ts
it('splits an image row by its text, keeping the image on the head', async () => {
  const d = await createDoc(A4_LANDSCAPE);
  const img = await tinyPng(d);
  // 50 text lines (600pt) + a small 40pt image; availableHeight 200 forces a split.
  const row: LaidOutRow = {
    cells: [Array.from({ length: 50 }, (_, i) => `ред ${i + 1}`), { image: img, width: 80, height: 40 }],
    height: 50 * 12 + 8,
  };
  const [head, tail] = splitRow(row, 200, 12, 4)!;
  // Image rides on the head, gone from the tail.
  expect(head.cells.some((c) => !Array.isArray(c))).toBe(true);
  expect(tail.cells.some((c) => !Array.isArray(c))).toBe(false);
  // Every text line is conserved, in order, across the two fragments.
  const headLines = head.cells[0] as string[];
  const tailLines = tail.cells[0] as string[];
  expect(headLines.length + tailLines.length).toBe(50);
  expect(headLines.concat(tailLines)).toEqual(row.cells[0]);
  // The head fits the page fragment it was cut for.
  expect(head.height).toBeLessThanOrEqual(200);
});

it('still refuses to split when the image alone is taller than the fragment', async () => {
  const d = await createDoc(A4_LANDSCAPE);
  const img = await tinyPng(d);
  // A 300pt image cannot ride on a 100pt fragment — leave it to fitImageCells.
  const row: LaidOutRow = {
    cells: [Array.from({ length: 50 }, (_, i) => `ред ${i + 1}`), { image: img, width: 80, height: 300 }],
    height: 50 * 12 + 8,
  };
  expect(splitRow(row, 100, 12, 4)).toBeNull();
});

it('drawTable keeps a long text+image row on the page instead of off it', async () => {
  const d = await createDoc(A4_LANDSCAPE);
  const img = await tinyPng(d);
  const huge = Array.from({ length: 80 }, (_, i) => `позиция ${i + 1}`).join(' ');
  // A row whose text overflows a page, carrying a normal small signature.
  drawTable(d, COLS, [[huge, 'ЕТ Петров', { image: img, width: 80, height: 36 }]]);
  expect(d.doc.getPageCount()).toBeGreaterThan(1);
  const ys = [
    ...drawTextSpy.mock.calls.map((c) => c[1].y),
    ...drawLineSpy.mock.calls.flatMap((c) => [c[0].start.y, c[0].end.y]),
    ...drawImageSpy.mock.calls.map((c) => c[1].y),
  ];
  expect(Math.min(...ys)).toBeGreaterThanOrEqual(MARGIN);
});
```

Note: `COLS`'s first column may be narrow; if the 80-word string does not overflow at `COLS[0].width`, widen the fixture's line count (as Task 10 did — 80 words wrapped to two tokens each is only ~200pt). Hand-measure and use a count that genuinely overflows a landscape page, and say which in your report.

- [ ] **Step 2: Run, confirm they fail**

Run: `pnpm --filter @fermeribg/api test -- pdf-table --maxWorkers=4`
Expected: FAIL — `splitRow` returns `null` for the image row, so the destructuring in test 1 throws, and the drawTable test finds text below MARGIN.

- [ ] **Step 3: Implement — replace `splitRow`'s image bail with a text-split-keeping-image branch**

Replace this in `splitRow`:

```ts
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
```

with:

```ts
  if (row.height <= availableHeight) return null;

  const imageHeight = Math.max(0, ...row.cells.filter(isImage).map((c) => c.height));
  // An image taller than the fragment cannot ride on the head — there is no
  // line boundary to cut it at. Leave it to `fitImageCells` to scale down.
  if (imageHeight + 2 * padding > availableHeight) return null;

  const fit = Math.max(1, Math.floor((availableHeight - 2 * padding) / lineHeight));
  const textLen = (c: LaidOutCell) => (isImage(c) ? 0 : c.length);
  if (row.cells.every((c) => textLen(c) <= fit)) return null;

  // Head keeps the image (a signature belongs beside the first fragment of the
  // farmer's row) and the first `fit` text lines; the tail is pure text, its
  // image column emptied so no second copy is drawn.
  const head: LaidOutCell[] = row.cells.map((c) => (isImage(c) ? c : c.slice(0, fit)));
  const tail: LaidOutCell[] = row.cells.map((c) => (isImage(c) ? [''] : c.slice(fit)));
  const heightOf = (cs: LaidOutCell[]) =>
    Math.max(
      0,
      ...cs.map((c) => (isImage(c) ? c.height : c.length * lineHeight)),
    ) + 2 * padding;
  return [
    { cells: head, height: heightOf(head) },
    { cells: tail, height: heightOf(tail) },
  ];
```

Update the doc comment above `splitRow` to say the image rides on the head and only an image taller than the fragment is refused.

- [ ] **Step 4: Run, confirm green**

Run: `pnpm --filter @fermeribg/api test -- pdf-table --maxWorkers=4`
Then `npx tsc -p server/tsconfig.json --noEmit`.

Every pre-existing test must stay green — in particular the two Task 10 tests (`returns null when the row already fits`, `refuses to split a row containing an image cell`). Note the second of those: it passed an image row and expected `null`. Check its fixture — if that image is small enough to now ride on the head with its text, the test's premise changed and it will fail. If so, that is a REAL conflict from this task; STOP and report it. Do not edit it silently. (Read it first: Task 10's `refuses to split a row containing an image cell` uses `height: 700` on a `100`-tall fragment — the image is taller than the fragment, so it still returns `null` under the new code and stays green. Confirm this before proceeding.)

- [ ] **Step 5: Teeth-check**

Break each, confirm the named test fails, restore, report observed values:
- Put the image on the **tail** instead of the head (`isImage(c) ? [''] : ...` for head, `isImage(c) ? c : ...` for tail) → the "keeping the image on the head" test fails.
- Drop the `imageHeight + 2*padding > availableHeight` guard → the "still refuses when the image alone is taller" test fails (it would try to split and return a head that cannot fit).
- Revert the whole branch to the old `row.cells.some(isImage) → null` → the drawTable off-page test fails with a negative y (report the value).

- [ ] **Step 6: Render and look**

This is the shape phase 1's section А will use, so confirm it visually. Build a small standalone probe (write it OUTSIDE the repo, under the scratchpad dir) that renders a landscape table with one row carrying a long products column and a small signature image, tall enough to split across a page. READ the resulting PDF. Confirm: the signature sits on the first page beside the first part of the row, the remaining text continues on page 2, and nothing runs off the bottom. Report what you saw. Delete the probe before committing.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/handover/pdf-table.ts server/src/modules/handover/pdf-table.spec.ts
git commit -m "fix(pdf): split an over-tall row that also carries an image

splitRow bailed on any image row, so a farmer's row with a long products
column and an in-row signature drew its text off the bottom of the page —
the branch's original bug, resurfacing for exactly the shape the consolidated
protocol's section А will use. The image now rides on the head fragment and
the text splits around it; only an image taller than the fragment itself is
still refused and left to fitImageCells to scale."
```

---

## Self-review

**Coverage of the final review's findings:** per-page furniture → Task 7 + Task 11. Image cells and row geometry → Task 8. `Column.align` dead → Task 9. Column-width guard → Task 9. Oversized row off-page → Task 10.

**Deliberately NOT done here:**
- `ensureSpace`'s unused boolean return and the misleading comment — a two-line cleanup with no behavioural risk; folded into whichever task next touches that region rather than given its own commit.
- `handover-pdf.ts`'s `CONTENT_W` / `wrap` re-exports kept alive only by its spec — removing them means editing the 16 protected tests, which costs more than the cruft.
- A section-heading primitive with keep-together. Named by the review as missing, but фаза 1 can compose it from `ensureSpace` + `drawBoldText` without touching shared code, so it is genuinely фаза 1's.
- Bold font. Still emulated; adding `DejaVuSans-Bold.ttf` needs a binary the repo does not have, which is the owner's call.
