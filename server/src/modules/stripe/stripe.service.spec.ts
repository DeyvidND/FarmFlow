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
  const svc = new StripeService({} as never, config, billing, econt, orderEmail, {
    del: jest.fn(),
  } as never);

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
    const svc = new StripeService(db as never, config, billing, econt, orderEmail, {
      del: jest.fn(),
    } as never);
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

// Regression: Stripe delivers platform-account events and connected-account
// events through two separate endpoints with two separate signing secrets. The
// handler must verify against BOTH configured secrets, so a connected-account
// order event (signed with the Connect secret) is still accepted when the account
// secret is tried first and fails.
describe('StripeService webhook — verifies against either configured secret', () => {
  const config = {
    get: (key: string, def?: unknown) =>
      key === 'STRIPE_WEBHOOK_SECRET'
        ? 'whsec_account'
        : key === 'STRIPE_CONNECT_WEBHOOK_SECRET'
          ? 'whsec_connect'
          : key === 'STRIPE_SECRET_KEY'
            ? ''
            : def,
  } as unknown as ConfigService;

  function build() {
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
          limit: () =>
            Promise.resolve(table === tenants ? [{ id: 'tenant-A' }] : [{ id: 'order-1', total: 1000 }]),
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
    const billing = { handleBillingEvent: jest.fn() } as never;
    const econt = { autoCreateForOrder: jest.fn() } as never;
    const orderEmail = { sendForOrder: jest.fn() } as never;
    const svc = new StripeService(db as never, config, billing, econt, orderEmail, {
      del: jest.fn(),
    } as never);
    const tried: string[] = [];
    const event = {
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      account: 'acct_1',
      data: { object: { id: 'pi_1', metadata: { orderId: 'order-1' }, amount_received: 1000 } },
    };
    // Only the Connect secret verifies this connected-account event.
    (svc as unknown as { client: unknown }).client = {
      webhooks: {
        constructEvent: (_raw: unknown, _sig: unknown, secret: string) => {
          tried.push(secret);
          if (secret !== 'whsec_connect') throw new Error('No signatures found matching the expected signature');
          return event;
        },
      },
    };
    return { svc, calls, tried };
  }

  it('falls through to the Connect secret when the account secret does not match', async () => {
    const { svc, calls, tried } = build();
    const res = await svc.handleWebhook(Buffer.from('{}'), 'sig');
    expect(res).toEqual({ received: true });
    expect(tried).toContain('whsec_connect');
    expect(calls.update).toBe(1); // order confirmed
  });
});

// Regression: an abandoned card checkout (session expires unpaid) must cancel the
// still-pending order so its reserved slot is freed — scoped to the account's tenant.
describe('StripeService webhook — checkout.session.expired frees the slot', () => {
  const config = {
    get: (key: string, def?: unknown) =>
      key === 'STRIPE_WEBHOOK_SECRET' ? 'whsec_test' : key === 'STRIPE_SECRET_KEY' ? '' : def,
  } as unknown as ConfigService;

  function build(tenantResult: unknown[]) {
    const calls = { update: 0 };
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: () => Promise.resolve([{ id: 'evt_x' }]) }),
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
          limit: () => Promise.resolve(table === tenants ? tenantResult : []),
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
    const svc = new StripeService(
      db as never,
      config,
      { handleBillingEvent: jest.fn() } as never,
      { autoCreateForOrder: jest.fn() } as never,
      { sendForOrder: jest.fn() } as never,
      { del: jest.fn() } as never,
    );
    const event = {
      id: 'evt_x',
      type: 'checkout.session.expired',
      account: 'acct_farm',
      data: { object: { id: 'cs_1', metadata: { orderId: 'order-1' } } },
    };
    (svc as unknown as { client: unknown }).client = { webhooks: { constructEvent: () => event } };
    return { svc, calls };
  }

  it('cancels the pending order when the account resolves to a tenant', async () => {
    const { svc, calls } = build([{ id: 'tenant-A' }]);
    await svc.handleWebhook(Buffer.from('{}'), 'sig');
    expect(calls.update).toBe(1);
  });

  it('ignores an expired event from an unknown account (no tenant)', async () => {
    const { svc, calls } = build([]);
    await svc.handleWebhook(Buffer.from('{}'), 'sig');
    expect(calls.update).toBe(0);
  });
});

// Regression: the idempotency ledger records the event id BEFORE the handler runs,
// so if a handler throws mid-way (e.g. a transient DB error) the recorded row must
// be released — otherwise Stripe's retry would see the event already recorded and
// no-op, leaving a paid order stuck `pending` forever.
describe('StripeService webhook — releases the idempotency claim when a handler fails', () => {
  const config = {
    get: (key: string, def?: unknown) =>
      key === 'STRIPE_WEBHOOK_SECRET' ? 'whsec_test' : key === 'STRIPE_SECRET_KEY' ? '' : def,
  } as unknown as ConfigService;

  function build() {
    const calls = { deleted: 0 };
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: () => Promise.resolve([{ id: 'evt_fail' }]) }),
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
          limit: () =>
            Promise.resolve(table === tenants ? [{ id: 'tenant-A' }] : [{ id: 'order-1', total: 1000 }]),
        };
        return c;
      },
      // Simulate a transient DB failure inside markOrderPaid's confirm UPDATE.
      update: () => ({
        set: () => ({ where: () => ({ returning: () => Promise.reject(new Error('db down')) }) }),
      }),
      // Compensating delete of the idempotency row.
      delete: () => ({
        where: () => {
          calls.deleted++;
          return Promise.resolve();
        },
      }),
    };
    const svc = new StripeService(
      db as never,
      config,
      { handleBillingEvent: jest.fn() } as never,
      { autoCreateForOrder: jest.fn() } as never,
      { sendForOrder: jest.fn() } as never,
      { del: jest.fn() } as never,
    );
    const event = {
      id: 'evt_fail',
      type: 'payment_intent.succeeded',
      account: 'acct_farm',
      data: { object: { id: 'pi_1', metadata: { orderId: 'order-1' }, amount_received: 1000 } },
    };
    (svc as unknown as { client: unknown }).client = { webhooks: { constructEvent: () => event } };
    return { svc, calls };
  }

  it('deletes the recorded event and rethrows when dispatch throws', async () => {
    const { svc, calls } = build();
    await expect(svc.handleWebhook(Buffer.from('{}'), 'sig')).rejects.toThrow('db down');
    expect(calls.deleted).toBe(1);
  });
});
