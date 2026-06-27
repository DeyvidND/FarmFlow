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

function build(order: any, opts: { canCard?: boolean; speedy?: any } = {}) {
  const db = makeDb();
  const ordersService = { create: jest.fn().mockResolvedValue(order) };
  const stripe = {
    isEnabledForAccount: jest.fn().mockReturnValue(opts.canCard ?? false),
    createCheckoutSession: jest
      .fn()
      .mockResolvedValue({ checkoutUrl: 'https://stripe/cs', checkoutSessionId: 'cs_1' }),
  };
  const econt = { estimateShipping: jest.fn().mockResolvedValue(null) };
  const speedy = opts.speedy ?? { searchSites: jest.fn().mockResolvedValue([]), estimateShipping: jest.fn().mockResolvedValue(null) };
  const orderConfirmation = { sendReceived: jest.fn().mockResolvedValue(undefined) };
  const svc = new CheckoutService(
    db as never,
    ordersService as never,
    stripe as never,
    econt as never,
    speedy as never,
    orderConfirmation as never,
    cfg({ STOREFRONT_URL: 'https://shop' }) as never,
  );
  return { svc, db, ordersService, stripe, econt, speedy, orderConfirmation };
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
  it('COD → no Stripe session, payment normalized to cod', async () => {
    const { svc, db, stripe } = build(makeOrder({ paymentMethod: 'online' }), { canCard: true });
    db.limit.mockResolvedValueOnce([{ stripeAccountId: 'acct' }]); // tenant lookup
    const out = await svc.create('slug', dto({ paymentMethod: 'cod' }));
    expect(out.checkoutUrl).toBeNull();
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
    expect(db.update).toHaveBeenCalled(); // online → cod normalization
  });

  it('no-card farm → cash path even when online chosen', async () => {
    const { svc, db, stripe } = build(makeOrder({ paymentMethod: 'online' }), { canCard: false });
    db.limit.mockResolvedValueOnce([{ stripeAccountId: null }]);
    const out = await svc.create('slug', dto({ paymentMethod: 'online' }));
    expect(out.checkoutUrl).toBeNull();
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('card farm + online → opens a Stripe Checkout session', async () => {
    const { svc, db, stripe } = build(makeOrder({ paymentMethod: 'online' }), { canCard: true });
    // Card requires a linked account that can actually charge (onboarding complete).
    db.limit.mockResolvedValueOnce([{ stripeAccountId: 'acct', stripeChargesEnabled: true }]);
    const out = await svc.create('slug', dto({ paymentMethod: 'online' }));
    expect(out.checkoutUrl).toBe('https://stripe/cs');
    expect(stripe.createCheckoutSession).toHaveBeenCalledTimes(1);
    expect(db.update).toHaveBeenCalled(); // persists stripeCheckoutSessionId
  });

  it('linked Stripe but onboarding incomplete (charges off) → cash path, no session', async () => {
    // isEnabledForAccount is true (account linked) but charges_enabled is false, so
    // the farm cannot actually take cards yet — online must fall back to COD.
    const { svc, db, stripe } = build(makeOrder({ paymentMethod: 'online' }), { canCard: true });
    db.limit.mockResolvedValueOnce([{ stripeAccountId: 'acct', stripeChargesEnabled: false }]);
    const out = await svc.create('slug', dto({ paymentMethod: 'online' }));
    expect(out.checkoutUrl).toBeNull();
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
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
    expect(speedyStub.estimateShipping).toHaveBeenCalledWith('t1', { siteId: 100, weightGrams: undefined, codAmountStotinki: 5000 });
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
