import { PDFPage } from 'pdf-lib';
import { A4_LANDSCAPE, contentW, createDoc } from './pdf-kit';
import { drawTable } from './pdf-table';
import { buildFarmerTableRows, drawFarmerSignatureStrip, FARMER_COLUMNS } from './consolidated-pdf';
import type { ConsolidatedFarmerRow } from './consolidated-protocol.service';

const farmer = (over: Partial<ConsolidatedFarmerRow> = {}): ConsolidatedFarmerRow => ({
  farmerId: 'f1', name: 'Васил', legal: null, signaturePng: null,
  items: [{ productName: 'Домати', quantity: 5, unit: 'кг', priceStotinki: 300 } as any],
  ...over,
});

describe('buildFarmerTableRows (pure)', () => {
  it('joins a farmer\'s items into one printable cell', () => {
    const rows = buildFarmerTableRows([farmer()]);
    expect(rows).toEqual([['1', 'Васил', 'Домати — 5кг', '', '']]);
  });

  it('prints batch/eDoc overrides in their own columns when present', () => {
    const rows = buildFarmerTableRows([farmer({ batch: 'Партида 7', eDoc: 'Е-1234' })]);
    expect(rows[0][3]).toBe('Партида 7');
    expect(rows[0][4]).toBe('Е-1234');
  });

  it('numbers rows 1-based, matching PlacedRow order for the §3.6 signature strip', () => {
    const rows = buildFarmerTableRows([farmer({ farmerId: 'f1', name: 'A' }), farmer({ farmerId: 'f2', name: 'B' })]);
    expect(rows[0][0]).toBe('1');
    expect(rows[1][0]).toBe('2');
  });
});

describe('FARMER_COLUMNS width sums to landscape content width', () => {
  it('sums exactly (drawTable throws otherwise)', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    const total = FARMER_COLUMNS.reduce((s, c) => s + c.width, 0);
    expect(total).toBe(contentW(d));
  });
});

describe('section А table draws every farmer row', () => {
  let drawTextSpy: jest.SpyInstance;
  beforeEach(() => { drawTextSpy = jest.spyOn(PDFPage.prototype, 'drawText'); });
  afterEach(() => { drawTextSpy.mockRestore(); });

  it('draws each farmer\'s name as its own cell text', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    const rows = buildFarmerTableRows([farmer({ name: 'Иван Иванов' }), farmer({ farmerId: 'f2', name: 'Мария Петрова' })]);
    drawTable(d, FARMER_COLUMNS, rows as any);
    expect(drawTextSpy.mock.calls.some(([t]) => t === 'Иван Иванов')).toBe(true);
    expect(drawTextSpy.mock.calls.some(([t]) => t === 'Мария Петрова')).toBe(true);
  });
});

describe('drawFarmerSignatureStrip', () => {
  let drawTextSpy: jest.SpyInstance;
  let drawLineSpy: jest.SpyInstance;
  let drawImageSpy: jest.SpyInstance;
  beforeEach(() => {
    drawTextSpy = jest.spyOn(PDFPage.prototype, 'drawText');
    drawLineSpy = jest.spyOn(PDFPage.prototype, 'drawLine');
    drawImageSpy = jest.spyOn(PDFPage.prototype, 'drawImage');
  });
  afterEach(() => { drawTextSpy.mockRestore(); drawLineSpy.mockRestore(); drawImageSpy.mockRestore(); });

  it('draws a blank line (no image) for a farmer with no saved signature', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    const rows = buildFarmerTableRows([farmer({ name: 'Без подпис' })]);
    const placed = drawTable(d, FARMER_COLUMNS, rows as any);
    drawFarmerSignatureStrip(d, placed, [farmer({ name: 'Без подпис' })], [null]);
    expect(drawImageSpy).not.toHaveBeenCalled();
    expect(drawLineSpy.mock.calls.length).toBeGreaterThan(0);
    expect(drawTextSpy.mock.calls.some(([t]) => typeof t === 'string' && t.startsWith('1.'))).toBe(true);
  });

  it('draws the farmer\'s embedded signature image (no blank line) when one is present', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    const rows = buildFarmerTableRows([farmer({ name: 'С подпис' })]);
    const placed = drawTable(d, FARMER_COLUMNS, rows as any);
    // jest.spyOn calls THROUGH to the real pdf-lib implementation (matches the
    // house convention in pdf-table.spec.ts's own `tinyPng` fixture) — a plain
    // `{} as any` stand-in fails pdf-lib's own argument validation, so this is
    // a real embedded 1x1 PNG, not a fake object.
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const realImage = await d.doc.embedPng(Buffer.from(b64, 'base64'));
    drawFarmerSignatureStrip(d, placed, [farmer({ name: 'С подпис' })], [realImage]);
    expect(drawImageSpy).toHaveBeenCalledTimes(1);
    expect(drawImageSpy.mock.calls[0][0]).toBe(realImage);
  });

  it('labels each slot with its 1-based row number, matching PlacedRow input order', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    const farmers = [farmer({ name: 'A' }), farmer({ farmerId: 'f2', name: 'B' })];
    const rows = buildFarmerTableRows(farmers);
    const placed = drawTable(d, FARMER_COLUMNS, rows as any);
    drawFarmerSignatureStrip(d, placed, farmers, [null, null]);
    expect(drawTextSpy.mock.calls.some(([t]) => typeof t === 'string' && t.startsWith('1. A'))).toBe(true);
    expect(drawTextSpy.mock.calls.some(([t]) => typeof t === 'string' && t.startsWith('2. B'))).toBe(true);
  });
});
