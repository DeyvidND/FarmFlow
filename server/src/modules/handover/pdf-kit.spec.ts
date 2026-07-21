import { PDFPage } from 'pdf-lib';
import {
  A4_LANDSCAPE,
  A4_PORTRAIT,
  contentW,
  createDoc,
  dateBg,
  drawDocumentFooter,
  drawDocumentHeader,
  ensureSpace,
  MARGIN,
  newPage,
  wrap,
} from './pdf-kit';

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

  it('consumes strictly less vertical space when neither number nor date is present, than when both are (the row is genuinely omitted)', async () => {
    const withNeither = await createDoc(A4_PORTRAIT);
    const withBoth = await createDoc(A4_PORTRAIT);
    const base = { brand: 'ФермериБГ', title: 'ПРОТОКОЛ' };
    drawDocumentHeader(withNeither, { ...base, number: null, date: null });
    drawDocumentHeader(withBoth, { ...base, number: '7', date: new Date('2026-07-21T06:00:00Z') });
    expect(withNeither.y).toBeGreaterThan(withBoth.y); // row omitted → less space used
  });

  it('footer sits at the foot, not at the cursor', async () => {
    const d = await createDoc(A4_PORTRAIT);
    d.y = 400;
    drawDocumentFooter(d, 'Съставен в два еднообразни екземпляра.');
    expect(d.y).toBe(400); // footer must not move the cursor
  });
});

describe('shared brand block — what it actually draws', () => {
  // Same rationale as pdf-table.spec.ts: `drawText`/`drawLine` are real
  // prototype methods, so spying on the prototype survives page swaps and
  // lets us assert on the coordinates actually handed to pdf-lib rather than
  // on `d.y`, which is decoupled from x, from centering, and from whether
  // anything was drawn at all.
  let drawTextSpy: jest.SpyInstance;
  let drawLineSpy: jest.SpyInstance;

  beforeEach(() => {
    drawTextSpy = jest.spyOn(PDFPage.prototype, 'drawText');
    drawLineSpy = jest.spyOn(PDFPage.prototype, 'drawLine');
  });

  afterEach(() => {
    drawTextSpy.mockRestore();
    drawLineSpy.mockRestore();
  });

  it('draws the brand line at the left margin, on the line the cursor started at', async () => {
    const d = await createDoc(A4_PORTRAIT);
    const startY = d.y;
    drawDocumentHeader(d, { brand: 'ФермериБГ', title: 'ПРОТОКОЛ', number: '7', date: new Date('2026-07-21T06:00:00Z') });

    // drawBoldText overdraws the same string 2-3 times at x, x+0.25, x+0.5 to
    // fake weight — assert every one of those calls, not just the first.
    const brandCalls = drawTextSpy.mock.calls.filter(([text]) => text === 'ФермериБГ');
    expect(brandCalls.length).toBeGreaterThanOrEqual(1);
    for (const [, opts] of brandCalls) {
      expect(opts.x).toBeGreaterThanOrEqual(MARGIN);
      expect(opts.x).toBeLessThan(MARGIN + 1);
      expect(opts.y).toBe(startY);
    }
  });

  it('draws the rule directly under the brand line, spanning the full content width', async () => {
    const d = await createDoc(A4_PORTRAIT);
    const startY = d.y;
    drawDocumentHeader(d, { brand: 'ФермериБГ', title: 'ПРОТОКОЛ', number: '7', date: new Date('2026-07-21T06:00:00Z') });

    expect(drawLineSpy.mock.calls).toHaveLength(1);
    const [opts] = drawLineSpy.mock.calls[0];
    expect(opts.start).toEqual({ x: MARGIN, y: startY - 6 });
    expect(opts.end).toEqual({ x: MARGIN + contentW(d), y: startY - 6 });
  });

  it('centres the title using the text width measured on that page, not a fixed x', async () => {
    const title = 'ОБОБЩЕН ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ';
    const header = { brand: 'ФермериБГ', title, number: '7', date: new Date('2026-07-21T06:00:00Z') };

    const p = await createDoc(A4_PORTRAIT);
    drawDocumentHeader(p, header);
    const titleCallsP = drawTextSpy.mock.calls.filter(([text]) => text === title);
    expect(titleCallsP.length).toBeGreaterThanOrEqual(1);
    const expectedXP = MARGIN + (contentW(p) - p.font.widthOfTextAtSize(title, 14)) / 2;
    const xsP = titleCallsP.map(([, o]) => o.x).sort((a, b) => a - b);
    expect(xsP[0]).toBeCloseTo(expectedXP, 5);

    drawTextSpy.mockClear();
    const l = await createDoc(A4_LANDSCAPE);
    drawDocumentHeader(l, header);
    const titleCallsL = drawTextSpy.mock.calls.filter(([text]) => text === title);
    const expectedXL = MARGIN + (contentW(l) - l.font.widthOfTextAtSize(title, 14)) / 2;
    const xsL = titleCallsL.map(([, o]) => o.x).sort((a, b) => a - b);
    expect(xsL[0]).toBeCloseTo(expectedXL, 5);

    // The two pages are genuinely different widths, so a real centering
    // formula must place the title at a different x on each — the exact
    // difference is half the page-width delta.
    expect(expectedXL - expectedXP).toBeCloseTo((A4_LANDSCAPE.w - A4_PORTRAIT.w) / 2, 5);
  });

  it('right-aligns the date to the content edge, on the same row as the number', async () => {
    const d = await createDoc(A4_PORTRAIT);
    const date = new Date('2026-07-21T06:00:00Z');
    drawDocumentHeader(d, { brand: 'ФермериБГ', title: 'ПРОТОКОЛ', number: '7', date });

    const dateText = dateBg(date);
    const dateCalls = drawTextSpy.mock.calls.filter(([text]) => text === dateText);
    expect(dateCalls).toHaveLength(1);
    const rw = d.font.widthOfTextAtSize(dateText, 10);
    expect(dateCalls[0][1].x).toBe(MARGIN + contentW(d) - rw);

    const numberCalls = drawTextSpy.mock.calls.filter(([text]) => text === '№ 7');
    expect(numberCalls).toHaveLength(1);
    expect(numberCalls[0][1].x).toBe(MARGIN);
    expect(numberCalls[0][1].y).toBe(dateCalls[0][1].y);
  });

  it('still draws the date, right-aligned, when there is no number (unsaved preview) — the day goods changed hands is real even before a number exists', async () => {
    const d = await createDoc(A4_PORTRAIT);
    const date = new Date('2026-07-21T06:00:00Z');
    drawDocumentHeader(d, { brand: 'ФермериБГ', title: 'ПРОТОКОЛ', number: null, date });

    const dateText = dateBg(date);
    const dateCalls = drawTextSpy.mock.calls.filter(([text]) => text === dateText);
    expect(dateCalls).toHaveLength(1);
    const rw = d.font.widthOfTextAtSize(dateText, 10);
    expect(dateCalls[0][1].x).toBe(MARGIN + contentW(d) - rw);

    expect(drawTextSpy.mock.calls.some(([text]) => typeof text === 'string' && text.startsWith('№'))).toBe(false);
  });

  it('still draws the number, at the left margin, when there is no date', async () => {
    const d = await createDoc(A4_PORTRAIT);
    drawDocumentHeader(d, { brand: 'ФермериБГ', title: 'ПРОТОКОЛ', number: '7', date: null });

    const numberCalls = drawTextSpy.mock.calls.filter(([text]) => text === '№ 7');
    expect(numberCalls).toHaveLength(1);
    expect(numberCalls[0][1].x).toBe(MARGIN);

    // Nothing else drew on that row — the date side stayed blank.
    const rowCalls = drawTextSpy.mock.calls.filter(([, opts]) => opts.y === numberCalls[0][1].y);
    expect(rowCalls).toHaveLength(1);
  });

  it('draws the subtitle, when present, centred between the title and the number row', async () => {
    const d = await createDoc(A4_PORTRAIT);
    drawDocumentHeader(d, {
      brand: 'ФермериБГ',
      title: 'ПРОТОКОЛ',
      subtitle: 'копие за куриера',
      number: '7',
      date: new Date('2026-07-21T06:00:00Z'),
    });
    const subtitleCalls = drawTextSpy.mock.calls.filter(([text]) => text === 'копие за куриера');
    expect(subtitleCalls).toHaveLength(1);
    const expectedX = MARGIN + (contentW(d) - d.font.widthOfTextAtSize('копие за куриера', 9)) / 2;
    expect(subtitleCalls[0][1].x).toBeCloseTo(expectedX, 5);
  });

  it('draws the footer text centred, pinned below the margin — not a no-op that merely leaves the cursor alone', async () => {
    const d = await createDoc(A4_PORTRAIT);
    d.y = 400;
    const text = 'Съставен в два еднообразни екземпляра.';
    drawDocumentFooter(d, text);

    const calls = drawTextSpy.mock.calls.filter(([t]) => t === text);
    expect(calls).toHaveLength(1);
    const expectedX = MARGIN + (contentW(d) - d.font.widthOfTextAtSize(text, 8)) / 2;
    expect(calls[0][1].x).toBeCloseTo(expectedX, 5);
    expect(calls[0][1].y).toBeLessThan(MARGIN);
    expect(calls[0][1].y).not.toBe(400);
  });
});

describe('shared brand block — shrinking a title/subtitle that would otherwise bleed off the page', () => {
  // Same spy harness as the section above: assert on the coordinates and
  // sizes actually handed to pdf-lib, not on `d.y` (which cannot distinguish
  // "drawn smaller" from "drawn at the same size, still overset").
  let drawTextSpy: jest.SpyInstance;

  beforeEach(() => {
    drawTextSpy = jest.spyOn(PDFPage.prototype, 'drawText');
  });

  afterEach(() => {
    drawTextSpy.mockRestore();
  });

  // Hand-traced against DejaVuSans via `font.widthOfTextAtSize`: at the
  // nominal size, these are wider than A4-portrait content width (485pt),
  // so both must shrink; the two "normal" strings are comfortably under it,
  // so neither should move at all.
  const longTitle = 'ОБОБЩЕН ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ ЗА МНОЖЕСТВО ПРОИЗВОДИТЕЛИ';
  const normalTitle = 'ПРОТОКОЛ';
  const longSubtitle =
    'за приемане на стоки от множество производители единствено за транспорт до множество клиенти и техните представители';
  const normalSubtitle = 'копие за куриера';
  const baseHeader = { brand: 'ФермериБГ', number: '7', date: new Date('2026-07-21T06:00:00Z') };

  it('shrinks an over-long title to fit: smaller than nominal size, x back at (not left of) MARGIN', async () => {
    const d = await createDoc(A4_PORTRAIT);
    const w = contentW(d);
    const widthAtNominal = d.font.widthOfTextAtSize(longTitle, 14);
    // Confirm the premise: at 14pt this title is wider than the page's
    // content box, so today's fixed-size centring would place it left of
    // MARGIN and run it off both edges.
    expect(widthAtNominal).toBeGreaterThan(w);

    drawDocumentHeader(d, { ...baseHeader, title: longTitle });

    const calls = drawTextSpy.mock.calls.filter(([text]) => text === longTitle);
    expect(calls.length).toBeGreaterThanOrEqual(1);

    // Glyph widths scale linearly with size, so the exact fitting size is
    // solvable directly: shrink by the same ratio the text overshoots by.
    const expectedSize = 14 * (w / widthAtNominal);
    expect(expectedSize).toBeLessThan(14);
    expect(expectedSize).toBeGreaterThan(14 * 0.6); // doesn't hit the floor for this string

    for (const [, opts] of calls) {
      expect(opts.size).toBeCloseTo(expectedSize, 5);
      expect(opts.x).toBeGreaterThanOrEqual(MARGIN);
    }
    // At the exact fitting size the text exactly fills the content box, so
    // centring collapses to x === MARGIN (the dx=0 overdraw pass).
    const xs = calls.map(([, opts]) => opts.x).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(MARGIN, 5);
  });

  it('stops shrinking at the 60% floor and still draws a title too long to ever fit, rather than clipping or erroring', async () => {
    const d = await createDoc(A4_PORTRAIT);
    const w = contentW(d);
    // Hand-traced: this title needs a scale of ~0.424 to fit at 14pt — past
    // the 60% floor — so the fitted size must clamp at exactly 14 * 0.6.
    const extremeTitle =
      'ОБОБЩЕН ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ ЗА МНОЖЕСТВО ПРОИЗВОДИТЕЛИ И МНОЖЕСТВО КЛИЕНТИ И ТЕХНИТЕ УПЪЛНОМОЩЕНИ ПРЕДСТАВИТЕЛИ';
    const widthAtNominal = d.font.widthOfTextAtSize(extremeTitle, 14);
    const neededScale = w / widthAtNominal;
    expect(neededScale).toBeLessThan(0.6); // confirms this string exercises the floor, not the plain shrink path

    drawDocumentHeader(d, { ...baseHeader, title: extremeTitle });

    const calls = drawTextSpy.mock.calls.filter(([text]) => text === extremeTitle);
    expect(calls.length).toBeGreaterThanOrEqual(1); // still drawn — not clipped, not skipped
    for (const [, opts] of calls) {
      expect(opts.size).toBeCloseTo(14 * 0.6, 5);
    }
  });

  it('draws a normal-length title at exactly the nominal size, at the same x as before the fix', async () => {
    const d = await createDoc(A4_PORTRAIT);
    const w = contentW(d);
    drawDocumentHeader(d, { ...baseHeader, title: normalTitle });

    const calls = drawTextSpy.mock.calls.filter(([text]) => text === normalTitle);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const [, opts] of calls) {
      expect(opts.size).toBe(14);
    }
    const expectedX = MARGIN + (w - d.font.widthOfTextAtSize(normalTitle, 14)) / 2;
    const xs = calls.map(([, opts]) => opts.x).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(expectedX, 5);
  });

  it('advances the cursor by the same amount whether the title is normal-length or over-long', async () => {
    const normalDoc = await createDoc(A4_PORTRAIT);
    const startNormal = normalDoc.y;
    drawDocumentHeader(normalDoc, { ...baseHeader, title: normalTitle });
    const usedNormal = startNormal - normalDoc.y;

    const longDoc = await createDoc(A4_PORTRAIT);
    const startLong = longDoc.y;
    drawDocumentHeader(longDoc, { ...baseHeader, title: longTitle });
    const usedLong = startLong - longDoc.y;

    expect(usedLong).toBe(usedNormal);
  });

  it('shrinks an over-long subtitle to fit: smaller than nominal size, x back at (not left of) MARGIN', async () => {
    const d = await createDoc(A4_PORTRAIT);
    const w = contentW(d);
    const widthAtNominal = d.font.widthOfTextAtSize(longSubtitle, 9);
    expect(widthAtNominal).toBeGreaterThan(w);

    drawDocumentHeader(d, { ...baseHeader, title: normalTitle, subtitle: longSubtitle });

    const calls = drawTextSpy.mock.calls.filter(([text]) => text === longSubtitle);
    expect(calls).toHaveLength(1); // subtitle isn't bold — no overdraw passes

    const expectedSize = 9 * (w / widthAtNominal);
    expect(expectedSize).toBeLessThan(9);
    expect(expectedSize).toBeGreaterThan(9 * 0.6);

    expect(calls[0][1].size).toBeCloseTo(expectedSize, 5);
    expect(calls[0][1].x).toBeGreaterThanOrEqual(MARGIN);
    expect(calls[0][1].x).toBeCloseTo(MARGIN, 5);
  });

  it('draws a normal-length subtitle at exactly the nominal size, at the same x as before the fix', async () => {
    const d = await createDoc(A4_PORTRAIT);
    const w = contentW(d);
    drawDocumentHeader(d, { ...baseHeader, title: normalTitle, subtitle: normalSubtitle });

    const calls = drawTextSpy.mock.calls.filter(([text]) => text === normalSubtitle);
    expect(calls).toHaveLength(1);
    expect(calls[0][1].size).toBe(9);
    const expectedX = MARGIN + (w - d.font.widthOfTextAtSize(normalSubtitle, 9)) / 2;
    expect(calls[0][1].x).toBeCloseTo(expectedX, 5);
  });

  it('advances the cursor by the same amount whether the subtitle is normal-length or over-long', async () => {
    const normalDoc = await createDoc(A4_PORTRAIT);
    const startNormal = normalDoc.y;
    drawDocumentHeader(normalDoc, { ...baseHeader, title: normalTitle, subtitle: normalSubtitle });
    const usedNormal = startNormal - normalDoc.y;

    const longDoc = await createDoc(A4_PORTRAIT);
    const startLong = longDoc.y;
    drawDocumentHeader(longDoc, { ...baseHeader, title: normalTitle, subtitle: longSubtitle });
    const usedLong = startLong - longDoc.y;

    expect(usedLong).toBe(usedNormal);
  });
});
