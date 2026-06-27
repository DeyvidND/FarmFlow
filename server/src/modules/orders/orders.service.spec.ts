/**
 * Integration test for OrdersService.create() — carrier persist path.
 *
 * We use preloadedTenant to skip the outer tenant SELECT, then build a minimal
 * DB mock that satisfies all the transaction sub-queries and lets us assert on
 * the values passed to the orders insert.
 */
import { BadRequestException } from '@nestjs/common';
import { OrdersService } from './orders.service';

// Minimal product row that passes the active-product guard.
const PRODUCT = {
  id: 'prod-1',
  tenantId: 'tenant-1',
  name: 'Домати',
  isActive: true,
  priceStotinki: 500,
  promoType: null,
  promoValue: null,
  promoFixedStotinki: null,
  promoEndsAt: null,
};

// A both-carriers delivery config: Econt auto + Speedy configured + econtAddress enabled.
const DELIVERY_CFG = {
  econt: { mode: 'auto' },
  speedy: { configured: true },
  methods: {
    econtAddress: { enabled: true },
    pickup: { enabled: true },
    econtOffice: { enabled: false },
    ownSlots: { enabled: true },
  },
};

const TENANT = {
  id: 'tenant-1',
  farmLat: null,
  farmLng: null,
  subscriptionStatus: 'active',
  settings: { delivery: DELIVERY_CFG },
  deliveryEnabled: true,
};

// The fake order returned by the orders insert.
const FAKE_ORDER = {
  id: 'order-1',
  tenantId: 'tenant-1',
  orderNumber: 1,
  customerName: 'Иван',
  customerPhone: '0888000000',
  customerEmail: null,
  slotId: null,
  status: 'pending',
  totalStotinki: 500,
  deliveryType: 'econt_address',
  carrier: 'speedy',
  deliveryAddress: 'ул. Тест 1',
  deliveryCity: 'София',
  deliveryNote: null,
  econtOffice: null,
  deliveryLat: null,
  deliveryLng: null,
  notes: null,
  stripeCheckoutSessionId: null,
  stripePaymentIntentId: null,
  paidAt: null,
  paymentMethod: 'cod',
  createdAt: new Date(),
};

/**
 * Build a fully-chainable tx select mock that handles every select inside
 * create():
 *  call 1 — products: terminates at .where() → returns [PRODUCT]
 *  call 2 — productsWithVariants existence check: terminates at .where() → returns []
 *  call 3 — availability windows: .where().for().orderBy() → returns []
 *  call 4 — nextNumber: terminates at .where() → returns [{nextNumber:1}]
 *
 * Note: the variantIds branch is never entered because our DTO has no variantId.
 *
 * Each call returns a chain where EVERY terminal method (.where, .orderBy, .limit)
 * resolves to the configured result for that call index.
 */
function makeTxSelect(callResults: Array<unknown[]>) {
  let idx = 0;
  return jest.fn(() => {
    const result: unknown[] = callResults[idx] ?? [];
    idx++;
    const c: any = {};
    c.from = jest.fn(() => c);
    // .where() is thenable (many queries end here); also chainable for further ops.
    const wherePromise = Promise.resolve(result);
    (wherePromise as any).for = jest.fn(() => {
      const c2: any = {};
      c2.orderBy = jest.fn(() => Promise.resolve(result));
      c2.limit = jest.fn(() => Promise.resolve(result));
      return c2;
    });
    (wherePromise as any).limit = jest.fn(() => Promise.resolve(result));
    c.where = jest.fn(() => wherePromise);
    c.limit = jest.fn(() => Promise.resolve(result));
    return c;
  });
}

/**
 * Build a DB mock whose transaction() runs the callback with a tx mock.
 * `valuesCapture` is populated with arguments to insert().values() calls
 * in order (index 0 = orders insert, index 1 = orderItems insert).
 */
function buildDb(valuesCapture: unknown[], tenantDeliveryCfg = DELIVERY_CFG) {
  // tx mock handles all inner DB calls within create()'s transaction block.
  const txMock: any = {
    select: makeTxSelect([
      [PRODUCT],   // 1st: products
      [],          // 2nd: productsWithVariants (no variants for this product)
      [],          // 3rd: availability windows
      [{ nextNumber: 1 }],  // 4th: order number
    ]),
    execute: jest.fn(() => Promise.resolve([])), // pg_advisory_xact_lock
    insert: jest.fn()
      .mockImplementationOnce(() => {
        // 1st insert: orders table
        const c: any = {};
        c.values = jest.fn((v: unknown) => {
          valuesCapture.push(v);
          return c;
        });
        c.returning = jest.fn(() => Promise.resolve([FAKE_ORDER]));
        return c;
      })
      .mockImplementationOnce(() => {
        // 2nd insert: orderItems table
        const c: any = {};
        c.values = jest.fn((v: unknown) => {
          valuesCapture.push(v);
          return c;
        });
        c.returning = jest.fn(() =>
          Promise.resolve([
            {
              id: 'item-1',
              orderId: 'order-1',
              productId: 'prod-1',
              productName: 'Домати',
              quantity: 1,
              priceStotinki: 500,
              variantId: null,
              variantLabel: null,
            },
          ]),
        );
        return c;
      }),
    update: jest.fn(() => {
      const c: any = {};
      c.set = jest.fn(() => c);
      c.where = jest.fn(() => Promise.resolve([]));
      return c;
    }),
  };

  return {
    // Outer DB select (only called when preloadedTenant is NOT supplied).
    select: jest.fn(() => {
      const c: any = {};
      c.from = jest.fn(() => c);
      c.where = jest.fn(() => c);
      c.limit = jest.fn(() =>
        Promise.resolve([
          { ...TENANT, settings: { delivery: tenantDeliveryCfg } },
        ]),
      );
      return c;
    }),
    transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(txMock)),
  };
}

const BASE_DTO = {
  deliveryType: 'econt_address' as const,
  paymentMethod: 'cod' as const,
  customerName: 'Иван',
  customerPhone: '0888000000',
  items: [{ productId: 'prod-1', quantity: 1 }],
  deliveryAddress: 'ул. Тест 1',
  deliveryCity: 'София',
};

describe('OrdersService.create() carrier persist', () => {
  it('persists carrier: speedy when customer picks Speedy on a both-carriers farm', async () => {
    const captured: unknown[] = [];
    const db = buildDb(captured);

    const svc = new OrdersService(
      db as never,
      { geocode: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await svc.create(
      'test-farm',
      { ...BASE_DTO, carrier: 'speedy' } as never,
      TENANT as never,
    );

    const orderValues = captured[0] as Record<string, unknown>;
    expect(orderValues.carrier).toBe('speedy');
    expect(orderValues.deliveryType).toBe('econt_address');
  });

  it('persists carrier: econt when customer picks Econt on a both-carriers farm', async () => {
    const captured: unknown[] = [];
    const db = buildDb(captured);

    const svc = new OrdersService(
      db as never,
      { geocode: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await svc.create(
      'test-farm',
      { ...BASE_DTO, carrier: 'econt' } as never,
      TENANT as never,
    );

    const orderValues = captured[0] as Record<string, unknown>;
    expect(orderValues.carrier).toBe('econt');
  });

  it('defaults carrier to econt when none given and econt mode is auto', async () => {
    const captured: unknown[] = [];
    const db = buildDb(captured);

    const svc = new OrdersService(
      db as never,
      { geocode: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await svc.create(
      'test-farm',
      { ...BASE_DTO } as never, // no carrier field
      TENANT as never,
    );

    const orderValues = captured[0] as Record<string, unknown>;
    expect(orderValues.carrier).toBe('econt');
  });

  it('rejects speedy carrier when farm has no Speedy config', async () => {
    const captured: unknown[] = [];
    const noSpeedy = {
      econt: { mode: 'auto' as const },
      methods: { econtAddress: { enabled: true }, pickup: { enabled: true } },
    };
    const db = buildDb(captured, noSpeedy as any);

    const tenantNoSpeedy = {
      ...TENANT,
      settings: { delivery: noSpeedy },
    };

    const svc = new OrdersService(
      db as never,
      { geocode: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      svc.create(
        'test-farm',
        { ...BASE_DTO, carrier: 'speedy' } as never,
        tenantNoSpeedy as never,
      ),
    ).rejects.toThrow(BadRequestException);
  });
});
