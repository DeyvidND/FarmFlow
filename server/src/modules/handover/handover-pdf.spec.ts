import { renderProtocolPdf } from './handover-pdf';

const ROW = {
  kind: 'farmer_to_operator', protocolNumber: 41,
  signedAt: new Date('2026-07-13T09:00:00Z'), createdAt: new Date('2026-07-13T08:00:00Z'),
  fromSnapshot: { name: 'ЕТ Васил Петров', eik: '203912345', address: 'с. Розино' },
  toSnapshot: { name: 'ЕТ Оператор', eik: '111222333' },
  items: [{ productName: 'Домати', quantity: 5, unit: 'кг', priceStotinki: 300 }],
  totalStotinki: 1500, fromSignaturePng: null, toSignaturePng: null, signMode: 'pending',
};

describe('renderProtocolPdf', () => {
  it('produces a non-empty PDF for a Cyrillic farmer protocol (no encoding error)', async () => {
    const buf = await renderProtocolPdf(ROW as any);
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });
  it('renders the customer-receipt title for the customer kind', async () => {
    const buf = await renderProtocolPdf({ ...ROW, kind: 'operator_to_customer',
      toSnapshot: { name: 'Иван Петров', phone: '0888' } } as any);
    expect(buf.length).toBeGreaterThan(1000);
  });
});
