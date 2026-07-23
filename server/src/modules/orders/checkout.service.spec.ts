import { CheckoutService } from './checkout.service';

/**
 * Chainable Drizzle mock — builder methods return `this`; terminal `.limit()`
 * resolves arrays the test queues with `mockResolvedValueOnce`.
 */
function makeDb() {
  const db: any = {};
  const chain = () => db;
  db.select = jest.fn(chain);
  db.from = jest.fn(chain);
  db.where = jest.fn(chain);
  db.update = jest.fn(chain);
  db.set = jest.fn(chain);
  db.limit = jest.fn().mockResolvedValue([]);
  return db;
}

const cfg = (over: Record<string, any> = {}) => ({
  get: (k: string, d?: any) => (k in over ? over[k] : d),
});

function makeOrder(over: Record<string, any> = {}) {
  return {
    id: 'order-1',
    tenantId: 'tenant-1',
    totalStotinki: 1000,
    paymentMethod: 'online',
    deliveryType: 'pickup',
    econtOffice: null,
    deliveryAddress: null,
    deliveryCity: null,
    customerName: 'X',
    customerPhone: 'Y',
    customerEmail: null,
    items: [{ productName: 'P', priceStotinki: 1000, quantity: 1 }],
    ...over,
  };
}

function build(order: any, opts: { canCard?: boolean; speedy?: any; courierOrders?: any[] } = {}) {
  const db = makeDb();
  const ordersService = {
    create: jest.fn().mockResolvedValue(order),
    createCourierOrders: jest.fn().mockResolvedValue(opts.courierOrders ?? []),
  };
  const stripe = {
    isEnabledForAccount: jest.fn().mockReturnValue(opts.canCard ?? false),
    createCheckoutSession: jest
      .fn()
      .mockResolvedValue({ checkoutUrl: 'https://stripe/cs', checkoutSessionId: 'cs_1' }),
  };
  const econt = { estimateShipping: jest.fn().mockResolvedValue(null) };
  const speedy = opts.speedy ?? { searchSites: jest.fn().mockResolvedValue([]), estimateShipping: jest.fn().mockResolvedValue(null) };
  // The buyer's ONE mail (received + разписка PDF) is queued, not sent inline.
  const protocolEmail = { enqueueProtocolEmail: jest.fn().mockResolvedValue(undefined) };
  const analytics = { recordPurchase: jest.fn().mockResolvedValue(undefined) };
  const svc = new CheckoutService(
    db as never,
    ordersService as never,
    stripe as never,
    econt as never,
    speedy as never,
    cfg({ STOREFRONT_URL: 'https://shop' }) as never,
    analytics as never,
    protocolEmail as never,
  );
  return { svc, db, ordersService, stripe, econt, speedy, protocolEmail, analytics };
}

const dto = (over: Record<string, any> = {}) =>
  ({ items: [{ productId: 'p', quantity: 1 }], paymentMethod: 'online', ...over } as never);

describe('CheckoutService.placeOrder (bare /orders path)', () => {
  it('pickup → no shipping, total unchanged, no Stripe session', async () => {
    const { svc, db } = build(makeOrder({ deliveryType: 'pickup' }));
    const out = await svc.placeOrder('slug', dto({ deliveryType: 'pickup' }));
    expect(out.totalStotinki).toBe(1000);
    expect(db.update).not.toHaveBeenCalled(); // grandTotal === subtotal
  });

  it('address → shipping folded into the recorded total', async () => {
    const { svc, db } = build(makeOrder({ deliveryType: 'address' }));
    // loadDelivery → tenant settings row (empty delivery cfg → default 490 fee)
    db.limit.mockResolvedValueOnce([{ settings: { delivery: {} } }]);
    const out = await svc.placeOrder('slug', dto({ deliveryType: 'address' }));
    expect(out.totalStotinki).toBe(1490); // 1000 subtotal + 490 default address fee
    expect(db.update).toHaveBeenCalled();
  });
});

describe('CheckoutService.create (Stripe path)', () => {
  it('COD → no Stripe session, payment normalized to cod, purchase recorded', async () => {
    const { svc, db, stripe, analytics } = build(makeOrder({ paymentMethod: 'online' }), { canCard: true });
    db.limit.mockResolvedValueOnce([{ stripeAccountId: 'acct' }]); // tenant lookup
    const out = await svc.create('slug', dto({ paymentMethod: 'cod' }), '1.2.3.4', 'Mozilla/5.0');
    expect(out.checkoutUrl).toBeNull();
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
    expect(db.update).toHaveBeenCalled(); // online → cod normalization
    // COD has no payment gate — the purchase is recorded at intake, not later.
    expect(analytics.recordPurchase).toHaveBeenCalledTimes(1);
    expect(analytics.recordPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', orderId: 'order-1', valueStotinki: 1000 }),
    );
  });

  it('no-card farm → cash path even when online chosen, purchase recorded', async () => {
    const { svc, db, stripe, analytics } = build(makeOrder({ paymentMethod: 'online' }), { canCard: false });
    db.limit.mockResolvedValueOnce([{ stripeAccountId: null }]);
    const out = await svc.create('slug', dto({ paymentMethod: 'online' }), '1.2.3.4', 'Mozilla/5.0');
    expect(out.checkoutUrl).toBeNull();
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
    expect(analytics.recordPurchase).toHaveBeenCalledTimes(1);
  });

  it('card farm + online → opens a Stripe Checkout session, no purchase emit here', async () => {
    const { svc, db, stripe, analytics } = build(makeOrder({ paymentMethod: 'online' }), { canCard: true });
    // Card requires a linked account that can actually charge (onboarding complete).
    db.limit.mockResolvedValueOnce([{ stripeAccountId: 'acct', stripeChargesEnabled: true }]);
    const out = await svc.create('slug', dto({ paymentMethod: 'online' }), '1.2.3.4', 'Mozilla/5.0');
    expect(out.checkoutUrl).toBe('https://stripe/cs');
    expect(stripe.createCheckoutSession).toHaveBeenCalledTimes(1);
    expect(db.update).toHaveBeenCalled(); // persists stripeCheckoutSessionId
    // Online path only records the purchase later, from Stripe's markOrderPaid.
    expect(analytics.recordPurchase).not.toHaveBeenCalled();
  });

  it('linked Stripe but onboarding incomplete (charges off) → cash path, no session', async () => {
    // isEnabledForAccount is true (account linked) but charges_enabled is false, so
    // the farm cannot actually take cards yet — online must fall back to COD.
    const { svc, db, stripe, analytics } = build(makeOrder({ paymentMethod: 'online' }), { canCard: true });
    db.limit.mockResolvedValueOnce([{ stripeAccountId: 'acct', stripeChargesEnabled: false }]);
    const out = await svc.create('slug', dto({ paymentMethod: 'online' }), '1.2.3.4', 'Mozilla/5.0');
    expect(out.checkoutUrl).toBeNull();
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
    expect(analytics.recordPurchase).toHaveBeenCalledTimes(1); // fell back to COD
  });
});

/** Shared delivery cfg used across Speedy shippingStotinki tests.
 *  No `methods` key → econtFallbackFee falls back to DELIVERY_DEFAULTS:
 *    econtAddressFeeStotinki = 590 (door=true)
 *  freeThresholdStotinki = 0 → free-threshold never fires. */
const speedyCfg = { econt: { mode: 'auto' }, speedy: { configured: true }, pricing: { freeThresholdStotinki: 0 } } as const;

/** Canonical Speedy door order passed to shippingStotinki in these tests. */
function speedyOrder(over: Record<string, any> = {}) {
  return {
    tenantId: 't1', deliveryType: 'econt_address', carrier: 'speedy',
    customerName: 'x', customerPhone: 'y', econtOffice: null,
    deliveryAddress: 'ул', deliveryCity: 'Варна',
    paymentMethod: 'cod', totalStotinki: 5000,
    items: [{ productName: 'p', quantity: 1 }],
    ...over,
  };
}

describe('CheckoutService.shippingStotinki (Speedy door path)', () => {
  it('prices a Speedy door order via the Speedy estimate (COD-aware)', async () => {
    const speedyStub = {
      searchSites: jest.fn().mockResolvedValue([{ id: 100 }]),
      estimateShipping: jest.fn().mockResolvedValue(420),
    };
    const { svc } = build(makeOrder(), { speedy: speedyStub });
    const fee = await (svc as any).shippingStotinki(speedyOrder(), 3000, speedyCfg);
    // 3rd arg is the per-call memo Map quoteSpeedyDoor threads through (see B1) —
    // shared with searchSites, not asserted structurally, just that one was passed.
    expect(speedyStub.estimateShipping).toHaveBeenCalledWith(
      't1',
      { siteId: 100, weightGrams: undefined, codAmountStotinki: 5000 },
      expect.any(Map),
    );
    expect(fee).toBe(420);
  });

  it('estimateShipping returns null → falls back to econtFallbackFee (door = 590)', async () => {
    const speedyStub = {
      searchSites: jest.fn().mockResolvedValue([{ id: 100 }]),
      estimateShipping: jest.fn().mockResolvedValue(null),
    };
    const { svc } = build(makeOrder(), { speedy: speedyStub });
    const fee = await (svc as any).shippingStotinki(speedyOrder(), 3000, speedyCfg);
    // null live → econtFallbackFee(cfg, true) → DELIVERY_DEFAULTS.econtAddressFeeStotinki = 590
    expect(fee).toBe(590);
    expect(speedyStub.estimateShipping).toHaveBeenCalledTimes(1);
  });

  it('searchSites returns [] (no siteId) → estimateShipping not called, fee = fallback 590', async () => {
    const speedyStub = {
      searchSites: jest.fn().mockResolvedValue([]),
      estimateShipping: jest.fn(),
    };
    const { svc } = build(makeOrder(), { speedy: speedyStub });
    const fee = await (svc as any).shippingStotinki(speedyOrder(), 3000, speedyCfg);
    expect(speedyStub.estimateShipping).not.toHaveBeenCalled();
    expect(fee).toBe(590);
  });

  it('searchSites throws → warn logged, estimateShipping not reached, fee = fallback 590', async () => {
    const speedyStub = {
      searchSites: jest.fn().mockRejectedValue(new Error('timeout')),
      estimateShipping: jest.fn(),
    };
    const { svc } = build(makeOrder(), { speedy: speedyStub });
    const warnSpy = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
    const fee = await (svc as any).shippingStotinki(speedyOrder(), 3000, speedyCfg);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[speedy]'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('timeout'));
    expect(speedyStub.estimateShipping).not.toHaveBeenCalled();
    expect(fee).toBe(590);
  });
});

/** cheapest-policy cfg: both carriers live, server prices both and ships the cheaper. */
const cheapestCfg = {
  econt: { mode: 'auto' },
  speedy: { configured: true },
  pricing: { freeThresholdStotinki: 0 },
  carrierPolicy: 'cheapest',
} as const;

describe('CheckoutService.shippingStotinki (cheapest policy → picks + persists cheaper carrier)', () => {
  it('Speedy cheaper → carrier persisted to speedy, fee = speedy price', async () => {
    const speedyStub = {
      searchSites: jest.fn().mockResolvedValue([{ id: 100 }]),
      estimateShipping: jest.fn().mockResolvedValue(420),
    };
    const { svc, db, econt } = build(makeOrder(), { speedy: speedyStub });
    (econt.estimateShipping as jest.Mock).mockResolvedValue(500); // econt dearer
    const order = speedyOrder({ id: 'order-9', carrier: null });
    const fee = await (svc as any).shippingStotinki(order, 3000, cheapestCfg);
    expect(fee).toBe(420);
    expect(order.carrier).toBe('speedy'); // mutated for the rest of checkout
    expect(db.set).toHaveBeenCalledWith({ carrier: 'speedy' }); // persisted for fulfillment
  });

  it('Econt cheaper (and tie) → carrier persisted to econt, fee = econt price', async () => {
    const speedyStub = {
      searchSites: jest.fn().mockResolvedValue([{ id: 100 }]),
      estimateShipping: jest.fn().mockResolvedValue(500), // speedy dearer
    };
    const { svc, db, econt } = build(makeOrder(), { speedy: speedyStub });
    (econt.estimateShipping as jest.Mock).mockResolvedValue(420);
    const order = speedyOrder({ id: 'order-10', carrier: null });
    const fee = await (svc as any).shippingStotinki(order, 3000, cheapestCfg);
    expect(fee).toBe(420);
    expect(order.carrier).toBe('econt');
    expect(db.set).toHaveBeenCalledWith({ carrier: 'econt' });
  });

  it('neither carrier prices → falls through to the normal path (no carrier persisted)', async () => {
    const speedyStub = {
      searchSites: jest.fn().mockResolvedValue([]), // speedy unavailable
      estimateShipping: jest.fn(),
    };
    const { svc, db, econt } = build(makeOrder(), { speedy: speedyStub });
    (econt.estimateShipping as jest.Mock).mockResolvedValue(null); // econt unavailable
    const order = speedyOrder({ id: 'order-11', carrier: null });
    const fee = await (svc as any).shippingStotinki(order, 3000, cheapestCfg);
    // Both legs null → pickCheaper returns null → normal econt path → fallback 590.
    expect(fee).toBe(590);
    expect(order.carrier).toBeNull();
    expect(db.set).not.toHaveBeenCalled();
  });
});

describe('CheckoutService.create (courier split)', () => {
  const courierLegs = [
    { id: 'o1', tenantId: 'tenant-1', orderNumber: 7, farmerId: 'fA', farmerName: 'Ферма А', totalStotinki: 1300, items: [] },
    { id: 'o2', tenantId: 'tenant-1', orderNumber: 8, farmerId: 'fB', farmerName: 'Ферма Б', totalStotinki: 500, items: [] },
  ] as any[];

  it('delivery_type=courier → splits into N legs, no Stripe, no single-order intake, one purchase emit', async () => {
    const { svc, db, ordersService, stripe, protocolEmail, analytics } = build(
      makeOrder(),
      { courierOrders: courierLegs },
    );
    db.limit.mockResolvedValueOnce([{ id: 'tenant-1' }]); // tenant id lookup for the visitor hash

    const out = await svc.create('slug', dto({ deliveryType: 'courier', paymentMethod: 'cod' }), '1.2.3.4', 'Mozilla/5.0');

    // Returns the first order id + null checkoutUrl + 2 mapped legs.
    expect(out.orderId).toBe('o1');
    expect(out.checkoutUrl).toBeNull();
    expect(out.orders).toHaveLength(2);
    expect(out.orders![0]).toEqual({
      orderId: 'o1', orderNumber: 7, farmerId: 'fA', farmerName: 'Ферма А', totalStotinki: 1300,
    });
    expect(out.orders![1]).toEqual({
      orderId: 'o2', orderNumber: 8, farmerId: 'fB', farmerName: 'Ферма Б', totalStotinki: 500,
    });
    // One purchase event for the whole split, summed value, first leg's id.
    expect(analytics.recordPurchase).toHaveBeenCalledTimes(1);
    expect(analytics.recordPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', orderId: 'o1', valueStotinki: 1800 }),
    );

    // The single-order intake path must NOT have been called.
    expect((ordersService as any).create).not.toHaveBeenCalled();
    // Stripe session must NOT have been opened.
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
    // The single received+разписка mail queued for each leg.
    expect(protocolEmail.enqueueProtocolEmail).toHaveBeenCalledWith('tenant-1', 'o1');
    expect(protocolEmail.enqueueProtocolEmail).toHaveBeenCalledWith('tenant-1', 'o2');
  });
});

describe('CheckoutService.shippingStotinki (raw courier price, no markup)', () => {
  const courierCfg = {
    econt: { mode: 'auto' },
    speedy: { configured: true },
    pricing: { freeThresholdStotinki: 0 },
  } as const;

  it('charges the live Speedy door quote as-is', async () => {
    const speedyStub = {
      searchSites: jest.fn().mockResolvedValue([{ id: 100 }]),
      estimateShipping: jest.fn().mockResolvedValue(420),
    };
    const { svc } = build(makeOrder(), { speedy: speedyStub });
    const fee = await (svc as any).shippingStotinki(speedyOrder(), 3000, courierCfg);
    expect(fee).toBe(420); // raw live quote, no markup
  });

  it('charges the flat fallback as-is when the carrier is unreachable', async () => {
    const speedyStub = { searchSites: jest.fn().mockResolvedValue([]), estimateShipping: jest.fn() };
    const { svc } = build(makeOrder(), { speedy: speedyStub });
    const fee = await (svc as any).shippingStotinki(speedyOrder(), 3000, courierCfg);
    expect(fee).toBe(590); // raw fallback, no markup
  });

  it('free-over threshold still zeroes the raw courier fee', async () => {
    const speedyStub = {
      searchSites: jest.fn().mockResolvedValue([{ id: 100 }]),
      estimateShipping: jest.fn().mockResolvedValue(420),
    };
    const { svc } = build(makeOrder(), { speedy: speedyStub });
    const cfg = { ...courierCfg, pricing: { freeThresholdStotinki: 2000 } };
    const fee = await (svc as any).shippingStotinki(speedyOrder(), 3000, cfg); // subtotal 3000 ≥ 2000
    expect(fee).toBe(0);
  });
});
