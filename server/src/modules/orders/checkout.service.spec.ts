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

function build(order: any, opts: { canCard?: boolean } = {}) {
  const db = makeDb();
  const ordersService = { create: jest.fn().mockResolvedValue(order) };
  const stripe = {
    isEnabledForAccount: jest.fn().mockReturnValue(opts.canCard ?? false),
    createCheckoutSession: jest
      .fn()
      .mockResolvedValue({ checkoutUrl: 'https://stripe/cs', checkoutSessionId: 'cs_1' }),
  };
  const econt = { estimateShipping: jest.fn().mockResolvedValue(null) };
  const svc = new CheckoutService(
    db as never,
    ordersService as never,
    stripe as never,
    econt as never,
    cfg({ STOREFRONT_URL: 'https://shop' }) as never,
  );
  return { svc, db, ordersService, stripe, econt };
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
    db.limit.mockResolvedValueOnce([{ stripeAccountId: 'acct' }]);
    const out = await svc.create('slug', dto({ paymentMethod: 'online' }));
    expect(out.checkoutUrl).toBe('https://stripe/cs');
    expect(stripe.createCheckoutSession).toHaveBeenCalledTimes(1);
    expect(db.update).toHaveBeenCalled(); // persists stripeCheckoutSessionId
  });
});
