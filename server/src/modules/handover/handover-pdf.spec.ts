import { readFileSync } from 'fs';
import { join } from 'path';
import { PDFDocument } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { CONTENT_W, composeProtocol, descriptor, renderProtocolPdf, wrap } from './handover-pdf';

const ROW = {
  kind: 'farmer_to_operator', protocolNumber: 41,
  signedAt: new Date('2026-07-13T09:00:00Z'), createdAt: new Date('2026-07-13T08:00:00Z'),
  fromSnapshot: { name: 'ЕТ Васил Петров', eik: '203912345', address: 'с. Розино' },
  toSnapshot: { name: 'ЕТ Оператор', eik: '111222333' },
  items: [{ productName: 'Домати', quantity: 5, unit: 'кг', priceStotinki: 300 }],
  totalStotinki: 1500, fromSignaturePng: null, toSignaturePng: null, signMode: 'pending',
};

const isPdf = (buf: Buffer) => buf.length > 1000 && buf.subarray(0, 5).toString() === '%PDF-';

describe('composeProtocol (pure text)', () => {
  it('builds the farmer protocol prose, items and footer', () => {
    const t = composeProtocol(ROW);
    expect(t.title).toBe('ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ');
    expect(t.number).toBe('№ 41');
    expect(t.sentence).toContain('13.07.2026 г.');
    expect(t.sentence).toContain('ЕТ Васил Петров (ЕИК 203912345), адрес с. Розино предаде на');
    expect(t.sentence).toContain('ЕТ Оператор (ЕИК 111222333)');
    expect(t.sentence).toContain('във връзка с доставка на селскостопанска продукция, долуописаните стоки:');
    expect(t.itemLines).toEqual(['1. Домати — 5 кг']);
    expect(t.footer).toBe('Настоящият протокол се състави в два еднообразни екземпляра — по един за всяка страна.');
    expect(t.fromName).toBe('ЕТ Васил Петров');
    expect(t.toName).toBe('ЕТ Оператор');
  });

  it('dates the protocol in Europe/Sofia even when the process runs UTC (as prod does)', () => {
    // The suite runs UTC (see test/set-tz.ts) because prod and CI do, while dev
    // machines here run Europe/Sofia — where the local-getter bug produced the
    // right answer and hid. 2026-07-16T22:30:00Z is 01:30 on the 17th in Sofia
    // (EEST, UTC+3): the протокол is a legal document and must carry the date it
    // was actually signed.
    const t = composeProtocol({ ...ROW, signedAt: new Date('2026-07-16T22:30:00Z') });
    expect(t.sentence).toContain('17.07.2026 г.');
    expect(t.sentence).not.toContain('16.07.2026 г.');
  });

  it('folds meta.orderNumbers into the farmer reason line', () => {
    const t = composeProtocol({ ...ROW, meta: { orderNumbers: [1041, 1042] } });
    expect(t.sentence).toContain('по поръчки № 1041, 1042');
  });

  it('omits the order-number fragment when meta is absent (back-compat)', () => {
    const t = composeProtocol(ROW);
    expect(t.sentence).not.toContain('поръчк');
    expect(t.sentence).toContain('във връзка с доставка на селскостопанска продукция,');
  });

  it('uses the receipt title, customer-without-id and single-order wording for the customer leg', () => {
    const t = composeProtocol({
      ...ROW, kind: 'operator_to_customer', protocolNumber: 42,
      toSnapshot: { name: 'Иван Петров', phone: '0888', address: 'гр. Русе, ул. Клиент 5' },
      meta: { orderNumbers: [1041] },
    });
    expect(t.title).toBe('РАЗПИСКА ЗА ПОЛУЧЕНА СТОКА');
    // Customer (to) carries no legal id: name → address → straight to the reason, no „(ЕИК …)".
    expect(t.sentence).toContain('предаде на Иван Петров, адрес гр. Русе, ул. Клиент 5, във връзка с поръчка № 1041');
    expect(t.sentence).toContain('във връзка с поръчка № 1041');
    expect(t.footer).toContain('Настоящата разписка');
  });

  it('renders a variant label and no number for an unsaved preview row', () => {
    const t = composeProtocol({
      ...ROW, protocolNumber: null,
      items: [{ productName: 'Яйца', variantLabel: 'размер L', quantity: 30, unit: 'бр', priceStotinki: 55 }],
    });
    expect(t.number).toBeNull();
    expect(t.itemLines).toEqual(['1. Яйца · размер L — 30 бр']);
  });
});

describe('descriptor', () => {
  it('prefers ЕИК, then рег.№, and appends the address', () => {
    expect(descriptor({ name: 'Ф', eik: '123', regNo: '9', address: 'ул. 1' }, true)).toBe('Ф (ЕИК 123), адрес ул. 1');
    expect(descriptor({ name: 'Ф', regNo: '9' }, true)).toBe('Ф (рег.№ 9)');
    expect(descriptor({ name: 'Клиент', eik: '123', address: 'ул. 1' }, false)).toBe('Клиент, адрес ул. 1');
  });
});

describe('wrap keeps every line inside the content width', () => {
  it('never emits a line wider than CONTENT_W', async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(readFileSync(join(__dirname, '..', '..', 'assets', 'fonts', 'DejaVuSans.ttf')));
    const t = composeProtocol({
      ...ROW,
      fromSnapshot: { name: '„Земеделска кооперация Слънчоглед и партньори" ООД', eik: '205012345', address: 'гр. Русе, бул. Липник 123, ет. 4, ап. 5' },
      meta: { orderNumbers: [1041, 1042, 1043, 1044, 1045] },
    });
    for (const line of wrap(t.sentence, font, 11, CONTENT_W)) {
      expect(font.widthOfTextAtSize(line, 11)).toBeLessThanOrEqual(CONTENT_W);
    }
  });
});

describe('renderProtocolPdf', () => {
  it('produces a non-empty PDF for a Cyrillic farmer protocol (no encoding error)', async () => {
    expect(isPdf(await renderProtocolPdf(ROW as any))).toBe(true);
  });

  it('renders the customer receipt with order numbers', async () => {
    const buf = await renderProtocolPdf({ ...ROW, kind: 'operator_to_customer',
      toSnapshot: { name: 'Иван Петров', phone: '0888', address: 'гр. Русе, ул. Клиент 5' },
      meta: { orderNumbers: [1041] } } as any);
    expect(isPdf(buf)).toBe(true);
  });

  it('renders a row with no meta (order-number fragment omitted — back-compat)', async () => {
    const { meta, ...noMeta } = { ...ROW } as any;
    expect(isPdf(await renderProtocolPdf(noMeta))).toBe(true);
  });

  it('falls back to a blank signature line when fromSignaturePng is malformed (no crash)', async () => {
    expect(isPdf(await renderProtocolPdf({ ...ROW, fromSignaturePng: 'not-a-real-data-uri' } as any))).toBe(true);
  });
});
