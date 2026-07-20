import { HandoverService } from './handover.service';

/** A db that throws on ANY property access — proves the ctx path issues zero queries. */
const throwingDb: any = new Proxy(
  {},
  { get() { throw new Error('DB accessed — the preloaded-ctx draft path must not query'); } },
);

function makeCtx(over: Record<string, unknown> = {}): any {
  return {
    operatorLegal: { name: 'Оператор ООД' },
    farmerLegalById: new Map([['f1', { legal: { name: 'Ферма Х' }, name: 'Ферма Х' }]]),
    farmerItemsByKey: new Map([
      [
        'f1␟s1',
        [
          { productName: 'Домати', variantLabel: '1кг', quantity: 2, unit: 'кг', priceStotinki: 300, orderNumber: 5 },
          { productName: 'Домати', variantLabel: '1кг', quantity: 3, unit: 'кг', priceStotinki: 300, orderNumber: 6 },
        ],
      ],
    ]),
    customerOrderById: new Map([
      ['o1', { customerName: 'Иван', customerPhone: '0888', deliveryAddress: 'ул. 1', totalStotinki: 1200, orderNumber: 7 }],
    ]),
    customerItemsByOrderId: new Map([
      ['o1', [{ productName: 'Мед', variantLabel: null, quantity: 1, priceStotinki: 1200, unit: 'бр', name: 'Мед' }]],
    ]),
    ...over,
  };
}

describe('HandoverService.buildDraft with a preloaded context (no per-target queries)', () => {
  const svc: any = new HandoverService(throwingDb);

  it('farmer leg: builds the draft purely from ctx, aggregating items, issuing zero DB queries', async () => {
    const draft = await svc.buildDraft('t1', { kind: 'farmer_to_operator', farmerId: 'f1', slotId: 's1' }, makeCtx());
    expect((draft.from as any).name).toBe('Ферма Х'); // resolveParty(farmer legal)
    expect((draft.to as any).name).toBe('Оператор ООД'); // operatorLegal straight from ctx
    // 2 + 3 = 5 of the same (product, variant) key; per-line orderNumber dropped on aggregate.
    expect(draft.items).toEqual([
      { productName: 'Домати', variantLabel: '1кг', quantity: 5, unit: 'кг', priceStotinki: 300, orderNumber: undefined },
    ]);
    expect(draft.total).toBe(5 * 300);
    expect(draft.orderNumbers).toEqual([5, 6]);
  });

  it('customer leg: builds the draft purely from ctx, issuing zero DB queries', async () => {
    const draft = await svc.buildDraft('t1', { kind: 'operator_to_customer', orderId: 'o1' }, makeCtx());
    expect((draft.from as any).name).toBe('Оператор ООД');
    expect(draft.to).toEqual({ name: 'Иван', phone: '0888', address: 'ул. 1' });
    expect(draft.items).toEqual([
      { productName: 'Мед', variantLabel: undefined, quantity: 1, priceStotinki: 1200, unit: 'бр' },
    ]);
    expect(draft.total).toBe(1200);
    expect(draft.orderNumbers).toEqual([7]);
  });

  it('customer leg: an order missing from ctx still 404s (behaviour preserved)', async () => {
    await expect(
      svc.buildDraft('t1', { kind: 'operator_to_customer', orderId: 'missing' }, makeCtx()),
    ).rejects.toThrow();
  });
});
