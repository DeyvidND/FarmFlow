import { PDFPage } from 'pdf-lib';
import { A4_LANDSCAPE, contentW, createDoc } from './pdf-kit';
import { drawTable } from './pdf-table';
import {
  buildFarmerTableRows, buildOrderTableRows, drawFarmerSignatureStrip, FARMER_COLUMNS, ORDER_COLUMNS, PRIVACY_NOTE,
  renderConsolidatedProtocolPdf,
} from './consolidated-pdf';
import type { ConsolidatedFarmerRow, ConsolidatedOrderRow } from './consolidated-protocol.service';

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

describe('buildOrderTableRows (pure)', () => {
  const order = (over: Partial<ConsolidatedOrderRow> = {}): ConsolidatedOrderRow => ({
    orderId: 'o1', orderNumber: 5, customerCode: 'ABCD1234', cityOrZone: 'Варна',
    items: [{ productName: 'Домати', quantity: 2, unit: 'кг', priceStotinki: 300 } as any],
    totalStotinki: 600, ...over,
  });

  it('never includes a customer name, phone, or exact address — only order №, code, and city/zone', () => {
    const rows = buildOrderTableRows([order()]);
    const flat = rows[0].join(' | ');
    expect(flat).not.toMatch(/бул\.|ул\.|жк\./); // no street-level address fragments
    expect(flat).toContain('5'); // order number
    expect(flat).toContain('ABCD1234'); // customer code
    expect(flat).toContain('Варна'); // city/zone only
  });

  it('shows an em-dash when cityOrZone is unknown, never a blank cell', () => {
    const rows = buildOrderTableRows([order({ cityOrZone: null })]);
    expect(rows[0]).toContain('—');
  });

  // Bulgaria has been on the euro since 2026 — a „лв." here was the bug Vasil
  // photographed. Same "12,34 €" shape as the panel's formatMoney.
  it('formats the Стойност cell as EUR („6,00 €"), never лв.', () => {
    const rows = buildOrderTableRows([order({ totalStotinki: 600 })]);
    expect(rows[0][4]).toBe('6,00 €');
    expect(rows[0].join(' ')).not.toContain('лв');
  });
});

describe('ORDER_COLUMNS width sums to landscape content width', () => {
  it('sums exactly', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    expect(ORDER_COLUMNS.reduce((s, c) => s + c.width, 0)).toBe(contentW(d));
  });
});

describe('PRIVACY_NOTE', () => {
  it('states the customer PII stays in the protected route list — the exact spec §3.7 disclosure', () => {
    expect(PRIVACY_NOTE).toMatch(/маршрутен списък/);
  });
});

describe('renderConsolidatedProtocolPdf', () => {
  // Loosely-typed fixture (cast at each call site) — mirrors the `as any` cast
  // consolidated-protocol.service.spec.ts's own PDF_VIEW fixture uses; a real
  // ConsolidatedProtocolView is fully specified elsewhere (getView's tests),
  // this file only needs a shape rich enough for the renderer.
  const view = (over: Partial<any> = {}): any => ({
    id: 'cp1', scope: 'day', legIndex: null, date: '2026-07-22', docNumber: 7, status: 'draft',
    meta: { vehicle: 'Форд Транзит', plate: 'В1234АВ', driverName: 'Георги', startPlace: 'Складова база', startTime: '06:00', plannedEnd: '11:00' },
    overrides: {}, rows: { farmers: [], orders: [] }, receiverSignaturePng: null, signedAt: null,
    ...over,
  });

  it('produces a non-empty PDF for a day-scope protocol with no rows', async () => {
    const buf = await renderConsolidatedProtocolPdf(view(), 'ФермериБГ');
    expect(buf.length).toBeGreaterThan(0);
  });

  it('titles a leg-scope protocol with its 1-based leg number', async () => {
    const spy = jest.spyOn(PDFPage.prototype, 'drawText');
    await renderConsolidatedProtocolPdf(view({ scope: 'leg', legIndex: 1 }), 'ФермериБГ');
    expect(spy.mock.calls.some(([t]) => typeof t === 'string' && t.includes('ЛЕГ 2'))).toBe(true);
    spy.mockRestore();
  });

  it('prints the ОБ- prefixed doc number, not the bilateral series\' bare number', async () => {
    const spy = jest.spyOn(PDFPage.prototype, 'drawText');
    await renderConsolidatedProtocolPdf(view({ docNumber: 42 }), 'ФермериБГ');
    expect(spy.mock.calls.some(([t]) => t === '№ ОБ-42')).toBe(true);
    spy.mockRestore();
  });

  it('marks a DRAFT protocol as a draft in the subtitle, and a SIGNED one carries none', async () => {
    const draftSpy = jest.spyOn(PDFPage.prototype, 'drawText');
    await renderConsolidatedProtocolPdf(view({ status: 'draft' }), 'ФермериБГ');
    expect(draftSpy.mock.calls.some(([t]) => typeof t === 'string' && t.includes('чернова'))).toBe(true);
    draftSpy.mockRestore();

    const signedSpy = jest.spyOn(PDFPage.prototype, 'drawText');
    await renderConsolidatedProtocolPdf(view({ status: 'signed' }), 'ФермериБГ');
    expect(signedSpy.mock.calls.some(([t]) => typeof t === 'string' && t.includes('чернова'))).toBe(false);
    signedSpy.mockRestore();
  });

  it('draws section В\'s manual meta fields (vehicle, plate, driver, timing)', async () => {
    const spy = jest.spyOn(PDFPage.prototype, 'drawText');
    await renderConsolidatedProtocolPdf(view(), 'ФермериБГ');
    const flat = spy.mock.calls.map(([t]) => t).join(' ');
    expect(flat).toContain('Форд Транзит');
    expect(flat).toContain('В1234АВ');
    expect(flat).toContain('Георги');
    spy.mockRestore();
  });

  // The edit form blur-saves per field, so a blurred-but-untouched input can
  // persist '' — that must print the same „—" as an absent key, not vanish.
  it('renders an empty-string meta value as „—", exactly like an absent key', async () => {
    const spy = jest.spyOn(PDFPage.prototype, 'drawText');
    await renderConsolidatedProtocolPdf(view({ meta: { vehicle: '', plate: '  ', driverName: '' } }), 'ФермериБГ');
    const flat = spy.mock.calls.map(([t]) => t).join(' ');
    expect(flat).toContain('Возило: —');
    expect(flat).toContain('Рег. №: —');
    expect(flat).toContain('Приел за транспорт: ______________________');
    spy.mockRestore();
  });

  // Draws a real order row end-to-end so the euro sign passes through the
  // embedded DejaVuSans font (encode + width measurement) — a font without the
  // € glyph would throw here, not just render wrong.
  it('draws an order row\'s EUR total through the real embedded font', async () => {
    const spy = jest.spyOn(PDFPage.prototype, 'drawText');
    const rows = {
      farmers: [],
      orders: [{ orderId: 'o1', orderNumber: 5, customerCode: 'ABCD1234', cityOrZone: 'Варна', items: [], totalStotinki: 1234 }],
    };
    await renderConsolidatedProtocolPdf(view({ rows }), 'ФермериБГ');
    expect(spy.mock.calls.some(([t]) => t === '12,34 €')).toBe(true);
    spy.mockRestore();
  });

  it('embeds the receiver signature image when present', async () => {
    const imgSpy = jest.spyOn(PDFPage.prototype, 'drawImage');
    // A genuinely malformed PNG (e.g. `Buffer.from('fake')`) throws inside
    // embedPng and is silently swallowed by the try/catch — that would only
    // exercise the fallback path, never proving the image actually draws. Use
    // a real tiny base64 PNG fixture (same one pdf-table.spec.ts/Task 8 use)
    // so embedPng genuinely succeeds and drawImage is genuinely called.
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    await renderConsolidatedProtocolPdf(view({ receiverSignaturePng: `data:image/png;base64,${b64}` }), 'ФермериБГ');
    expect(imgSpy).toHaveBeenCalledTimes(1);
    imgSpy.mockRestore();
  });
});
