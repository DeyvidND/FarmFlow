import { ConfigService } from '@nestjs/config';
import { tenants } from '@farmflow/db';
import { StripeService } from './stripe.service';

// Disabled-safe behaviour: with no STRIPE_SECRET_KEY the service must never
// throw on read paths and must report itself as not configured.
describe('StripeService (Stripe disabled)', () => {
  const config = {
    get: (key: string, def?: unknown) =>
      key === 'STRIPE_SECRET_KEY' || key === 'STRIPE_WEBHOOK_SECRET' ? '' : def,
  } as unknown as ConfigService;
  const billing = { handleBillingEvent: jest.fn() } as never;
  const econt = { autoCreateForOrder: jest.fn() } as never;
  const orderEmail = { sendForOrder: jest.fn() } as never;
  const svc = new StripeService({} as never, config, billing, econt, orderEmail);

  it('reports disabled when no secret key is set', () => {
    expect(svc.isEnabled()).toBe(false);
  });

  it('connectSummary returns a safe disconnected summary without touching the DB', async () => {
    const summary = await svc.connectSummary('tenant-1');
    expect(summary).toEqual({
      enabled: false,
      connected: false,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      availableStotinki: 0,
      pendingStotinki: 0,
      nextPayout: null,
      recentPayments: [],
      feeBps: 0,
    });
  });
});

// Regression: an order webhook must be authorized against the connected account
// that produced it. A farm holding `acct_attacker` (mapped to tenant-A) must not
// be able to confirm an order it does not own by putting a foreign orderId in the
// metadata of a charge on its own account.
describe('StripeService webhook — cross-tenant order authorization', () => {
  const config = {
    get: (key: string, def?: unknown) =>
      key === 'STRIPE_WEBHOOK_SECRET' ? 'whsec_test' : key === 'STRIPE_SECRET_KEY' ? '' : def,
  } as unknown as ConfigService;

  /** Minimal chainable Drizzle stub. `ordersResult` is what the order lookup
   *  (select … from(orders)) resolves to; the tenant lookup always maps the
   *  account to `tenant-A`. Records whether orders.update() ran. */
  function makeDb(ordersResult: unknown[]) {
    const calls = { update: 0 };
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: () => Promise.resolve([{ id: 'evt_1' }]) }),
        }),
      }),
      select: () => {
        let table: unknown;
        const c: Record<string, unknown> = {
          from: (t: unknown) => {
            table = t;
            return c;
          },
          where: () => c,
          limit: () => Promise.resolve(table === tenants ? [{ id: 'tenant-A' }] : ordersResult),
        };
        return c;
      },
      update: () => {
        calls.update++;
        return {
          set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 'o' }]) }) }),
        };
      },
    };
    return { db, calls };
  }

  function build(ordersResult: unknown[]) {
    const { db, calls } = makeDb(ordersResult);
    const billing = { handleBillingEvent: jest.fn() } as never;
    const econt = { autoCreateForOrder: jest.fn() } as never;
    const orderEmail = { sendForOrder: jest.fn() } as never;
    const svc = new StripeService(db as never, config, billing, econt, orderEmail);
    // The constructor leaves client=null with no secret key; inject a stub whose
    // constructEvent returns a forged-but-"signed" payment_intent.succeeded for a
    // victim order, originating on the attacker's account.
    const event = {
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      account: 'acct_attacker',
      data: { object: { id: 'pi_1', metadata: { orderId: 'victim-order' }, amount_received: 1000 } },
    };
    (svc as unknown as { client: unknown }).client = {
      webhooks: { constructEvent: () => event },
    };
    return { svc, calls, econt };
  }

  it('ignores an order event whose orderId is not owned by the account’s tenant', async () => {
    // Order lookup scoped to tenant-A returns nothing → victim order belongs to
    // another tenant → no confirmation, no side effects.
    const { svc, calls, econt } = build([]);
    await svc.handleWebhook(Buffer.from('{}'), 'sig');
    expect(calls.update).toBe(0);
    expect((econt as unknown as { autoCreateForOrder: jest.Mock }).autoCreateForOrder).not
      .toHaveBeenCalled();
  });

  it('confirms when the order belongs to the account’s tenant and the amount covers the total', async () => {
    const { svc, calls, econt } = build([{ id: 'victim-order', total: 1000 }]);
    await svc.handleWebhook(Buffer.from('{}'), 'sig');
    expect(calls.update).toBe(1);
    expect((econt as unknown as { autoCreateForOrder: jest.Mock }).autoCreateForOrder)
      .toHaveBeenCalledWith('victim-order');
  });

  it('does not confirm an under-payment even for the owning tenant', async () => {
    // Order total 5000 but only 1000 collected → must not confirm.
    const { svc, calls } = build([{ id: 'victim-order', total: 5000 }]);
    await svc.handleWebhook(Buffer.from('{}'), 'sig');
    expect(calls.update).toBe(0);
  });
});
