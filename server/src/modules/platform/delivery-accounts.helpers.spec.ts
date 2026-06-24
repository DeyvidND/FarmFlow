import { deliveryCapabilities, buildDeliveryOverview } from './delivery-accounts.helpers';

describe('deliveryCapabilities', () => {
  it('classifies delivery-only', () => {
    expect(deliveryCapabilities({ product: 'econt-standalone', econtApp: { active: true } }))
      .toEqual({ shop: false, delivery: true, active: true, type: 'delivery' });
  });
  it('classifies farm-only (no econtApp)', () => {
    expect(deliveryCapabilities({ delivery: {} }))
      .toEqual({ shop: true, delivery: false, active: false, type: 'farm' });
  });
  it('classifies both (farm + econtApp)', () => {
    expect(deliveryCapabilities({ econtApp: { active: false } }))
      .toEqual({ shop: true, delivery: true, active: false, type: 'both' });
  });
  it('tolerates null/undefined settings', () => {
    expect(deliveryCapabilities(null)).toEqual({ shop: true, delivery: false, active: false, type: 'farm' });
  });
});

describe('buildDeliveryOverview', () => {
  it('folds shipment rows into the overview shape', () => {
    const out = buildDeliveryOverview([
      { carrier: 'econt', codAmountStotinki: 1000, codCollectedAt: null, createdAt: '2026-06-01T10:00:00.000Z' },
      { carrier: 'econt', codAmountStotinki: 500, codCollectedAt: '2026-06-03T10:00:00.000Z', createdAt: '2026-06-02T10:00:00.000Z' },
      { carrier: 'speedy', codAmountStotinki: null, codCollectedAt: null, createdAt: '2026-06-05T10:00:00.000Z' },
    ]);
    expect(out).toEqual({
      total: 3,
      codPendingStotinki: 1000,
      codCollectedStotinki: 500,
      econt: 2,
      speedy: 1,
      lastShipmentAt: '2026-06-05T10:00:00.000Z',
    });
  });
  it('returns zeros for an empty list', () => {
    expect(buildDeliveryOverview([])).toEqual({
      total: 0, codPendingStotinki: 0, codCollectedStotinki: 0, econt: 0, speedy: 0, lastShipmentAt: null,
    });
  });

  it('excludes COD on cancelled/returned/refused shipments from pending', () => {
    const out = buildDeliveryOverview([
      { carrier: 'econt', status: 'shipped', codAmountStotinki: 1000, codCollectedAt: null, createdAt: '2026-06-01T00:00:00.000Z' },
      { carrier: 'econt', status: 'returned', codAmountStotinki: 999, codCollectedAt: null, createdAt: '2026-06-02T00:00:00.000Z' },
      { carrier: 'speedy', status: 'cancelled', codAmountStotinki: 555, codCollectedAt: null, createdAt: '2026-06-03T00:00:00.000Z' },
      { carrier: 'econt', status: 'delivered', codAmountStotinki: 500, codCollectedAt: '2026-06-04T00:00:00.000Z', createdAt: '2026-06-04T00:00:00.000Z' },
    ]);
    expect(out.codPendingStotinki).toBe(1000); // only the live 'shipped' one
    expect(out.codCollectedStotinki).toBe(500);
    expect(out.total).toBe(4);
  });

  it('counts Speedy codSettledAt as collected (Speedy never stamps codCollectedAt)', () => {
    const out = buildDeliveryOverview([
      { carrier: 'speedy', status: 'delivered', codAmountStotinki: 700, codCollectedAt: null, codSettledAt: '2026-06-05T00:00:00.000Z', createdAt: '2026-06-04T00:00:00.000Z' },
    ]);
    expect(out.codCollectedStotinki).toBe(700);
    expect(out.codPendingStotinki).toBe(0);
  });

  it('excludes Econt raw-Bulgarian returned/refused status from pending COD', () => {
    const out = buildDeliveryOverview([
      { carrier: 'econt', status: 'върната', codAmountStotinki: 800, codCollectedAt: null, codSettledAt: null, createdAt: '2026-06-01T00:00:00.000Z' },
      { carrier: 'econt', status: 'отказана', codAmountStotinki: 300, codCollectedAt: null, codSettledAt: null, createdAt: '2026-06-02T00:00:00.000Z' },
      { carrier: 'econt', status: 'разнасяне', codAmountStotinki: 100, codCollectedAt: null, codSettledAt: null, createdAt: '2026-06-03T00:00:00.000Z' },
    ]);
    expect(out.codPendingStotinki).toBe(100); // only the live one
  });
});
